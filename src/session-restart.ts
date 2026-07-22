import { rename, unlink, writeFile } from "node:fs/promises";

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
 * The write uses an adjacent temporary file and `rename` for atomicity. If the
 * target already exists it is silently replaced. The file is created with owner
 * read/write permission (0o600). The temporary file is cleaned up on failure.
 */
export async function writeSessionRestartRequest(path: string): Promise<void> {
	const tmpPath = `${path}.tmp`;

	try {
		await writeFile(tmpPath, `${JSON.stringify({ type: "session-restart", timestamp: new Date().toISOString() })}\n`, {
			mode: 0o600,
		});
		await rename(tmpPath, path);
	} catch (error) {
		// Best-effort cleanup of the temporary file
		try {
			await unlink(tmpPath);
		} catch {
			// ignore cleanup errors
		}
		throw error;
	}
}
