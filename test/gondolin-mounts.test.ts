import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveConversation } from "../src/config.js";
import type { ChatConfig } from "../src/core/config-types.js";
import { ConversationSandbox } from "../src/gondolin.js";

const config: ChatConfig = {
	accounts: {
		telegram: {
			service: "telegram",
			botToken: "test-token",
			channels: { group: { id: "-1001" } },
		},
	},
};

test("maps an optional repositories directory at /repos", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "pi-chat-repos-"));
	try {
		const workspaceDir = path.join(root, "workspace");
		const sharedDir = path.join(root, "shared");
		const repositoriesDir = path.join(root, "repositories");
		const repositoryFile = path.join(repositoriesDir, "project", "README.md");
		await mkdir(path.dirname(repositoryFile), { recursive: true });
		await mkdir(workspaceDir);
		await mkdir(sharedDir);
		await writeFile(repositoryFile, "test\n");

		const resolved = resolveConversation(config, "telegram/group");
		assert.ok(resolved);
		const sandbox = new ConversationSandbox({ ...resolved, workspaceDir, sharedDir }, { repositoriesDir });

		assert.equal(sandbox.resolveToolPath("/repos/project/README.md"), "/repos/project/README.md");
		assert.equal(sandbox.guestToHostPath("/repos/project/README.md"), repositoryFile);
		assert.equal(sandbox.hostToGuestPath(repositoryFile), "/repos/project/README.md");

		const sandboxWithoutRepositories = new ConversationSandbox({ ...resolved, workspaceDir, sharedDir });
		assert.throws(
			() => sandboxWithoutRepositories.resolveToolPath("/repos/project/README.md"),
			/outside mounted storage/,
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("rejects repository symlinks that escape the mounted directory", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "pi-chat-repos-"));
	try {
		const workspaceDir = path.join(root, "workspace");
		const sharedDir = path.join(root, "shared");
		const repositoriesDir = path.join(root, "repositories");
		const outsideDir = path.join(root, "outside");
		await mkdir(workspaceDir);
		await mkdir(sharedDir);
		await mkdir(repositoriesDir);
		await mkdir(outsideDir);
		await writeFile(path.join(outsideDir, "secret.txt"), "secret\n");
		await symlink(outsideDir, path.join(repositoriesDir, "escape"));

		const resolved = resolveConversation(config, "telegram/group");
		assert.ok(resolved);
		const sandbox = new ConversationSandbox({ ...resolved, workspaceDir, sharedDir }, { repositoriesDir });

		assert.throws(() => sandbox.guestToHostPath("/repos/escape/secret.txt"), /outside mounted storage/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
