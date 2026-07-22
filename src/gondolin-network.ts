import type { VMOptions } from "@earendil-works/gondolin";

import type { ResolvedConversation } from "./core/config-types.js";

export type GondolinNetworkOptions = Pick<VMOptions, "dns" | "tcp">;

export function buildGondolinNetworkOptions(conversation: ResolvedConversation): GondolinNetworkOptions {
	if (Object.keys(conversation.gondolinTcpHosts).length === 0) return {};
	return {
		dns: {
			mode: "synthetic",
			syntheticHostMapping: "per-host",
		},
		tcp: {
			hosts: { ...conversation.gondolinTcpHosts },
		},
	};
}
