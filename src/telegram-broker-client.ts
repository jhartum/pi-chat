import { createConnection } from "node:net";

import type { TelegramUpdate } from "./telegram-updates.js";

interface BrokerSubscriber {
	deliver(update: TelegramUpdate): Promise<void>;
	onCaughtUp(): Promise<void>;
	onError(error: Error): Promise<void>;
	onDisconnect?(): Promise<void>;
}

interface BrokerMessage {
	type?: string;
	update?: TelegramUpdate;
	message?: string;
}

export async function subscribeTelegramBroker(
	socketPath: string,
	conversationId: string,
	cursor: string | undefined,
	subscriber: BrokerSubscriber,
): Promise<() => Promise<void>> {
	const socket = createConnection(socketPath);
	socket.setEncoding("utf8");
	let buffer = "";
	let intentionalClose = false;
	let ready = false;
	let settled = false;
	let processing = Promise.resolve();

	let resolveReady: (() => void) | undefined;
	let rejectReady: ((error: Error) => void) | undefined;
	const readyPromise = new Promise<void>((resolve, reject) => {
		resolveReady = resolve;
		rejectReady = reject;
	});

	const send = (message: object) => socket.write(`${JSON.stringify(message)}\n`);
	const fail = async (error: Error) => {
		if (!settled) {
			settled = true;
			rejectReady?.(error);
		} else {
			await subscriber.onError(error).catch(() => undefined);
		}
		socket.destroy();
	};
	const handle = async (message: BrokerMessage) => {
		if (message.type === "caught_up") {
			await subscriber.onCaughtUp();
			send({ type: "ready" });
			ready = true;
			if (!settled) {
				settled = true;
				resolveReady?.();
			}
			return;
		}
		if (message.type === "update" && message.update) {
			await subscriber.deliver(message.update);
			send({ type: "ack", updateId: message.update.update_id });
			return;
		}
		if (message.type === "error") throw new Error(message.message || "Telegram broker error");
		throw new Error("Invalid Telegram broker message");
	};

	socket.on("connect", () => send({ type: "subscribe", conversationId, cursor }));
	socket.on("data", (chunk) => {
		buffer += chunk;
		while (true) {
			const newline = buffer.indexOf("\n");
			if (newline < 0) break;
			const line = buffer.slice(0, newline);
			buffer = buffer.slice(newline + 1);
			if (!line.trim()) continue;
			processing = processing
				.then(() => handle(JSON.parse(line) as BrokerMessage))
				.catch((error) => fail(error instanceof Error ? error : new Error(String(error))));
		}
	});
	socket.on("error", (error) => void fail(error));
	socket.on("close", () => {
		if (!settled) {
			settled = true;
			rejectReady?.(new Error("Telegram broker disconnected before catch-up"));
			return;
		}
		if (ready && !intentionalClose) void subscriber.onDisconnect?.().catch(() => undefined);
	});

	await readyPromise;
	return async () => {
		intentionalClose = true;
		if (socket.destroyed) return;
		await new Promise<void>((resolve) => {
			socket.once("close", resolve);
			socket.end();
		});
	};
}
