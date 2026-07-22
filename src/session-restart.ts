import { randomUUID } from "node:crypto";
import { rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

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
