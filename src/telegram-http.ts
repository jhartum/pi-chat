import { ProxyAgent } from "undici";

let proxyAgent: ProxyAgent | undefined;
let proxyUrl: string | undefined;

function getProxyAgent(): ProxyAgent | undefined {
	const configuredUrl = process.env.PI_CHAT_TELEGRAM_PROXY_URL?.trim();
	if (!configuredUrl) return undefined;
	if (proxyAgent && proxyUrl === configuredUrl) return proxyAgent;
	if (proxyAgent) void proxyAgent.close();
	proxyAgent = new ProxyAgent({ uri: configuredUrl, pipelining: 0 });
	proxyUrl = configuredUrl;
	return proxyAgent;
}

export async function telegramFetch(...args: Parameters<typeof fetch>): ReturnType<typeof fetch> {
	const agent = getProxyAgent();
	if (!agent) return fetch(...args);
	const [input, init] = args;
	try {
		return await fetch(input, { ...init, dispatcher: agent } as RequestInit);
	} catch (error) {
		if (proxyAgent === agent) {
			proxyAgent = undefined;
			proxyUrl = undefined;
			void agent.close().catch(() => undefined);
		}
		throw error;
	}
}
