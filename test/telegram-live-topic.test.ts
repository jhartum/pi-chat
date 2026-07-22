import assert from "node:assert/strict";
import test from "node:test";

import type { ResolvedConversation, TelegramAccountConfig } from "../src/core/config-types.js";
import { connectTelegramLive } from "../src/live/telegram.js";

function jsonResponse(result: unknown): Response {
	return new Response(JSON.stringify({ ok: true, result }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

function conversation(): ResolvedConversation {
	const channel = {
		id: "-1001669827300",
		name: "Production / general",
		telegramThreadId: "1",
	};
	const account: TelegramAccountConfig = {
		service: "telegram",
		botToken: "test-token",
		botUsername: "nesoft_assistant_bot",
		channels: { "production-general": channel },
	};
	return {
		service: "telegram",
		botName: "pi",
		accountId: "telegram",
		account,
		channelKey: "production-general",
		channel,
		conversationId: "telegram/production-general",
		conversationName: "telegram / Production / general",
		access: { trigger: "mention" },
		gondolinSecrets: {},
		gondolinTcpHosts: {},
		accountDir: "/tmp/account",
		sharedDir: "/tmp/shared",
		conversationDir: "/tmp/conversation",
		workspaceDir: "/tmp/workspace",
		gondolinDir: "/tmp/gondolin",
		accountMemoryPath: "/tmp/account-memory.md",
		channelMemoryPath: "/tmp/channel-memory.md",
		logPath: "/tmp/channel.jsonl",
		filesDir: "/tmp/files",
		lockPath: "/tmp/channel.lock",
	};
}

test("Telegram live adapter isolates and targets a configured forum topic", async () => {
	const originalFetch = globalThis.fetch;
	const requests: Array<{ method: string; body: Record<string, unknown> }> = [];
	const inbound: string[] = [];
	const errors: Error[] = [];
	let getUpdatesCalls = 0;
	let messageId = 200;
	globalThis.fetch = (async (input, init) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		const method = url.split("/").at(-1) ?? "";
		if (method === "getUpdates") {
			getUpdatesCalls += 1;
			if (getUpdatesCalls === 1) {
				return jsonResponse([
					{
						update_id: 1,
						message: {
							message_id: 101,
							message_thread_id: 1,
							chat: { id: -1001669827300, type: "supergroup" },
							from: { id: 10, username: "user" },
							text: "@nesoft_assistant_bot hello",
						},
					},
					{
						update_id: 2,
						message: {
							message_id: 102,
							message_thread_id: 2,
							chat: { id: -1001669827300, type: "supergroup" },
							from: { id: 11, username: "other" },
							text: "@nesoft_assistant_bot wrong topic",
						},
					},
				]);
			}
			return await new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
					once: true,
				});
			});
		}
		assert.equal(typeof init?.body, "string");
		const body = JSON.parse(init.body) as Record<string, unknown>;
		requests.push({ method, body });
		return jsonResponse(method === "sendMessage" ? { message_id: messageId++ } : true);
	}) as typeof fetch;

	let connection: Awaited<ReturnType<typeof connectTelegramLive>> | undefined;
	try {
		connection = await connectTelegramLive(conversation(), {
			onMessage: async (input) => {
				inbound.push(input.messageId);
			},
			onCaughtUp: async () => {},
			onError: async (error) => {
				errors.push(error);
			},
		});
		await connection.sendImmediate("immediate", "101");
		await connection.send("final", [], undefined, "101");
		await connection.startTyping();
		connection.setReplyTo("101");
		await connection.syncPreview("preview", true);
	} finally {
		await connection?.disconnect();
		globalThis.fetch = originalFetch;
	}

	assert.deepEqual(inbound, ["101"]);
	assert.deepEqual(errors, []);
	assert.ok(requests.length >= 4);
	for (const request of requests) {
		assert.ok(request.method === "sendMessage" || request.method === "sendChatAction");
		assert.equal(request.body.message_thread_id, 1);
	}
});
