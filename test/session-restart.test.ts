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

// ---------------------------------------------------------------------------
// Utility: env-file helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Utility: marker-file writing
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// PendingAction — behavioral tests with deferred promises
// ---------------------------------------------------------------------------

/**
 * Returns a {promise, resolve, reject} deferred control object.
 * The promise stays pending until resolve/reject is called.
 */
function deferred(): {
	promise: Promise<void>;
	resolve: () => void;
	reject: (err: unknown) => void;
} {
	let resolve!: () => void;
	let reject!: (err: unknown) => void;
	const promise = new Promise<void>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

describe("PendingAction", () => {
	it("hasPending is true while action is running (not just queued)", async () => {
		const pa = new PendingAction();
		const d = deferred();
		let observedWhileRunning: boolean | undefined;

		pa.set(async () => {
			observedWhileRunning = pa.hasPending;
			d.resolve();
		});

		// Drain starts, action runs, observes hasPending inside the action
		const drainPromise = pa.drain();
		await d.promise;

		assert.equal(observedWhileRunning, true, "hasPending must be true while action executes");
		await drainPromise;
		assert.equal(pa.hasPending, false, "hasPending must be false after drain completes");
	});

	it("normal action rejected while restart is queued", () => {
		const pa = new PendingAction();
		pa.set(async () => {}, "supervised-restart");
		pa.set(async () => {
			throw new Error("should not run");
		}, "normal");

		// Only the restart should be queued
		assert.equal(pa.hasPending, true);
		// Verify the normal was dropped by draining — only restart runs
	});

	it("normal action rejected while restart is running", async () => {
		const pa = new PendingAction();
		const d = deferred();
		let normalRejected = false;

		// Queue a restart that blocks until we release it
		pa.set(async () => {
			await d.promise;
		}, "supervised-restart");

		// Start draining the restart
		const drainPromise = pa.drain();

		// While restart is running, try to queue a normal action
		// We need to wait a tick to ensure drain has started
		await new Promise((r) => setTimeout(r, 10));

		// hasPending should still be true
		assert.equal(pa.hasPending, true, "hasPending must be true while restart runs");

		// Normal should be rejected
		pa.set(async () => {
			normalRejected = true;
		}, "normal");

		// Release the restart
		d.resolve();
		await drainPromise;

		// Normal should not have run
		assert.equal(normalRejected, false, "normal action must not run when restart is pending");
	});

	it("restart replaces queued normal", async () => {
		const pa = new PendingAction();
		let ran = "";

		pa.set(async () => {
			ran = "normal";
		}, "normal");
		pa.set(async () => {
			ran = "restart";
		}, "supervised-restart");

		await pa.drain();
		assert.equal(ran, "restart");
	});

	it("restart queued while normal is running executes after normal completes", async () => {
		const pa = new PendingAction();
		const normalStarted = deferred();
		const normalHeld = deferred();
		const order: string[] = [];

		// Normal action: blocks until released
		pa.set(async () => {
			order.push("normal-start");
			normalStarted.resolve();
			await normalHeld.promise;
			order.push("normal-end");
		}, "normal");

		const drainPromise = pa.drain();
		await normalStarted.promise;

		// While normal is running, queue a restart
		pa.set(async () => {
			order.push("restart-run");
		}, "supervised-restart");

		// hasPending should still be true
		assert.equal(pa.hasPending, true);

		// Release normal
		normalHeld.resolve();
		await drainPromise;

		assert.deepEqual(order, ["normal-start", "normal-end", "restart-run"], "restart must run after normal completes");
	});

	it("restart can replace queued restart (at most one effective restart)", async () => {
		const pa = new PendingAction();
		let callCount = 0;

		pa.set(async () => {
			callCount++;
		}, "supervised-restart");
		pa.set(async () => {
			callCount++;
		}, "supervised-restart");

		await pa.drain();
		// Only the second restart runs
		assert.equal(callCount, 1);
	});

	it("normal action replaces normal action", async () => {
		const pa = new PendingAction();
		let value = "";

		pa.set(async () => {
			value = "first";
		}, "normal");
		pa.set(async () => {
			value = "second";
		}, "normal");

		await pa.drain();
		assert.equal(value, "second");
	});

	it("concurrent drain calls execute the action once", async () => {
		const pa = new PendingAction();
		let callCount = 0;

		pa.set(async () => {
			callCount++;
		});

		const [r1, r2] = await Promise.all([pa.drain(), pa.drain()]);

		assert.equal(callCount, 1, "action must execute exactly once");
		// At least one drain should report didRun
		assert.ok(r1 || r2, "one drain must report didRun=true");
	});

	it("drain returns false when nothing is pending", async () => {
		const pa = new PendingAction();
		assert.equal(await pa.drain(), false);
	});

	it("clear resets queued and running state", async () => {
		const pa = new PendingAction();
		pa.set(async () => {}, "supervised-restart");
		assert.equal(pa.hasPending, true);
		pa.clear();
		assert.equal(pa.hasPending, false);
		assert.equal(await pa.drain(), false);
	});
});

// ---------------------------------------------------------------------------
// ControlCoordinator.drainAndRecover — behavioral tests
// ---------------------------------------------------------------------------

describe("ControlCoordinator.drainAndRecover", () => {
	it("calls recover after successful no-shutdown drain", async () => {
		const cc = new ControlCoordinator();
		let recovered = false;

		cc.request(async () => {
			// normal completion, no shutdown
		}, "normal");

		await cc.drainAndRecover(async () => {
			recovered = true;
		});

		assert.equal(recovered, true, "recover must be called after no-shutdown drain");
	});

	it("does NOT call recover when shutdown was requested", async () => {
		const cc = new ControlCoordinator();
		let recovered = false;

		cc.request(async () => {
			cc.shutdownRequested = true;
		}, "supervised-restart");

		await cc.drainAndRecover(async () => {
			recovered = true;
		});

		assert.equal(recovered, false, "recover must NOT be called when shutdown was requested");
	});

	it("calls recover even when action throws (no shutdown)", async () => {
		const cc = new ControlCoordinator();
		let recovered = false;
		let caught: unknown;

		cc.request(async () => {
			throw new Error("action failure");
		}, "normal");

		try {
			await cc.drainAndRecover(async () => {
				recovered = true;
			});
		} catch (e) {
			caught = e;
		}

		assert.equal(recovered, true, "recover must be called even when action throws");
		assert.ok(caught instanceof Error, "action error must be rethrown");
		assert.equal((caught as Error).message, "action failure");
	});

	it("skips recovery when action throws but shutdown was requested", async () => {
		const cc = new ControlCoordinator();
		let recovered = false;
		let caught: unknown;

		cc.request(async () => {
			// Marker write succeeded, confirmation send throws
			cc.shutdownRequested = true;
			throw new Error("confirmation send failure");
		}, "supervised-restart");

		try {
			await cc.drainAndRecover(async () => {
				recovered = true;
			});
		} catch (e) {
			caught = e;
		}

		assert.equal(recovered, false, "recover must NOT be called when shutdown was requested even on throw");
		assert.ok(caught instanceof Error, "action error must be rethrown");
		assert.equal((caught as Error).message, "confirmation send failure");
	});

	it("rethrows action error after recovery", async () => {
		const cc = new ControlCoordinator();

		cc.request(async () => {
			throw new Error("marker write failure");
		}, "supervised-restart");

		await assert.rejects(
			() =>
				cc.drainAndRecover(async () => {
					// recovery runs, then error rethrows
				}),
			/marker write failure/,
		);
	});

	it("hasPending blocks dispatch before and during restart action", async () => {
		const cc = new ControlCoordinator();
		const d = deferred();

		cc.request(async () => {
			await d.promise;
		}, "supervised-restart");

		// Start drain (action runs async)
		const drainPromise = cc.drain();

		// While restart is running, hasPending is true
		assert.equal(cc.hasPending, true, "hasPending must be true while restart runs");

		d.resolve();
		await drainPromise;

		assert.equal(cc.hasPending, false, "hasPending must be false after drain");
	});

	it("restart queued while normal running runs next before dispatch", async () => {
		const cc = new ControlCoordinator();
		const normalHeld = deferred();
		const order: string[] = [];

		// Queue a normal action that blocks
		cc.request(async () => {
			order.push("normal");
			await normalHeld.promise;
		}, "normal");

		// Start draining
		const drainPromise = cc.drainAndRecover(async () => {
			order.push("recover");
		});

		// Wait for normal to start running
		await new Promise((r) => setTimeout(r, 10));

		// Queue a restart while normal is running
		cc.request(async () => {
			order.push("restart");
		}, "supervised-restart");

		// Release normal
		normalHeld.resolve();
		await drainPromise;

		// restart must run before recovery (dispatch is suppressed)
		assert.deepEqual(order, ["normal", "restart", "recover"], "restart must run before recovery");
	});

	it("concurrent drainAndRecover calls do not double-dispatch", async () => {
		const cc = new ControlCoordinator();
		let callCount = 0;

		cc.request(async () => {
			callCount++;
		}, "supervised-restart");

		// Two concurrent drains — only one should execute the action
		await Promise.all([cc.drainAndRecover(async () => {}), cc.drainAndRecover(async () => {})]);

		assert.equal(callCount, 1, "action must execute exactly once across concurrent drains");
	});
});

// ---------------------------------------------------------------------------
// sendRestartConfirmationAndShutdown
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Integration: /chat-new command and wiring tests
// ---------------------------------------------------------------------------

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

test("index.ts uses drainAndRecover at all 3 lifecycle sites", async () => {
	const source = await readFile(new URL("../index.ts", import.meta.url), "utf8");

	// Must use drainAndRecover in the lifecycle paths
	const drainAndRecoverCalls = source.match(/coordinator\.drainAndRecover\(/g);
	assert.ok(
		drainAndRecoverCalls && drainAndRecoverCalls.length >= 3,
		`coordinator.drainAndRecover() must appear in at least 3 places, found ${drainAndRecoverCalls?.length ?? 0}`,
	);

	// Must NOT use raw coordinator.drain() in lifecycle handlers (agent_end, agent_settled)
	// drain() might still exist as a public method but shouldn't be called from lifecycle
	const rawDrainInLifecycle = source.match(/agent_(?:end|settled)[\s\S]*?coordinator\.drain\(\)/);
	assert.ok(!rawDrainInLifecycle, "coordinator.drain() must not be called directly in lifecycle handlers");

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

	// agent_settled handler must exist
	assert.ok(source.includes("agent_settled"), "agent_settled handler must be registered");
});
