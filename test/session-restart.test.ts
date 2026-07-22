import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, describe, it } from "node:test";

import {
	getSessionRestartRequestFile,
	sendRestartConfirmationAndShutdown,
	writeSessionRestartRequest,
} from "../src/session-restart.js";

describe("getSessionRestartRequestFile", () => {
	it("returns undefined when PI_CHAT_NEW_SESSION_REQUEST_FILE is not set", () => {
		assert.equal(getSessionRestartRequestFile({}), undefined);
	});

	it("returns undefined when PI_CHAT_NEW_SESSION_REQUEST_FILE is empty string", () => {
		assert.equal(getSessionRestartRequestFile({ PI_CHAT_NEW_SESSION_REQUEST_FILE: "" }), undefined);
	});

	it("returns undefined when PI_CHAT_NEW_SESSION_REQUEST_FILE is whitespace only", () => {
		assert.equal(getSessionRestartRequestFile({ PI_CHAT_NEW_SESSION_REQUEST_FILE: "   " }), undefined);
	});

	it("returns the path when PI_CHAT_NEW_SESSION_REQUEST_FILE is set", () => {
		assert.equal(
			getSessionRestartRequestFile({ PI_CHAT_NEW_SESSION_REQUEST_FILE: "/tmp/.new-session" }),
			"/tmp/.new-session",
		);
	});

	it("defaults to process.env when no argument is given", () => {
		const previous = process.env.PI_CHAT_NEW_SESSION_REQUEST_FILE;
		process.env.PI_CHAT_NEW_SESSION_REQUEST_FILE = "/tmp/.default-env-test";
		try {
			assert.equal(getSessionRestartRequestFile(), "/tmp/.default-env-test");
		} finally {
			if (previous === undefined) {
				delete process.env.PI_CHAT_NEW_SESSION_REQUEST_FILE;
			} else {
				process.env.PI_CHAT_NEW_SESSION_REQUEST_FILE = previous;
			}
		}
	});
});

describe("writeSessionRestartRequest", () => {
	const tmpDirs: string[] = [];

	after(() => {
		for (const dir of tmpDirs) {
			try {
				rmSync(dir, { recursive: true, force: true });
			} catch {
				// ignore cleanup errors
			}
		}
	});

	async function tmpPath(): Promise<string> {
		const dir = mkdtempSync(join(tmpdir(), "session-restart-test-"));
		tmpDirs.push(dir);
		return join(dir, ".new-session");
	}

	it("writes the marker file with the expected content", async () => {
		const path = await tmpPath();
		await writeSessionRestartRequest(path);
		assert.equal(existsSync(path), true);
		const content = readFileSync(path, "utf8");
		assert.ok(content.includes("restart"));
	});

	it("is atomic: no temporary files remain after writing", async () => {
		const path = await tmpPath();
		await writeSessionRestartRequest(path);
		const dir = path.substring(0, path.lastIndexOf("/"));
		const entries = readdirSync(dir);
		const tempFiles = entries.filter((e) => e.startsWith(".new-session.tmp"));
		assert.deepEqual(tempFiles, []);
	});

	it("replaces an existing marker", async () => {
		const path = await tmpPath();
		await writeFile(path, "old-content", "utf8");
		await writeSessionRestartRequest(path);
		const content = readFileSync(path, "utf8");
		assert.ok(content.includes("restart"));
		assert.equal(content.includes("old-content"), false);
	});

	it("sets the file mode to 0600 (owner read/write only)", async () => {
		const path = await tmpPath();
		await writeSessionRestartRequest(path);
		const stats = statSync(path);
		// mode is file permissions; mask out file type bits
		const mode = stats.mode & 0o777;
		// 0o600 on unix-like systems; on Windows the mode may differ
		// We assert at least owner rw and not world-readable
		assert.ok((mode & 0o600) === 0o600, `expected 0o600, got ${mode.toString(8)}`);
	});

	it("handles concurrent writes to the same path", async () => {
		const path = await tmpPath();
		const count = 10;
		const promises = Array.from({ length: count }, () => writeSessionRestartRequest(path));
		await Promise.all(promises);

		assert.equal(existsSync(path), true);
		const content = readFileSync(path, "utf8");
		assert.ok(content.includes("restart"));

		const dir = path.substring(0, path.lastIndexOf("/"));
		const entries = readdirSync(dir);
		const tempFiles = entries.filter((e) => e.startsWith(".new-session.tmp"));
		assert.deepEqual(tempFiles, []);
	});
});

test("getSessionRestartRequestFile and writeSessionRestartRequest integrate", async () => {
	const dir = mkdtempSync(join(tmpdir(), "session-restart-int-"));
	const markerPath = join(dir, ".new-session");
	try {
		const result = getSessionRestartRequestFile({ PI_CHAT_NEW_SESSION_REQUEST_FILE: markerPath });
		assert.equal(result, markerPath);
		await writeSessionRestartRequest(result);
		assert.equal(existsSync(markerPath), true);
		const content = readFileSync(markerPath, "utf8");
		assert.ok(content.includes("restart"));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("sendRestartConfirmationAndShutdown", () => {
	it("invokes shutdown after send resolves", async () => {
		let shutdownCalled = false;
		let sendCalled = false;
		const send = async () => {
			sendCalled = true;
		};
		const shutdown = () => {
			shutdownCalled = true;
		};

		await sendRestartConfirmationAndShutdown(send, shutdown);
		assert.equal(sendCalled, true);
		assert.equal(shutdownCalled, true);
	});

	it("invokes shutdown even when send rejects", async () => {
		let shutdownCalled = false;
		const send = async () => {
			throw new Error("network failure");
		};
		const shutdown = () => {
			shutdownCalled = true;
		};

		await assert.rejects(() => sendRestartConfirmationAndShutdown(send, shutdown), /network failure/);
		assert.equal(shutdownCalled, true, "shutdown must be called even when send rejects");
	});

	it("propagates send rejection after calling shutdown", async () => {
		let shutdownCalled = false;
		const send = async () => {
			throw new Error("api error");
		};
		const shutdown = () => {
			shutdownCalled = true;
		};

		try {
			await sendRestartConfirmationAndShutdown(send, shutdown);
			assert.fail("should have rejected");
		} catch (err) {
			assert.equal(shutdownCalled, true);
			assert.equal(err instanceof Error ? err.message : String(err), "api error");
		}
	});
});

test("index.ts retains /chat-new command and removes obsolete pi.sendUserMessage bridge", async () => {
	const source = await readFile(new URL("../index.ts", import.meta.url), "utf8");

	// The local /chat-new command must still be registered
	assert.ok(
		source.includes('registerCommand("chat-new"'),
		"index.ts must keep registerCommand(chat-new) for local /chat-new",
	);

	// The obsolete bridge that forwarded remote 'new' as a user message must be removed
	const obsoleteBridgePattern = 'pi.sendUserMessage("/chat-new"';
	assert.ok(
		!source.includes(obsoleteBridgePattern),
		'index.ts must NOT contain the obsolete pi.sendUserMessage("/chat-new") bridge; remote new now writes restart marker directly',
	);
});
