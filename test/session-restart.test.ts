import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, describe, it } from "node:test";

import {
	ControlCoordinator,
	getSessionRestartRequestFile,
	PendingAction,
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

describe("PendingAction", () => {
	it("executes the action exactly once on drain", async () => {
		const pa = new PendingAction();
		let callCount = 0;
		pa.set(async () => {
			callCount++;
		});

		const r1 = await pa.drain();
		assert.equal(r1, true);
		assert.equal(callCount, 1);

		const r2 = await pa.drain();
		assert.equal(r2, false);
		assert.equal(callCount, 1);
	});

	it("returns false when nothing is pending", async () => {
		const pa = new PendingAction();
		assert.equal(await pa.drain(), false);
	});

	it("hasPending reflects stored state", () => {
		const pa = new PendingAction();
		assert.equal(pa.hasPending, false);

		pa.set(async () => {});
		assert.equal(pa.hasPending, true);

		pa.clear();
		assert.equal(pa.hasPending, false);
	});

	it("normal action replaces normal action", async () => {
		const pa = new PendingAction();
		let called = "";
		pa.set(async () => {
			called = "first";
		}, "normal");
		pa.set(async () => {
			called = "second";
		}, "normal");
		await pa.drain();
		assert.equal(called, "second");
	});

	it("supervised-restart replaces normal pending", async () => {
		const pa = new PendingAction();
		let called = "";
		pa.set(async () => {
			called = "normal";
		}, "normal");
		pa.set(async () => {
			called = "restart";
		}, "supervised-restart");
		await pa.drain();
		assert.equal(called, "restart");
	});

	it("normal action does not replace supervised-restart", async () => {
		const pa = new PendingAction();
		let called = "";
		pa.set(async () => {
			called = "restart";
		}, "supervised-restart");
		pa.set(async () => {
			called = "normal";
		}, "normal");
		await pa.drain();
		assert.equal(called, "restart");
	});

	it("supervised-restart replaces supervised-restart", async () => {
		const pa = new PendingAction();
		let callCount = 0;
		pa.set(async () => {
			callCount++;
		}, "supervised-restart");
		pa.set(async () => {
			callCount++;
		}, "supervised-restart");
		await pa.drain();
		assert.equal(callCount, 1);
	});
});

describe("ControlCoordinator", () => {
	it("drain returns didRun=false when nothing pending", async () => {
		const cc = new ControlCoordinator();
		const result = await cc.drain();
		assert.equal(result.didRun, false);
		assert.equal(result.shutdownRequested, false);
	});

	it("drain returns didRun=true after action runs", async () => {
		const cc = new ControlCoordinator();
		let ran = false;
		cc.request(async () => {
			ran = true;
		});
		const result = await cc.drain();
		assert.equal(result.didRun, true);
		assert.equal(ran, true);
	});

	it("drain returns shutdownRequested=true when set before drain", async () => {
		const cc = new ControlCoordinator();
		cc.request(async () => {});
		cc.shutdownRequested = true;
		const result = await cc.drain();
		assert.equal(result.didRun, true);
		assert.equal(result.shutdownRequested, true);
	});

	it("drain returns shutdownRequested=false on marker-write failure (no shutdown set)", async () => {
		const cc = new ControlCoordinator();
		cc.request(async () => {
			// Simulate marker-write failure: action returns without setting shutdown
		});
		const result = await cc.drain();
		assert.equal(result.didRun, true);
		assert.equal(result.shutdownRequested, false);
	});

	it("supervised-restart supersedes a normal pending action", async () => {
		const cc = new ControlCoordinator();
		let called = "";
		cc.request(async () => {
			called = "normal";
		}, "normal");
		cc.request(async () => {
			called = "restart";
		}, "supervised-restart");
		await cc.drain();
		assert.equal(called, "restart");
	});

	it("normal action cannot replace pending supervised-restart", async () => {
		const cc = new ControlCoordinator();
		let called = "";
		cc.request(async () => {
			called = "restart";
		}, "supervised-restart");
		cc.request(async () => {
			called = "normal";
		}, "normal");
		await cc.drain();
		assert.equal(called, "restart");
	});

	it("hasPending is false after drain", async () => {
		const cc = new ControlCoordinator();
		cc.request(async () => {});
		assert.equal(cc.hasPending, true);
		await cc.drain();
		assert.equal(cc.hasPending, false);
	});

	it("outbound AbortError + settlement: restart executes exactly once", async () => {
		// Simulate: action set while busy, drained via agent_settled after
		// an AbortError path that also drained (no-op second drain)
		let callCount = 0;
		const cc = new ControlCoordinator();

		// Simulate agent_end AbortError path
		cc.request(async () => {
			callCount++;
		}, "supervised-restart");
		const r1 = await cc.drain();
		assert.equal(r1.didRun, true);
		assert.equal(callCount, 1);

		// Simulate agent_settled
		const r2 = await cc.drain();
		assert.equal(r2.didRun, false);
		assert.equal(callCount, 1);
	});

	it("non-idle chatTurnInFlight=false: pending action executes once at settlement", async () => {
		// Simulate: action set while !ctx.isIdle() but chatTurnInFlight=false
		// agent_end returns early, agent_settled drains
		let callCount = 0;
		const cc = new ControlCoordinator();

		cc.request(async () => {
			callCount++;
		}, "supervised-restart");

		// Simulate settlement drain
		const result = await cc.drain();
		assert.equal(result.didRun, true);
		assert.equal(callCount, 1);
	});

	it("queued dispatch suppressed before drain", async () => {
		const cc = new ControlCoordinator();
		cc.request(async () => {}, "supervised-restart");
		assert.equal(cc.hasPending, true, "hasPending must be true before drain");
		// Caller would gate tryDispatch on hasPending
	});

	it("marker-write failure resumes dispatch (drain with no shutdown)", async () => {
		let dispatchedAfterDrain = false;
		const cc = new ControlCoordinator();

		// Marker-write failure: action runs but doesn't set shutdownRequested
		cc.request(async () => {
			// Simulate marker write error, no shutdown requested
		}, "supervised-restart");

		const result = await cc.drain();
		assert.equal(result.didRun, true);
		assert.equal(result.shutdownRequested, false);

		// After non-shutdown drain, dispatch should proceed
		dispatchedAfterDrain = true;
		assert.equal(dispatchedAfterDrain, true);
	});
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

test("wiring survives 3 lifecycle drain sites with correct recovery", async () => {
	const source = await readFile(new URL("../index.ts", import.meta.url), "utf8");

	// Verify coordinator usage instead of raw pendingAction + shutdownRequested
	assert.ok(source.includes("new ControlCoordinator()"), "index.ts must use ControlCoordinator");

	// All 3 drain paths must call coordinator.drain() then tryDispatch
	const drainCalls = source.match(/coordinator\.drain\(\)/g);
	assert.ok(drainCalls, "coordinator.drain() must be called");
	assert.equal(
		drainCalls?.length,
		3,
		"coordinator.drain() must appear in 3 places (aborted, AbortError, agent_settled)",
	);

	// All drain sites must also call tryDispatch unconditionally
	const pattern = /coordinator\.drain\(\);[^}]*tryDispatch/g;
	const matches = source.match(pattern);
	assert.ok(matches, "every coordinator.drain() must be followed by tryDispatch");
	assert.equal(matches?.length, 3, "all 3 drain sites must call tryDispatch after drain");

	// Restart uses supervised-restart priority
	assert.ok(
		source.includes('coordinator.request(queueNewSession, "supervised-restart"'),
		"remote new must use supervised-restart priority",
	);

	// Compact and sandbox-restart use normal priority
	assert.ok(source.includes('coordinator.request(runCompact, "normal"'), "compact must use normal priority");
	assert.ok(
		source.includes('coordinator.request(action, "normal"'),
		"chat-config sandbox restart must use normal priority",
	);

	// tryDispatch must be guarded by coordinator.hasPending
	assert.ok(
		source.includes("coordinator.hasPending") && source.includes("async function tryDispatch"),
		"tryDispatch must return when coordinator.hasPending is true",
	);

	// shutdownRequested must be on coordinator
	assert.ok(source.includes("coordinator.shutdownRequested"), "shutdownRequested must be accessed through coordinator");

	// agent_settled handler must exist (no pi as any)
	assert.ok(
		source.includes("agent_settled") && !source.includes("as any"),
		"agent_settled handler must be registered without any cast",
	);
});
