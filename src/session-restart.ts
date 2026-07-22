import { randomUUID } from "node:crypto";
import { rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/** Priority for a pending control action. */
export type ActionPriority = "normal" | "supervised-restart";

/** Return value from draining a pending action. */
export interface DrainResult {
	/** True when a pending action existed and was executed. */
	didRun: boolean;
	/** The shutdownRequested value at the time of drain completion. */
	shutdownRequested: boolean;
}

/**
 * Manages a single deferred action with priority tracking for both queued
 * and currently-running state. A supervised-restart action can replace any
 * pending action, but a normal action cannot replace or run concurrently
 * with a supervised-restart.
 *
 * The action's execution is tracked separately from its queue entry so that
 * `hasPending` remains true while the action is in-flight. This prevents
 * dispatch from resuming until the action fully completes.
 *
 * When a higher-priority action is queued while a lower-priority action is
 * running, it runs next in the same drain cycle (serialized, not concurrent).
 */
export class PendingAction {
	private queuedAction: (() => Promise<void>) | undefined;
	private queuedPriority: ActionPriority = "normal";
	private runningAction: (() => Promise<void>) | undefined;
	private runningPriority: ActionPriority = "normal";

	/**
	 * Store a pending action with priority-based admission:
	 *
	 * - `supervised-restart` replaces any queued action and is rejected only
	 *   when a restart is already running (at most one effective restart).
	 * - `normal` is silently ignored when a `supervised-restart` is queued
	 *   OR running.
	 * - `normal` replaces a queued normal action.
	 * - If a different-priority action is running, the newly queued action
	 *   runs next in the same drain cycle.
	 */
	set(fn: () => Promise<void>, priority: ActionPriority = "normal"): void {
		// Restart priority handling
		if (priority === "supervised-restart") {
			// If a restart is already running, silently drop (at most one effective restart)
			if (this.runningPriority === "supervised-restart") return;

			// Replace whatever is queued
			this.queuedAction = fn;
			this.queuedPriority = priority;
			return;
		}

		// Normal priority: rejected if restart is queued OR running
		if (this.runningPriority === "supervised-restart" || this.queuedPriority === "supervised-restart") return;

		// Normal replaces queued normal (or queues behind a running normal)
		this.queuedAction = fn;
		this.queuedPriority = priority;
	}

	/**
	 * Execute queued actions in order. If a higher-priority action was queued
	 * while a lower-priority action was running (via `set` during `await`),
	 * it runs next in the same drain cycle.
	 *
	 * Returns true when at least one action executed.
	 */
	async drain(): Promise<boolean> {
		let didRun = false;

		while (this.queuedAction !== undefined) {
			// If an action is already running (concurrent drain call), break
			if (this.runningAction !== undefined) break;

			const fn = this.queuedAction;

			// Move from queued → running before yielding control
			this.runningAction = fn;
			this.runningPriority = this.queuedPriority;
			this.queuedAction = undefined;
			this.queuedPriority = "normal";

			try {
				await fn();
				didRun = true;
			} finally {
				this.runningAction = undefined;
				this.runningPriority = "normal";
			}
		}

		return didRun;
	}

	/** True when an action is queued or currently running. */
	get hasPending(): boolean {
		return this.queuedAction !== undefined || this.runningAction !== undefined;
	}

	/** The priority of the currently running or queued action. */
	get currentPriority(): ActionPriority {
		if (this.runningPriority !== "normal") return this.runningPriority;
		if (this.queuedPriority !== "normal") return this.queuedPriority;
		return "normal";
	}

	/** Discard all queued and running state. */
	clear(): void {
		this.queuedAction = undefined;
		this.queuedPriority = "normal";
		this.runningAction = undefined;
		this.runningPriority = "normal";
	}
}

/**
 * Production coordinator for deferred control actions. Wraps a PendingAction
 * with a shutdownRequested flag and provides a lifecycle method that owns
 * action drain and recovery dispatch.
 *
 * Used by index.ts to unify control action lifecycle across agent_end and
 * agent_settled, ensuring that recovery dispatch runs exactly once after a
 * no-shutdown drain and is fully suppressed when shutdown was requested —
 * even when the action throws.
 */
export class ControlCoordinator {
	private readonly pending = new PendingAction();
	private _shutdownRequested = false;

	get shutdownRequested(): boolean {
		return this._shutdownRequested;
	}

	set shutdownRequested(value: boolean) {
		this._shutdownRequested = value;
	}

	get hasPending(): boolean {
		return this.pending.hasPending;
	}

	/** Request a control action with the given priority. */
	request(fn: () => Promise<void>, priority: ActionPriority = "normal"): void {
		this.pending.set(fn, priority);
	}

	/**
	 * Drain the pending action (if any). Always returns the drain result
	 * including whether shutdown was requested.
	 */
	async drain(): Promise<DrainResult> {
		const didRun = await this.pending.drain();
		return { didRun, shutdownRequested: this._shutdownRequested };
	}

	/**
	 * Drain pending actions and conditionally run the recovery callback.
	 *
	 * Recovery is invoked exactly when no shutdown was requested:
	 * - After a normal (non-shutdown) action completes
	 * - Even when an action throws, as long as shutdown was not set
	 *
	 * Recovery is suppressed when shutdown was requested (restart marker
	 * written successfully), regardless of whether the action subsequently
	 * threw.
	 *
	 * If the action threw, the original error is rethrown after recovery.
	 */
	async drainAndRecover(recover: () => Promise<void>): Promise<void> {
		let actionError: unknown;
		try {
			await this.pending.drain();
		} catch (e) {
			actionError = e;
		}

		// Recovery runs iff no shutdown was requested — even on error
		if (!this._shutdownRequested) {
			try {
				await recover();
			} catch (recoverError) {
				// If recovery fails AND there is an original action error,
				// prefer the original error.
				if (actionError === undefined) throw recoverError;
			}
		}

		if (actionError !== undefined) throw actionError;
	}

	clear(): void {
		this.pending.clear();
		this._shutdownRequested = false;
	}
}

/**
 * Attempts to send a restart confirmation notification (e.g. via the live
 * connection), then always invokes the shutdown callback — even when the send
 * operation rejects. If the send rejects, the error propagates to the caller
 * after shutdown has been called.
 *
 * This guarantees that the supervisor-restart marker write (which must have
 * completed before this function is called) and the process shutdown always
 * happen together, even when the confirmation send fails due to a network or
 * API error.
 */
export async function sendRestartConfirmationAndShutdown(
	send: () => Promise<void>,
	shutdown: () => void,
): Promise<void> {
	try {
		await send();
	} finally {
		shutdown();
	}
}

/**
 * Reads the environment variable `PI_CHAT_NEW_SESSION_REQUEST_FILE` and returns
 * the configured path, or `undefined` when the value is blank, missing, or
 * whitespace-only. Defaults to `process.env` when no argument is given.
 */
export function getSessionRestartRequestFile(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const value = env.PI_CHAT_NEW_SESSION_REQUEST_FILE;
	if (value === undefined || value.trim().length === 0) {
		return undefined;
	}
	return value;
}

/**
 * Atomically writes a restart-request marker file at the given path.
 *
 * The write uses a per-invocation unique temporary file in the same directory
 * (with a random suffix) and `rename` for atomicity. If the target already
 * exists it is silently replaced. The file is created with owner read/write
 * permission (0o600). The temporary file is cleaned up on failure.
 *
 * Using a unique suffix per invocation prevents races between concurrent calls
 * to the same path.
 */
export async function writeSessionRestartRequest(path: string): Promise<void> {
	const dir = dirname(path);
	const base = basename(path);
	const suffix = randomUUID();
	const tmpPath = join(dir, `${base}.tmp.${suffix}`);

	try {
		await writeFile(tmpPath, `${JSON.stringify({ type: "session-restart", timestamp: new Date().toISOString() })}\n`, {
			mode: 0o600,
			flag: "wx",
		});
		await rename(tmpPath, path);
	} catch (error) {
		// Best-effort cleanup of this invocation's temporary file only
		try {
			await unlink(tmpPath);
		} catch {
			// ignore cleanup errors
		}
		throw error;
	}
}
