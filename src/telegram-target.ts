import type { ConfiguredChannel } from "./core/config-types.js";

export interface TelegramTarget {
	chatId: string;
	threadId?: number;
}

export interface TelegramTargetMessage {
	chat: { id: number };
	message_thread_id?: number;
}

export function resolveTelegramTarget(channel: Pick<ConfiguredChannel, "id" | "telegramThreadId">): TelegramTarget {
	const value = channel.telegramThreadId;
	if (value === undefined) return { chatId: channel.id };
	if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) {
		throw new Error("telegramThreadId must be a positive safe integer");
	}
	return { chatId: channel.id, threadId: Number(value) };
}

export function matchesTelegramTarget(target: TelegramTarget, message: TelegramTargetMessage): boolean {
	if (String(message.chat.id) !== target.chatId) return false;
	if (target.threadId === undefined) return true;
	if (message.message_thread_id === undefined) return target.threadId === 1;
	return message.message_thread_id === target.threadId;
}

export function withTelegramThread<T extends Record<string, unknown>>(
	target: TelegramTarget,
	body: T,
): T & { message_thread_id?: number } {
	if (target.threadId === undefined || target.threadId === 1) return body;
	return { ...body, message_thread_id: target.threadId };
}

export function setTelegramThreadFormField(target: TelegramTarget, form: FormData): void {
	if (target.threadId !== undefined && target.threadId !== 1) form.set("message_thread_id", String(target.threadId));
}
