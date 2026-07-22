import { randomUUID } from "node:crypto";
import { rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/**
 * Manages a single deferred action that can be set while the agent is busy
 * and drained when the agent settles. Ensures the action executes at most
 * once, even when multiple drain attempts occur.
 */
export class PendingAction {
	private action: (() => Promise<void>) | undefined;

	/** Store a pending action. Replaces any previously stored action. */
	set(fn: () => Promise<void>): void {
		this.action = fn;
	}

	/**
	 * Execute the stored action exactly once, then clear it.
	 * Returns true when an action was executed.
	 */
	async drain(): Promise<boolean> {
		const fn = this.action;
		if (!fn) return false;
		this.action = undefined;
		await fn();
		return true;
	}

	/** True when a pending action exists and has not been drained. */
	get hasPending(): boolean {
		return this.action !== undefined;
	}

	/** Discard the pending action without executing it. */
	clear(): void {
		this.action = undefined;
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
