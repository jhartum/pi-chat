import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ResolvedConversation } from "../src/core/config-types.js";
import { ConversationRuntime } from "../src/runtime.js";

function conversation(root: string): ResolvedConversation {
	const accountDir = join(root, "accounts", "telegram");
	const conversationDir = join(accountDir, "channels", "production-general");
	const workspaceDir = join(conversationDir, "workspace");
	return {
		service: "telegram",
		botName: "pi",
		accountId: "telegram",
		account: { service: "telegram", botToken: "test", channels: {} },
		channelKey: "production-general",
		channel: { id: "-1001669827300" },
		conversationId: "telegram/production-general",
		conversationName: "Production / general",
		access: {},
		gondolinSecrets: {},
		gondolinTcpHosts: {},
		accountDir,
		sharedDir: join(accountDir, "shared"),
		conversationDir,
		workspaceDir,
		gondolinDir: join(conversationDir, "gondolin"),
		accountMemoryPath: join(accountDir, "shared", "memory.md"),
		channelMemoryPath: join(workspaceDir, "memory.md"),
		logPath: join(conversationDir, "channel.jsonl"),
		filesDir: join(workspaceDir, "incoming"),
		lockPath: join(conversationDir, ".lock"),
	};
}

async function queueMention(runtime: ConversationRuntime, messageId: string, text: string): Promise<void> {
	await runtime.ingestInbound({
		messageId,
		userId: "123",
		userName: "user",
		text,
		mentionedBot: true,
		attachments: [],
	});
}

test("skips unsettled queued jobs after reconnect", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-chat-runtime-"));
	const target = conversation(root);
	try {
		const firstRuntime = await ConversationRuntime.connect(target, "owner-1");
		firstRuntime.armAfterCurrentTail();
		await queueMention(firstRuntime, "1", "first");
		assert.ok(firstRuntime.beginNextJob());
		await queueMention(firstRuntime, "2", "second");
		await firstRuntime.disconnect();

		const restored = await ConversationRuntime.connect(target, "owner-2");
		assert.equal(restored.getStatus().queueLength, 0);
		assert.equal(restored.getStatus().hasActiveJob, false);
		assert.equal(restored.getStatus().recordCount, 6);
		assert.equal(restored.beginNextJob(), undefined);
		await restored.disconnect();

		const reconnectedAgain = await ConversationRuntime.connect(target, "owner-3");
		assert.equal(reconnectedAgain.getStatus().recordCount, 6);
		await reconnectedAgain.disconnect();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("skipped jobs advance the prompt boundary", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-chat-runtime-"));
	const target = conversation(root);
	try {
		const firstRuntime = await ConversationRuntime.connect(target, "owner-1");
		firstRuntime.armAfterCurrentTail();
		await queueMention(firstRuntime, "1", "completed-old");
		assert.ok(firstRuntime.beginNextJob());
		await firstRuntime.completeActiveJob("done");
		await queueMention(firstRuntime, "2", "failed-old");
		assert.ok(firstRuntime.beginNextJob());
		await firstRuntime.failActiveJob("provider error");
		await queueMention(firstRuntime, "3", "interrupted-old");
		await firstRuntime.disconnect();

		const restored = await ConversationRuntime.connect(target, "owner-2");
		assert.equal(restored.getStatus().queueLength, 0);
		restored.armAfterCurrentTail();
		await queueMention(restored, "4", "new-message");
		const prompt = restored.beginNextJob()?.prompt ?? "";
		assert.doesNotMatch(prompt, /completed-old/);
		assert.doesNotMatch(prompt, /failed-old/);
		assert.doesNotMatch(prompt, /interrupted-old/);
		assert.match(prompt, /new-message/);
		await restored.disconnect();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
