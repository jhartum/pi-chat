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
 * Manages a single deferred action with priority. A supervised-restart action
 * can replace any pending action, but a normal action cannot replace a pending
 * supervised-restart. This prevents race conditions where a later compact or
 * sandbox-restart could displace an authorized remote restart.
 *
 * Ensures the action executes at most once, even when multiple drain attempts
 * occur.
 */
export class PendingAction {
	private action: (() => Promise<void>) | undefined;
	private priority: ActionPriority = "normal";

	/**
	 * Store a pending action. A supervised-restart replaces any existing action.
	 * A normal action is silently ignored when a supervised-restart is already
	 * pending.
	 */
	set(fn: () => Promise<void>, priority: ActionPriority = "normal"): void {
		// supervised-restart can replace anything
		if (priority === "supervised-restart") {
			this.action = fn;
			this.priority = priority;
			return;
		}
		// normal action cannot replace a supervised-restart
		if (this.priority === "supervised-restart") return;
		this.action = fn;
		this.priority = priority;
	}

	/**
	 * Execute the stored action exactly once, then clear it.
	 * Returns true when an action was executed.
	 */
	async drain(): Promise<boolean> {
		const fn = this.action;
		if (!fn) return false;
		this.action = undefined;
		this.priority = "normal";
		await fn();
		return true;
	}

	/** True when a pending action exists and has not been drained. */
	get hasPending(): boolean {
		return this.action !== undefined;
	}

	/** The priority of the currently pending action. */
	get currentPriority(): ActionPriority {
		return this.priority;
	}

	/** Discard the pending action without executing it. */
	clear(): void {
		this.action = undefined;
		this.priority = "normal";
	}
}

/**
 * Production coordinator for deferred control actions. Wraps a PendingAction
 * with a shutdownRequested flag and provides a drain() method that returns both
 * whether an action ran and whether shutdown was requested. Used by index.ts
 * to unify control action lifecycle across agent_end and agent_settled.
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
	 * including whether shutdown was requested. After a non-shutdown action
	 * (e.g. marker-write failure), the caller MUST resume normal dispatch.
	 */
	async drain(): Promise<DrainResult> {
		const didRun = await this.pending.drain();
		return { didRun, shutdownRequested: this._shutdownRequested };
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
