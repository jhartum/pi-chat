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
// Utility
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

// ---------------------------------------------------------------------------
// env-file helpers
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
// marker-file writing
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
		const mode = stats.mode & 0o777;
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
// PendingAction — behavioral tests
// ---------------------------------------------------------------------------

describe("PendingAction", () => {
	// --- Admission observability ---

	it("set returns true when action is accepted (normal when idle)", () => {
		const pa = new PendingAction();
		const result = pa.set(async () => {}, "normal");
		assert.equal(result, true);
	});

	it("set returns false when normal is rejected (restart queued)", () => {
		const pa = new PendingAction();
		pa.set(async () => {}, "supervised-restart");
		const result = pa.set(async () => {
			throw new Error("should not run");
		}, "normal");
		assert.equal(result, false, "normal must be rejected when restart is queued");
	});

	it("set returns false when normal is rejected (restart running)", async () => {
		const pa = new PendingAction();
		const d = deferred();

		pa.set(async () => {
			await d.promise;
		}, "supervised-restart");

		const drainPromise = pa.drain();
		await new Promise((r) => setTimeout(r, 10));

		const result = pa.set(async () => {
			throw new Error("should not run");
		}, "normal");

		assert.equal(result, false, "normal must be rejected when restart is running");

		d.resolve();
		await drainPromise;
	});

	it("set returns true when restart replaces queued normal", () => {
		const pa = new PendingAction();
		pa.set(async () => {}, "normal");
		const result = pa.set(async () => {}, "supervised-restart");
		assert.equal(result, true, "restart must be accepted (replaces normal)");
	});

	it("set returns false when restart-while-restart-running", async () => {
		const pa = new PendingAction();
		const d = deferred();

		pa.set(async () => {
			await d.promise;
		}, "supervised-restart");

		const drainPromise = pa.drain();
		await new Promise((r) => setTimeout(r, 10));

		const result = pa.set(async () => {}, "supervised-restart");
		assert.equal(result, false, "restart must be rejected when restart is already running");

		d.resolve();
		await drainPromise;
	});

	it("set returns true for ControlCoordinator.request", () => {
		const cc = new ControlCoordinator();
		const result = cc.request(async () => {}, "normal");
		assert.equal(result, true, "ControlCoordinator.request must propagate acceptance");
	});

	it("set returns false for ControlCoordinator.request when rejected", () => {
		const cc = new ControlCoordinator();
		cc.request(async () => {}, "supervised-restart");
		const result = cc.request(async () => {}, "normal");
		assert.equal(result, false, "ControlCoordinator.request must propagate rejection");
	});

	// --- Running state tracking ---

	it("hasPending is true while action is running (not just queued)", async () => {
		const pa = new PendingAction();
		const d = deferred();
		let observedWhileRunning: boolean | undefined;

		pa.set(async () => {
			observedWhileRunning = pa.hasPending;
			d.resolve();
		});

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
		assert.equal(pa.hasPending, true);
	});

	it("normal action rejected while restart is running", async () => {
		const pa = new PendingAction();
		const d = deferred();

		pa.set(async () => {
			await d.promise;
		}, "supervised-restart");

		const drainPromise = pa.drain();
		await new Promise((r) => setTimeout(r, 10));

		assert.equal(pa.hasPending, true, "hasPending must be true while restart runs");

		pa.set(async () => {}, "normal");

		d.resolve();
		await drainPromise;

		// hasPending should be false after normal drain completes
		// (the normal was never queued so nothing extra to drain)
		assert.equal(pa.hasPending, false);
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

		pa.set(async () => {
			order.push("normal-start");
			normalStarted.resolve();
			await normalHeld.promise;
			order.push("normal-end");
		}, "normal");

		const drainPromise = pa.drain();
		await normalStarted.promise;

		pa.set(async () => {
			order.push("restart-run");
		}, "supervised-restart");

		assert.equal(pa.hasPending, true);

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

	// --- Throw handling: drain continues for queued work ---

	it("restart queued while normal throws executes restart in same drain cycle", async () => {
		const pa = new PendingAction();
		const normalStarted = deferred();
		const beforeThrow = deferred();
		const order: string[] = [];

		// Normal action blocks at beforeThrow so test can queue restart while it's running
		pa.set(async () => {
			order.push("normal-start");
			normalStarted.resolve();
			await beforeThrow.promise;
			order.push("normal-throw");
			throw new Error("normal failure");
		}, "normal");

		const drainPromise = pa.drain();
		await normalStarted.promise;

		// Queue restart while normal is blocked at beforeThrow
		pa.set(async () => {
			order.push("restart-run");
		}, "supervised-restart");

		// Release normal so it throws
		beforeThrow.resolve();

		await assert.rejects(() => drainPromise, /normal failure/);

		assert.deepEqual(
			order,
			["normal-start", "normal-throw", "restart-run"],
			"restart must execute in same drain cycle even when normal throws",
		);
	});

	it("concurrent drain calls: running action throws, no extra recovery at PA level", async () => {
		const pa = new PendingAction();
		const d = deferred();

		pa.set(async () => {
			await d.promise;
			throw new Error("action failure");
		});

		// Start two concurrent drains
		const [r1, r2] = await Promise.allSettled([
			(async () => {
				d.resolve(); // let the action start failing
				return pa.drain();
			})(),
			pa.drain(),
		]);

		// At least one rejects with the action error
		const rejections = [r1, r2].filter((r) => r.status === "rejected");
		assert.ok(rejections.length >= 1, "at least one drain must propagate the error");
	});
});

// ---------------------------------------------------------------------------
// ControlCoordinator.drainAndRecover — behavioral tests
// ---------------------------------------------------------------------------

describe("ControlCoordinator.drainAndRecover", () => {
	it("calls recover after successful no-shutdown drain", async () => {
		const cc = new ControlCoordinator();
		let recovered = false;

		cc.request(async () => {}, "normal");

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

		const drainPromise = cc.drain();

		assert.equal(cc.hasPending, true, "hasPending must be true while restart runs");

		d.resolve();
		await drainPromise;

		assert.equal(cc.hasPending, false, "hasPending must be false after drain");
	});

	it("restart queued while normal running runs next before dispatch", async () => {
		const cc = new ControlCoordinator();
		const normalHeld = deferred();
		const order: string[] = [];

		cc.request(async () => {
			order.push("normal");
			await normalHeld.promise;
		}, "normal");

		const drainPromise = cc.drainAndRecover(async () => {
			order.push("recover");
		});

		await new Promise((r) => setTimeout(r, 10));

		cc.request(async () => {
			order.push("restart");
		}, "supervised-restart");

		normalHeld.resolve();
		await drainPromise;

		assert.deepEqual(order, ["normal", "restart", "recover"], "restart must run before recovery");
	});

	it("concurrent drainAndRecover calls do not double-dispatch", async () => {
		const cc = new ControlCoordinator();
		let actionCount = 0;

		cc.request(async () => {
			actionCount++;
		}, "supervised-restart");

		await Promise.all([cc.drainAndRecover(async () => {}), cc.drainAndRecover(async () => {})]);

		assert.equal(actionCount, 1, "action must execute exactly once across concurrent drains");
	});

	it("concurrent drainAndRecover calls recovery exactly once", async () => {
		const cc = new ControlCoordinator();
		const barrier = deferred();
		let recoverCount = 0;

		// Queue an action that blocks until we release the barrier
		cc.request(async () => {
			await barrier.promise;
		}, "normal");

		// Start two concurrent drains
		const drainPromises = Promise.allSettled([
			cc.drainAndRecover(async () => {
				recoverCount++;
			}),
			cc.drainAndRecover(async () => {
				recoverCount++;
			}),
		]);

		// Let both drains enter pending.drain() before releasing the barrier
		await new Promise((r) => setTimeout(r, 20));

		// Release barrier so the action (and thus drain #1) can complete
		barrier.resolve();

		await drainPromises;

		// Recovery must be called exactly once, not twice
		assert.equal(recoverCount, 1, "recover must be called exactly once across concurrent drains");
	});

	// --- Throw handling with chained restart ---

	it("restart queued while normal throws runs restart then recovery", async () => {
		const cc = new ControlCoordinator();
		const normalStarted = deferred();
		const beforeThrow = deferred();
		const order: string[] = [];
		let recovered = false;

		// Normal blocks at beforeThrow so test can queue restart while it runs
		cc.request(async () => {
			order.push("normal-start");
			normalStarted.resolve();
			await beforeThrow.promise;
			order.push("normal-throw");
			throw new Error("normal failure");
		}, "normal");

		const darPromise = cc.drainAndRecover(async () => {
			order.push("recover");
			recovered = true;
		});

		await normalStarted.promise;

		// Queue restart while normal is blocked at beforeThrow
		cc.request(async () => {
			order.push("restart-run");
		}, "supervised-restart");

		// Release normal so it throws — then restart should run, then recovery
		beforeThrow.resolve();

		await assert.rejects(() => darPromise, /normal failure/);

		assert.deepEqual(
			order,
			["normal-start", "normal-throw", "restart-run", "recover"],
			"restart must run after normal throws, then recovery",
		);
		assert.equal(recovered, true, "recovery must run (no shutdown was set)");
	});

	it("restart queued while normal throws with shutdown suppresses recovery", async () => {
		const cc = new ControlCoordinator();
		const normalStarted = deferred();
		const beforeThrow = deferred();
		const order: string[] = [];
		let recovered = false;

		// Normal blocks at beforeThrow so test can queue restart while it runs
		cc.request(async () => {
			order.push("normal-start");
			normalStarted.resolve();
			await beforeThrow.promise;
			order.push("normal-throw");
			throw new Error("normal failure");
		}, "normal");

		const darPromise = cc.drainAndRecover(async () => {
			order.push("recover");
			recovered = true;
		});

		await normalStarted.promise;

		// Queue restart that sets shutdown while normal is blocked
		cc.request(async () => {
			order.push("restart-shutdown");
			cc.shutdownRequested = true;
		}, "supervised-restart");

		// Release normal so it throws — then restart should run, recovery suppressed
		beforeThrow.resolve();

		await assert.rejects(() => darPromise, /normal failure/);

		assert.deepEqual(
			order,
			["normal-start", "normal-throw", "restart-shutdown"],
			"restart must run after normal throws, recovery suppressed",
		);
		assert.equal(recovered, false, "recovery must NOT run (shutdown was requested)");
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
// Integration: wiring tests
// ---------------------------------------------------------------------------

test("index.ts retains /chat-new command and removes obsolete pi.sendUserMessage bridge", async () => {
	const source = await readFile(new URL("../index.ts", import.meta.url), "utf8");

	assert.ok(source.includes('registerCommand("chat-new"'), "index.ts must keep registerCommand(chat-new)");

	const obsoleteBridgePattern = 'pi.sendUserMessage("/chat-new"';
	assert.ok(
		!source.includes(obsoleteBridgePattern),
		'index.ts must NOT contain the obsolete pi.sendUserMessage("/chat-new") bridge',
	);
});

test("index.ts uses drainAndRecover at all 3 lifecycle sites", async () => {
	const source = await readFile(new URL("../index.ts", import.meta.url), "utf8");

	const drainAndRecoverCalls = source.match(/coordinator\.drainAndRecover\(/g);
	assert.ok(
		drainAndRecoverCalls && drainAndRecoverCalls.length >= 3,
		`coordinator.drainAndRecover() must appear in at least 3 places, found ${drainAndRecoverCalls?.length ?? 0}`,
	);

	const rawDrainInLifecycle = source.match(/agent_(?:end|settled)[\s\S]*?coordinator\.drain\(\)/);
	assert.ok(!rawDrainInLifecycle, "coordinator.drain() must not be called directly in lifecycle handlers");

	assert.ok(
		source.includes('coordinator.request(queueNewSession, "supervised-restart"'),
		"remote new must use supervised-restart priority",
	);

	assert.ok(source.includes('coordinator.request(runCompact, "normal"'), "compact must use normal priority");
	assert.ok(
		source.includes('coordinator.request(action, "normal"'),
		"chat-config sandbox restart must use normal priority",
	);

	assert.ok(
		source.includes("coordinator.hasPending") && source.includes("async function tryDispatch"),
		"tryDispatch must return when coordinator.hasPending is true",
	);

	assert.ok(source.includes("coordinator.shutdownRequested"), "shutdownRequested must be accessed through coordinator");
	assert.ok(source.includes("agent_settled"), "agent_settled handler must be registered");
});
