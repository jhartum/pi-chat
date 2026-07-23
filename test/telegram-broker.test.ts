import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ChatConfig, TelegramAccountConfig } from "../src/core/config-types.js";
import { startTelegramBroker } from "../src/telegram-broker.js";
import { subscribeTelegramBroker } from "../src/telegram-broker-client.js";
import type { TelegramUpdate } from "../src/telegram-updates.js";

function account(channels: TelegramAccountConfig["channels"]): TelegramAccountConfig {
	return {
		service: "telegram",
		botToken: "test-token",
		botUserId: "8512736788",
		channels,
	};
}

function response(updates: TelegramUpdate[]): Response {
	return new Response(JSON.stringify({ ok: true, result: updates }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

async function until(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error("condition was not met");
}

test("Telegram broker routes one bot poller to a group and isolated DM workers", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-chat-broker-"));
	const socketPath = join(root, "telegram.sock");
	const config: ChatConfig = {
		accounts: {
			telegram: account({
				"production-general": {
					id: "-1001669827300",
					telegramThreadId: "1",
				},
			}),
			"telegram-dm-111111111": account({ dm: { id: "111111111", dm: true } }),
			"telegram-dm-222222222": account({ dm: { id: "222222222", dm: true } }),
		},
	};
	let getUpdatesCalls = 0;
	const requestBodies: Array<Record<string, unknown>> = [];
	let resolveLongPoll: ((value: Response) => void) | undefined;
	const fakeFetch = (async (_input, init) => {
		getUpdatesCalls += 1;
		requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
		if (getUpdatesCalls === 1) return response([]);
		return new Promise<Response>((resolve, reject) => {
			if (getUpdatesCalls === 2) resolveLongPoll = resolve;
			init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
				once: true,
			});
		});
	}) as typeof fetch;
	const broker = await startTelegramBroker({ config, socketPath, stateDir: join(root, "state"), fetch: fakeFetch });
	const received = new Map<string, number[]>();
	const conversations = ["telegram/production-general", "telegram-dm-111111111/dm", "telegram-dm-222222222/dm"];
	const disconnectors = await Promise.all(
		conversations.map((conversationId) =>
			subscribeTelegramBroker(socketPath, conversationId, undefined, {
				deliver: async (update) => {
					received.set(conversationId, [...(received.get(conversationId) ?? []), update.update_id]);
				},
				onCaughtUp: async () => {},
				onError: async (error) => {
					throw error;
				},
			}),
		),
	);

	try {
		await until(() => resolveLongPoll !== undefined);
		resolveLongPoll?.(
			response([
				{
					update_id: 11,
					message: { message_id: 101, chat: { id: -1001669827300, type: "supergroup" }, text: "group" },
				},
				{
					update_id: 12,
					message: { message_id: 102, chat: { id: 111111111, type: "private" }, text: "first dm" },
				},
				{
					update_id: 13,
					message: { message_id: 103, chat: { id: 222222222, type: "private" }, text: "second dm" },
				},
				{
					update_id: 14,
					message: { message_id: 104, chat: { id: 999, type: "private" }, text: "not configured" },
				},
			]),
		);
		await until(
			() => [...received.values()].reduce((total, ids) => total + ids.length, 0) === 3 && getUpdatesCalls === 3,
		);
		assert.deepEqual(received.get(conversations[0]), [11]);
		assert.deepEqual(received.get(conversations[1]), [12]);
		assert.deepEqual(received.get(conversations[2]), [13]);
		assert.equal(getUpdatesCalls, 3);
		assert.equal(requestBodies[2]?.offset, 15);
		assert.deepEqual(JSON.parse(await readFile(join(root, "state/8512736788.json"), "utf8")), {
			initialized: true,
			nextOffset: 15,
		});
	} finally {
		await Promise.all(disconnectors.map((disconnect) => disconnect()));
		await broker.close();
		await rm(root, { recursive: true, force: true });
	}
});

test("Telegram broker times out and retries a stalled proxy request", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-chat-broker-retry-"));
	const socketPath = join(root, "telegram.sock");
	const config: ChatConfig = {
		accounts: { telegram: account({ general: { id: "-1001669827300", telegramThreadId: "1" } }) },
	};
	let calls = 0;
	let resolveRetry: ((value: Response) => void) | undefined;
	const fakeFetch = (async (_input, init) => {
		calls += 1;
		if (calls === 1) return response([]);
		return new Promise<Response>((resolve, reject) => {
			if (calls === 3) resolveRetry = resolve;
			init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
		});
	}) as typeof fetch;
	const broker = await startTelegramBroker({
		config,
		socketPath,
		stateDir: join(root, "state"),
		fetch: fakeFetch,
		requestTimeoutMs: 10,
		retryDelayMs: 0,
	});
	const received: number[] = [];
	const disconnect = await subscribeTelegramBroker(socketPath, "telegram/general", undefined, {
		deliver: async (update) => {
			received.push(update.update_id);
		},
		onCaughtUp: async () => {},
		onError: async (error) => {
			throw error;
		},
	});

	try {
		await until(() => resolveRetry !== undefined);
		resolveRetry?.(
			response([
				{
					update_id: 21,
					message: { message_id: 201, chat: { id: -1001669827300, type: "supergroup" }, text: "retry" },
				},
			]),
		);
		await until(() => received.length === 1);
		assert.deepEqual(received, [21]);
		await until(() => calls >= 4);
		assert.equal(JSON.parse(await readFile(join(root, "state/8512736788.json"), "utf8")).nextOffset, 22);
	} finally {
		await disconnect();
		await broker.close();
		await rm(root, { recursive: true, force: true });
	}
});
