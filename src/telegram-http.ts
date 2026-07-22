import { ProxyAgent } from "undici";

let proxyAgent: ProxyAgent | undefined;
let proxyUrl: string | undefined;

function getProxyAgent(): ProxyAgent | undefined {
	const configuredUrl = process.env.PI_CHAT_TELEGRAM_PROXY_URL?.trim();
	if (!configuredUrl) return undefined;
	if (proxyAgent && proxyUrl === configuredUrl) return proxyAgent;
	if (proxyAgent) void proxyAgent.close();
	proxyAgent = new ProxyAgent(configuredUrl);
	proxyUrl = configuredUrl;
	return proxyAgent;
}

export function telegramFetch(...args: Parameters<typeof fetch>): ReturnType<typeof fetch> {
	const agent = getProxyAgent();
	if (!agent) return fetch(...args);
	const [input, init] = args;
	return fetch(input, { ...init, dispatcher: agent } as RequestInit);
}
