import type { ResolvedConversation, TelegramAccountConfig } from "../core/config-types.js";
import type { InboundMessageInput } from "../core/runtime-types.js";
import { chunkText } from "../render/chunking.js";
import { formatMarkdownForService, maxMessageLength } from "../render/format.js";
import { StreamingPreview } from "../render/streaming.js";
import { subscribeTelegramBroker } from "../telegram-broker-client.js";
import { telegramFetch } from "../telegram-http.js";
import type { TelegramTarget } from "../telegram-target.js";
import {
	matchesTelegramTarget,
	resolveTelegramTarget,
	setTelegramThreadFormField,
	withTelegramThread,
} from "../telegram-target.js";
import type { TelegramMessage, TelegramUpdate } from "../telegram-updates.js";
import {
	fetchBinary,
	guessAttachmentKind,
	readLocalAttachment,
	storeDownloadedAttachment,
	textMentionsBot,
} from "./common.js";
import type { LiveConnection, LiveConnectionHandlers, ResumeState } from "./types.js";

interface TelegramResponse<T> {
	ok: boolean;
	result?: T;
	description?: string;
}
interface TelegramGetFileResult {
	file_path: string;
}

async function callTelegram<T>(
	botToken: string,
	method: string,
	body: Record<string, unknown>,
	options?: { signal?: AbortSignal },
): Promise<T> {
	const response = await telegramFetch(`https://api.telegram.org/bot${botToken}/${method}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
		signal: options?.signal,
	});
	const data = (await response.json()) as TelegramResponse<T>;
	if (!response.ok || !data.ok || data.result === undefined)
		throw new Error(data.description || `Telegram API ${method} failed`);
	return data.result;
}

async function callTelegramWithMarkdownFallback<T>(
	botToken: string,
	method: string,
	body: Record<string, unknown>,
	options?: { signal?: AbortSignal },
): Promise<T> {
	try {
		return await callTelegram<T>(botToken, method, body, options);
	} catch (error) {
		if (body.parse_mode !== "Markdown" || !(error instanceof Error) || !/can't parse entities/i.test(error.message)) {
			throw error;
		}
		const { parse_mode: _parseMode, ...plainTextBody } = body;
		return callTelegram<T>(botToken, method, plainTextBody, options);
	}
}

interface TelegramUpdateSubscriber {
	deliver(update: TelegramUpdate): Promise<void>;
	onCaughtUp(): Promise<void>;
	onError(error: Error): Promise<void>;
}

interface TelegramSubscriberRecord {
	subscriber: TelegramUpdateSubscriber;
	active: boolean;
	queued: TelegramUpdate[];
}

interface PendingSubscriber {
	resolve(): void;
	reject(error: unknown): void;
}

const telegramPollers = new Map<string, TelegramUpdatePoller>();

class TelegramUpdatePoller {
	private readonly subscribers = new Set<TelegramSubscriberRecord>();
	private readonly pending = new Map<TelegramSubscriberRecord, PendingSubscriber>();
	private readonly controller = new AbortController();
	private offset = 0;
	private started = false;
	private ready = false;
	private stopped = false;
	private runPromise?: Promise<void>;

	constructor(private readonly botToken: string) {}

	async subscribe(subscriber: TelegramUpdateSubscriber): Promise<() => Promise<void>> {
		if (this.stopped) throw new Error("Telegram update poller is stopped");
		const record: TelegramSubscriberRecord = { subscriber, active: false, queued: [] };
		this.subscribers.add(record);
		const ready = new Promise<void>((resolve, reject) => this.pending.set(record, { resolve, reject }));
		if (!this.started) {
			this.started = true;
			this.runPromise = this.run();
			void this.runPromise;
		} else if (this.ready) {
			void this.activate(record);
		}
		await ready;
		return async () => this.unsubscribe(record);
	}

	private async activate(record: TelegramSubscriberRecord): Promise<void> {
		const pending = this.pending.get(record);
		if (!pending || !this.subscribers.has(record)) return;
		try {
			await record.subscriber.onCaughtUp();
			while (record.queued.length > 0) {
				const update = record.queued.shift();
				if (update) await this.deliver(record, update);
			}
			record.active = true;
			this.pending.delete(record);
			pending.resolve();
		} catch (error) {
			this.pending.delete(record);
			this.subscribers.delete(record);
			pending.reject(error);
		}
	}

	private async deliver(record: TelegramSubscriberRecord, update: TelegramUpdate): Promise<void> {
		try {
			await record.subscriber.deliver(update);
		} catch (error) {
			await record.subscriber.onError(error instanceof Error ? error : new Error(String(error))).catch(() => undefined);
		}
	}

	private async dispatch(update: TelegramUpdate): Promise<void> {
		await Promise.all(
			[...this.subscribers].map(async (record) => {
				if (!record.active) {
					record.queued.push(update);
					return;
				}
				await this.deliver(record, update);
			}),
		);
	}

	private async run(): Promise<void> {
		try {
			const initialUpdates = await callTelegram<TelegramUpdate[]>(this.botToken, "getUpdates", {
				offset: undefined,
				timeout: 0,
				allowed_updates: ["message", "edited_message"],
			});
			for (const update of initialUpdates) {
				this.offset = update.update_id + 1;
				await this.dispatch(update);
			}
			this.ready = true;
			await Promise.all([...this.subscribers].map((record) => this.activate(record)));
			while (!this.stopped) {
				const updates = await callTelegram<TelegramUpdate[]>(
					this.botToken,
					"getUpdates",
					{
						offset: this.offset > 0 ? this.offset : undefined,
						timeout: 30,
						allowed_updates: ["message", "edited_message"],
					},
					{ signal: this.controller.signal },
				);
				for (const update of updates) {
					this.offset = update.update_id + 1;
					await this.dispatch(update);
				}
			}
		} catch (error) {
			if (this.stopped || (error instanceof DOMException && error.name === "AbortError")) return;
			const normalized = error instanceof Error ? error : new Error(String(error));
			for (const pending of this.pending.values()) pending.reject(normalized);
			await Promise.all(
				[...this.subscribers].map((record) => record.subscriber.onError(normalized).catch(() => undefined)),
			);
		} finally {
			if (telegramPollers.get(this.botToken) === this) telegramPollers.delete(this.botToken);
		}
	}

	private async unsubscribe(record: TelegramSubscriberRecord): Promise<void> {
		this.subscribers.delete(record);
		this.pending.delete(record);
		record.queued = [];
		if (this.subscribers.size !== 0) return;
		this.stopped = true;
		if (telegramPollers.get(this.botToken) === this) telegramPollers.delete(this.botToken);
		this.controller.abort();
		await this.runPromise?.catch(() => undefined);
	}
}

function getTelegramPoller(botToken: string): TelegramUpdatePoller {
	const existing = telegramPollers.get(botToken);
	if (existing) return existing;
	const poller = new TelegramUpdatePoller(botToken);
	telegramPollers.set(botToken, poller);
	return poller;
}

async function downloadTelegramFile(
	conversation: ResolvedConversation,
	botToken: string,
	messageId: string,
	index: number,
	fileId: string,
	fileName: string,
	mimeType?: string,
) {
	const info = await callTelegram<TelegramGetFileResult>(botToken, "getFile", { file_id: fileId });
	const data = await fetchBinary(
		`https://api.telegram.org/file/bot${botToken}/${info.file_path}`,
		undefined,
		telegramFetch,
	);
	return [await storeDownloadedAttachment(conversation, messageId, index, fileName, data, mimeType, info.file_path)];
}

async function messageToInput(
	conversation: ResolvedConversation,
	account: TelegramAccountConfig,
	target: TelegramTarget,
	message: TelegramMessage,
) {
	if (!matchesTelegramTarget(target, message)) return undefined;
	if (account.botUserId && String(message.from?.id ?? "") === account.botUserId) return undefined;
	const text = (message.text || message.caption || "").trim();
	const attachments: NonNullable<InboundMessageInput["attachments"]> = [];
	const remoteMessageId = String(message.message_id);
	if (message.photo?.length) {
		const largest = [...message.photo].sort((a, b) => (a.file_size ?? 0) - (b.file_size ?? 0)).pop();
		if (largest)
			attachments.push(
				...(await downloadTelegramFile(
					conversation,
					account.botToken,
					remoteMessageId,
					1,
					largest.file_id,
					`photo-${remoteMessageId}.jpg`,
					"image/jpeg",
				)),
			);
	}
	if (message.document)
		attachments.push(
			...(await downloadTelegramFile(
				conversation,
				account.botToken,
				remoteMessageId,
				2,
				message.document.file_id,
				message.document.file_name || `document-${remoteMessageId}`,
				message.document.mime_type,
			)),
		);
	if (message.video)
		attachments.push(
			...(await downloadTelegramFile(
				conversation,
				account.botToken,
				remoteMessageId,
				3,
				message.video.file_id,
				message.video.file_name || `video-${remoteMessageId}.mp4`,
				message.video.mime_type,
			)),
		);
	if (message.audio)
		attachments.push(
			...(await downloadTelegramFile(
				conversation,
				account.botToken,
				remoteMessageId,
				4,
				message.audio.file_id,
				message.audio.file_name || `audio-${remoteMessageId}.mp3`,
				message.audio.mime_type,
			)),
		);
	return {
		messageId: remoteMessageId,
		userId: String(message.from?.id ?? message.chat.id),
		userName: message.from?.username || message.from?.first_name,
		text,
		mentionedBot: textMentionsBot(text, account.botUsername),
		isBot: message.from?.is_bot ?? false,
		attachments,
	};
}

export async function connectTelegramLive(
	conversation: ResolvedConversation,
	handlers: LiveConnectionHandlers,
	resumeState?: ResumeState,
): Promise<LiveConnection> {
	const account = conversation.account as TelegramAccountConfig;
	const target = resolveTelegramTarget(conversation.channel);
	const threadBody = <T extends Record<string, unknown>>(body: T) => withTelegramThread(target, body);
	const preview = new StreamingPreview(conversation.service, {
		create: async (text, parseMode, replyToMessageId) =>
			String(
				(
					await callTelegramWithMarkdownFallback<{ message_id: number }>(
						account.botToken,
						"sendMessage",
						threadBody({
							chat_id: Number(conversation.channel.id),
							text,
							parse_mode: parseMode,
							reply_to_message_id: replyToMessageId ? Number(replyToMessageId) : undefined,
						}),
					)
				).message_id,
			),
		edit: async (id, text, parseMode) => {
			try {
				await callTelegramWithMarkdownFallback(account.botToken, "editMessageText", {
					chat_id: Number(conversation.channel.id),
					message_id: Number(id),
					text,
					parse_mode: parseMode,
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (!message.toLowerCase().includes("message is not modified")) throw error;
			}
		},
		delete: async (id) => {
			await callTelegram(account.botToken, "deleteMessage", {
				chat_id: Number(conversation.channel.id),
				message_id: Number(id),
			});
		},
	});
	const mediaGroups = new Map<string, { updates: TelegramUpdate[]; timer?: ReturnType<typeof setTimeout> }>();
	const mergeMediaGroup = (updates: TelegramUpdate[]): TelegramMessage | undefined => {
		const messages = updates
			.map((update) => update.message || update.edited_message)
			.filter(Boolean) as TelegramMessage[];
		if (messages.length === 0) return undefined;
		const merged = { ...messages[0] } as TelegramMessage;
		for (const message of messages.slice(1)) {
			if (!merged.text && message.text) merged.text = message.text;
			if (!merged.caption && message.caption) merged.caption = message.caption;
			if (message.photo?.length) merged.photo = [...(merged.photo ?? []), ...message.photo];
			if (!merged.document && message.document) merged.document = message.document;
			if (!merged.video && message.video) merged.video = message.video;
			if (!merged.audio && message.audio) merged.audio = message.audio;
		}
		return merged;
	};
	const flushMediaGroup = async (key: string): Promise<void> => {
		const state = mediaGroups.get(key);
		mediaGroups.delete(key);
		if (!state) return;
		const merged = mergeMediaGroup(state.updates);
		if (!merged) return;
		const input = await messageToInput(conversation, account, target, merged);
		if (!input) return;
		const lastUpdateId = state.updates.at(-1)?.update_id;
		await handlers.onMessage(input, {
			cursor: lastUpdateId !== undefined ? String(lastUpdateId) : undefined,
			messageId: input.messageId,
		});
	};
	const deliverUpdate = async (update: TelegramUpdate): Promise<void> => {
		const message = update.message || update.edited_message;
		if (!message) return;
		if (message.media_group_id) {
			const key = `${message.chat.id}:${message.message_thread_id ?? ""}:${message.media_group_id}`;
			const existing = mediaGroups.get(key) ?? { updates: [] };
			existing.updates.push(update);
			if (existing.timer) clearTimeout(existing.timer);
			existing.timer = setTimeout(() => {
				void flushMediaGroup(key).catch(
					(error) => void handlers.onError(error instanceof Error ? error : new Error(String(error))),
				);
			}, 1200);
			mediaGroups.set(key, existing);
			return;
		}
		const input = await messageToInput(conversation, account, target, message);
		if (input) await handlers.onMessage(input, { cursor: String(update.update_id), messageId: input.messageId });
	};
	const subscriber = {
		deliver: deliverUpdate,
		onCaughtUp: handlers.onCaughtUp,
		onError: handlers.onError,
		onDisconnect: handlers.onDisconnect,
	};
	const brokerSocket = process.env.PI_CHAT_TELEGRAM_BROKER_SOCKET?.trim();
	const unsubscribe = brokerSocket
		? await subscribeTelegramBroker(brokerSocket, conversation.conversationId, resumeState?.cursor, subscriber)
		: await getTelegramPoller(account.botToken).subscribe(subscriber);
	return {
		conversation,
		disconnect: async () => {
			for (const state of mediaGroups.values()) if (state.timer) clearTimeout(state.timer);
			await unsubscribe();
		},
		sendImmediate: async (text, replyToMessageId) =>
			String(
				(
					await callTelegram<{ message_id: number }>(
						account.botToken,
						"sendMessage",
						threadBody({
							chat_id: Number(conversation.channel.id),
							text,
							reply_to_message_id: replyToMessageId ? Number(replyToMessageId) : undefined,
						}),
					)
				).message_id,
			),
		send: async (text, attachmentPaths = [], signal, replyToMessageId) => {
			const rendered = formatMarkdownForService("telegram", text);
			const replyParam = replyToMessageId ? { reply_to_message_id: Number(replyToMessageId) } : {};
			if (attachmentPaths.length === 0) {
				const chunks = chunkText(rendered.text, maxMessageLength("telegram"));
				let firstId: string | undefined;
				for (let i = 0; i < chunks.length; i++) {
					const id = String(
						(
							await callTelegramWithMarkdownFallback<{ message_id: number }>(
								account.botToken,
								"sendMessage",
								threadBody({
									chat_id: Number(conversation.channel.id),
									text: chunks[i],
									parse_mode: rendered.parseMode,
									...(i === 0 ? replyParam : {}),
								}),
								{ signal },
							)
						).message_id,
					);
					firstId ??= id;
				}
				return firstId || "";
			}
			const [firstPath, ...rest] = attachmentPaths;
			const first = await readLocalAttachment(firstPath);
			const firstKind = guessAttachmentKind(first.name, first.mimeType);
			const firstMethod = firstKind === "image" ? "sendPhoto" : "sendDocument";
			const firstField = firstKind === "image" ? "photo" : "document";
			const firstForm = new FormData();
			firstForm.set("chat_id", String(Number(conversation.channel.id)));
			setTelegramThreadFormField(target, firstForm);
			if (replyToMessageId) firstForm.set("reply_to_message_id", String(Number(replyToMessageId)));
			if (text) firstForm.set("caption", text);
			if (text && firstKind === "image") firstForm.set("parse_mode", "Markdown");
			firstForm.set(firstField, new Blob([Buffer.from(first.data)], { type: first.mimeType }), first.name);
			const firstResponse = await telegramFetch(`https://api.telegram.org/bot${account.botToken}/${firstMethod}`, {
				method: "POST",
				body: firstForm,
				signal,
			});
			const firstData = (await firstResponse.json()) as TelegramResponse<{ message_id: number }>;
			if (!firstResponse.ok || !firstData.ok || firstData.result === undefined)
				throw new Error(firstData.description || `${firstMethod} failed`);
			for (const path of rest) {
				const file = await readLocalAttachment(path);
				const kind = guessAttachmentKind(file.name, file.mimeType);
				const method = kind === "image" ? "sendPhoto" : "sendDocument";
				const field = kind === "image" ? "photo" : "document";
				const form = new FormData();
				form.set("chat_id", String(Number(conversation.channel.id)));
				setTelegramThreadFormField(target, form);
				form.set(field, new Blob([Buffer.from(file.data)], { type: file.mimeType }), file.name);
				const response = await telegramFetch(`https://api.telegram.org/bot${account.botToken}/${method}`, {
					method: "POST",
					body: form,
					signal,
				});
				const data = (await response.json()) as TelegramResponse<{ message_id: number }>;
				if (!response.ok || !data.ok || data.result === undefined)
					throw new Error(data.description || `${method} failed`);
			}
			return String(firstData.result.message_id);
		},
		startTyping: async () => {
			await callTelegram(
				account.botToken,
				"sendChatAction",
				threadBody({
					chat_id: Number(conversation.channel.id),
					action: "typing",
				}),
			);
		},
		stopTyping: async () => {},
		syncPreview: async (markdown, done = false) => preview.update(markdown, done),
		clearPreview: async () => preview.clear(),
		setReplyTo: (messageId) => preview.setReplyTo(messageId),
	};
}
