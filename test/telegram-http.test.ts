import assert from "node:assert/strict";
import { createServer } from "node:http";
import { connect } from "node:net";
import test from "node:test";

import { telegramFetch } from "../src/telegram-http.js";

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("missing test server port");
	return address.port;
}

async function close(server: ReturnType<typeof createServer>): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		server.close((error) => (error ? reject(error) : resolve()));
	});
}

test("routes Telegram requests through fresh proxy tunnels", async () => {
	let proxyConnections = 0;
	const target = createServer((_request, response) => response.end("ok"));
	const targetPort = await listen(target);
	const proxy = createServer();
	proxy.on("connect", (request, clientSocket, head) => {
		proxyConnections += 1;
		const [host, port] = (request.url ?? "").split(":");
		const upstream = connect(Number(port), host, () => {
			clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
			if (head.length > 0) upstream.write(head);
			upstream.pipe(clientSocket);
			clientSocket.pipe(upstream);
		});
	});
	const proxyPort = await listen(proxy);
	const previous = process.env.PI_CHAT_TELEGRAM_PROXY_URL;
	const originalFetch = globalThis.fetch;
	process.env.PI_CHAT_TELEGRAM_PROXY_URL = `http://127.0.0.1:${proxyPort}`;
	globalThis.fetch = () => Promise.reject(new Error("global fetch must not handle proxied Telegram requests"));
	try {
		for (let attempt = 0; attempt < 2; attempt += 1) {
			const response = await telegramFetch(`http://127.0.0.1:${targetPort}/getMe`);
			assert.equal(await response.text(), "ok");
		}
		assert.equal(proxyConnections, 2);
	} finally {
		globalThis.fetch = originalFetch;
		if (previous === undefined) delete process.env.PI_CHAT_TELEGRAM_PROXY_URL;
		else process.env.PI_CHAT_TELEGRAM_PROXY_URL = previous;
		await close(proxy);
		await close(target);
	}
});
