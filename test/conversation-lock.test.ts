import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ResolvedConversation } from "../src/core/config-types.js";
import { acquireConversationLock, ensureConversationDirs, releaseConversationLock } from "../src/log.js";

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

test("reclaims a stale conversation lock after the process PID is reused", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-chat-lock-"));
	const target = conversation(root);
	const oldOwner = `pi-chat-${process.pid}-old-container`;
	const newOwner = `pi-chat-${process.pid}-new-container`;
	try {
		await ensureConversationDirs(target);
		await writeFile(target.lockPath, `${oldOwner}\n`, "utf8");

		await acquireConversationLock(target, newOwner);

		assert.equal((await readFile(target.lockPath, "utf8")).trim(), newOwner);
		await releaseConversationLock(target);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
