import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import type { ChatConfig, TelegramAccountConfig } from "./core/config-types.js";
import { telegramFetch } from "./telegram-http.js";
import { matchesTelegramTarget, resolveTelegramTarget, type TelegramTarget } from "./telegram-target.js";
import type { TelegramUpdate } from "./telegram-updates.js";

interface TelegramResponse<T> {
	ok: boolean;
	result?: T;
	description?: string;
}

interface BrokerState {
	initialized: boolean;
	nextOffset: number;
}

interface BrokerRoute {
	conversationId: string;
	target: TelegramTarget;
	group: BotGroup;
}

interface Subscription {
	conversationId: string;
	socket: Socket;
	cursor: number;
	pendingAck?: { updateId: number; resolve(): void; reject(error: Error): void };
	readyPromise?: Promise<void>;
	resolveReady?: () => void;
	rejectReady?: (error: Error) => void;
	caughtUp: boolean;
}

interface BotGroup {
	botToken: string;
	statePath: string;
	routes: BrokerRoute[];
	armed: boolean;
}

interface BrokerOptions {
	config: ChatConfig;
	socketPath: string;
	stateDir: string;
	fetch?: typeof fetch;
	requestTimeoutMs?: number;
	retryDelayMs?: number;
}

class TelegramBrokerRequestError extends Error {}

export interface RunningTelegramBroker {
	done: Promise<void>;
	close(): Promise<void>;
}

function updateMessage(update: TelegramUpdate) {
	return update.message || update.edited_message;
}

function parseCursor(value: unknown): number {
	if (value === undefined || value === null || value === "") return 0;
	if (typeof value !== "string" || !/^[0-9]+$/.test(value) || !Number.isSafeInteger(Number(value))) {
		throw new Error("Invalid Telegram broker cursor");
	}
	return Number(value);
}

function stateKey(account: TelegramAccountConfig): string {
	if (account.botUserId && /^[0-9]+$/.test(account.botUserId)) return account.botUserId;
	return createHash("sha256").update(account.botToken).digest("hex").slice(0, 24);
}

async function readState(path: string): Promise<BrokerState> {
	try {
		const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<BrokerState>;
		if (
			typeof parsed.initialized !== "boolean" ||
			typeof parsed.nextOffset !== "number" ||
			!Number.isSafeInteger(parsed.nextOffset) ||
			parsed.nextOffset < 0
		) {
			throw new Error("invalid state");
		}
		return { initialized: parsed.initialized, nextOffset: parsed.nextOffset };
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
			return { initialized: false, nextOffset: 0 };
		}
		throw new Error(`Invalid Telegram broker state: ${path}`);
	}
}

async function writeState(path: string, state: BrokerState): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.tmp`;
	await writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
	await chmod(temporary, 0o600);
	await rename(temporary, path);
}

function routesOverlap(first: TelegramTarget, second: TelegramTarget): boolean {
	if (first.chatId !== second.chatId) return false;
	return first.threadId === undefined || second.threadId === undefined || first.threadId === second.threadId;
}

function buildGroups(config: ChatConfig, stateDir: string): BotGroup[] {
	const groupsByToken = new Map<string, BotGroup>();
	for (const [accountId, rawAccount] of Object.entries(config.accounts)) {
		if (rawAccount.service !== "telegram") continue;
		const account = rawAccount as TelegramAccountConfig;
		let group = groupsByToken.get(account.botToken);
		if (!group) {
			group = {
				botToken: account.botToken,
				statePath: join(stateDir, `${stateKey(account)}.json`),
				routes: [],
				armed: false,
			};
			groupsByToken.set(account.botToken, group);
		}
		for (const [channelKey, channel] of Object.entries(account.channels ?? {})) {
			const route: BrokerRoute = {
				conversationId: `${accountId}/${channelKey}`,
				target: resolveTelegramTarget(channel),
				group,
			};
			const overlapping = group.routes.find((existing) => routesOverlap(existing.target, route.target));
			if (overlapping) {
				throw new Error(`Telegram broker targets overlap: ${overlapping.conversationId} and ${route.conversationId}`);
			}
			group.routes.push(route);
		}
	}
	return [...groupsByToken.values()].filter((group) => group.routes.length > 0);
}

async function callGetUpdates(
	group: BotGroup,
	offset: number,
	timeout: number,
	fetchFn: typeof fetch,
	signal: AbortSignal,
	requestTimeoutMs?: number,
): Promise<TelegramUpdate[]> {
	let response: Response;
	try {
		response = await fetchFn(`https://api.telegram.org/bot${group.botToken}/getUpdates`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				offset: offset > 0 ? offset : undefined,
				timeout,
				allowed_updates: ["message", "edited_message"],
			}),
			signal: AbortSignal.any([
				signal,
				AbortSignal.timeout(requestTimeoutMs ?? Math.max(15_000, (timeout + 15) * 1000)),
			]),
		});
	} catch {
		if (signal.aborted) throw signal.reason;
		throw new TelegramBrokerRequestError("Telegram broker request failed");
	}
	const data = (await response.json()) as TelegramResponse<TelegramUpdate[]>;
	if (!response.ok || !data.ok || !Array.isArray(data.result)) {
		throw new Error(data.description || "Telegram broker getUpdates failed");
	}
	return data.result;
}

export async function startTelegramBroker(options: BrokerOptions): Promise<RunningTelegramBroker> {
	const groups = buildGroups(options.config, options.stateDir);
	if (groups.length === 0) throw new Error("Telegram broker has no configured channels");
	const routes = new Map(groups.flatMap((group) => group.routes.map((route) => [route.conversationId, route])));
	const subscriptions = new Map<string, Subscription>();
	const subscriberWaiters = new Map<string, Array<() => void>>();
	const sockets = new Set<Socket>();
	const controller = new AbortController();
	let closing = false;

	const notifySubscriber = (conversationId: string) => {
		for (const resolveWaiter of subscriberWaiters.get(conversationId) ?? []) resolveWaiter();
		subscriberWaiters.delete(conversationId);
	};
	const waitForSubscriber = async (conversationId: string): Promise<Subscription> => {
		while (!closing) {
			const subscription = subscriptions.get(conversationId);
			if (subscription) return subscription;
			await new Promise<void>((resolveWaiter) => {
				const waiters = subscriberWaiters.get(conversationId) ?? [];
				waiters.push(resolveWaiter);
				subscriberWaiters.set(conversationId, waiters);
			});
		}
		throw new Error("Telegram broker is closing");
	};
	const ensureCaughtUp = async (conversationId: string): Promise<Subscription> => {
		while (!closing) {
			const subscription = await waitForSubscriber(conversationId);
			if (subscription.caughtUp) return subscription;
			if (!subscription.readyPromise) {
				subscription.readyPromise = new Promise<void>((resolveReady, rejectReady) => {
					subscription.resolveReady = resolveReady;
					subscription.rejectReady = rejectReady;
				});
				subscription.socket.write(`${JSON.stringify({ type: "caught_up" })}\n`);
			}
			try {
				await subscription.readyPromise;
				return subscription;
			} catch {
				// ponytail: reconnect and retry globally; add per-channel queues only if availability requires it.
			}
		}
		throw new Error("Telegram broker is closing");
	};
	const deliver = async (route: BrokerRoute, update: TelegramUpdate): Promise<void> => {
		while (!closing) {
			let subscription = await waitForSubscriber(route.conversationId);
			if (route.group.armed) subscription = await ensureCaughtUp(route.conversationId);
			if (subscription.cursor >= update.update_id) return;
			try {
				await new Promise<void>((resolveAck, rejectAck) => {
					subscription.pendingAck = {
						updateId: update.update_id,
						resolve: resolveAck,
						reject: rejectAck,
					};
					subscription.socket.write(`${JSON.stringify({ type: "update", update })}\n`);
				});
				return;
			} catch {
				// The worker cursor lets a replacement subscription acknowledge an already persisted update.
			}
		}
		throw new Error("Telegram broker is closing");
	};
	const routeUpdate = async (group: BotGroup, update: TelegramUpdate): Promise<void> => {
		const message = updateMessage(update);
		if (!message) return;
		const matched = group.routes.filter((route) => matchesTelegramTarget(route.target, message));
		await Promise.all(matched.map((route) => deliver(route, update)));
	};

	const server: Server = createServer((socket) => {
		sockets.add(socket);
		socket.setEncoding("utf8");
		let buffer = "";
		let subscription: Subscription | undefined;
		const sendError = (message: string) => {
			socket.end(`${JSON.stringify({ type: "error", message })}\n`);
		};
		const handle = (value: unknown) => {
			if (!value || typeof value !== "object") throw new Error("Invalid Telegram broker request");
			const message = value as Record<string, unknown>;
			if (message.type === "subscribe") {
				if (subscription) throw new Error("Telegram broker subscription already exists");
				if (typeof message.conversationId !== "string" || !routes.has(message.conversationId)) {
					throw new Error("Unknown Telegram broker conversation");
				}
				const existing = subscriptions.get(message.conversationId);
				if (existing) existing.socket.destroy();
				subscription = {
					conversationId: message.conversationId,
					socket,
					cursor: parseCursor(message.cursor),
					caughtUp: false,
				};
				subscriptions.set(message.conversationId, subscription);
				notifySubscriber(message.conversationId);
				const route = routes.get(message.conversationId);
				if (route?.group.armed) void ensureCaughtUp(message.conversationId).catch(() => undefined);
				return;
			}
			if (!subscription) throw new Error("Telegram broker subscription is required");
			if (message.type === "ready") {
				subscription.caughtUp = true;
				subscription.resolveReady?.();
				subscription.resolveReady = undefined;
				subscription.rejectReady = undefined;
				return;
			}
			if (message.type === "ack") {
				const updateId = message.updateId;
				if (typeof updateId !== "number" || subscription.pendingAck?.updateId !== updateId) {
					throw new Error("Unexpected Telegram broker acknowledgement");
				}
				subscription.cursor = updateId;
				const pending = subscription.pendingAck;
				subscription.pendingAck = undefined;
				pending.resolve();
				return;
			}
			throw new Error("Invalid Telegram broker request type");
		};
		socket.on("data", (chunk) => {
			buffer += chunk;
			while (true) {
				const newline = buffer.indexOf("\n");
				if (newline < 0) break;
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				if (!line.trim()) continue;
				try {
					handle(JSON.parse(line));
				} catch (error) {
					sendError(error instanceof Error ? error.message : String(error));
					return;
				}
			}
		});
		const remove = () => {
			sockets.delete(socket);
			if (!subscription) return;
			const error = new Error("Telegram broker worker disconnected");
			subscription.pendingAck?.reject(error);
			subscription.rejectReady?.(error);
			if (subscriptions.get(subscription.conversationId) === subscription) {
				subscriptions.delete(subscription.conversationId);
				notifySubscriber(subscription.conversationId);
			}
		};
		socket.on("close", remove);
		socket.on("error", () => undefined);
	});

	await mkdir(dirname(options.socketPath), { recursive: true });
	await unlink(options.socketPath).catch((error) => {
		if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error;
	});
	await new Promise<void>((resolveListen, rejectListen) => {
		server.once("error", rejectListen);
		server.listen(options.socketPath, () => {
			server.off("error", rejectListen);
			resolveListen();
		});
	});
	await chmod(options.socketPath, 0o600);

	const fetchFn = options.fetch ?? telegramFetch;
	const poll = async (group: BotGroup, offset: number, timeout: number): Promise<TelegramUpdate[]> => {
		let retryDelayMs = options.retryDelayMs ?? 1000;
		while (!closing) {
			try {
				return await callGetUpdates(group, offset, timeout, fetchFn, controller.signal, options.requestTimeoutMs);
			} catch (error) {
				if (!(error instanceof TelegramBrokerRequestError)) throw error;
				console.error("Telegram broker request failed; retrying");
				await delay(retryDelayMs, undefined, { signal: controller.signal });
				retryDelayMs = Math.min(retryDelayMs * 2, 30_000);
			}
		}
		throw new DOMException("Telegram broker is closing", "AbortError");
	};
	const runGroup = async (group: BotGroup) => {
		await Promise.all(group.routes.map((route) => waitForSubscriber(route.conversationId)));
		const state = await readState(group.statePath);
		if (state.initialized) {
			group.armed = true;
			await Promise.all(group.routes.map((route) => ensureCaughtUp(route.conversationId)));
		} else {
			while (!closing) {
				const updates = await poll(group, state.nextOffset, 0);
				if (updates.length === 0) break;
				for (const update of updates) {
					await routeUpdate(group, update);
					state.nextOffset = update.update_id + 1;
					await writeState(group.statePath, state);
				}
			}
			state.initialized = true;
			await writeState(group.statePath, state);
			group.armed = true;
			await Promise.all(group.routes.map((route) => ensureCaughtUp(route.conversationId)));
		}
		while (!closing) {
			const updates = await poll(group, state.nextOffset, 30);
			for (const update of updates) {
				await routeUpdate(group, update);
				state.nextOffset = update.update_id + 1;
				await writeState(group.statePath, state);
			}
		}
	};
	const done = Promise.all(groups.map((group) => runGroup(group))).then(() => undefined);

	return {
		done,
		close: async () => {
			if (closing) return;
			closing = true;
			controller.abort();
			for (const resolveWaiters of subscriberWaiters.values()) {
				for (const resolveWaiter of resolveWaiters) resolveWaiter();
			}
			for (const socket of sockets) socket.destroy();
			await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
			await done.catch((error) => {
				if (!(error instanceof Error && error.name === "AbortError")) throw error;
			});
			await unlink(options.socketPath).catch(() => undefined);
		},
	};
}

async function main(): Promise<void> {
	const configPath =
		process.env.PI_CHAT_CONFIG_OUTPUT ?? resolve(process.env.HOME ?? ".", ".pi/agent/chat/config.json");
	const config = JSON.parse(await readFile(configPath, "utf8")) as ChatConfig;
	const broker = await startTelegramBroker({
		config,
		socketPath: process.env.PI_CHAT_TELEGRAM_BROKER_SOCKET ?? "/run/pi-chat/telegram.sock",
		stateDir:
			process.env.PI_CHAT_TELEGRAM_BROKER_STATE_DIR ??
			resolve(process.env.HOME ?? ".", ".pi/agent/chat/telegram-broker"),
	});
	const shutdown = () => void broker.close();
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
	await broker.done;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	await main();
}
