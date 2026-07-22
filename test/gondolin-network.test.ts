import assert from "node:assert/strict";
import test from "node:test";

import { resolveConversation } from "../src/config.js";
import type { ChatConfig } from "../src/core/config-types.js";
import { buildGondolinNetworkOptions } from "../src/gondolin-network.js";

function configWithTcpMappings(): ChatConfig {
	return {
		botName: "pi",
		gondolin: {
			tcp: {
				hosts: {
					"global.internal:5432": "global-proxy:5432",
					"postgres.internal:5432": "global-postgres:5432",
				},
			},
		},
		accounts: {
			telegram: {
				service: "telegram",
				botToken: "test-token",
				gondolin: {
					tcp: {
						hosts: {
							"postgres.internal:5432": "account-postgres:5432",
						},
					},
				},
				channels: {
					group: {
						id: "-1001",
						gondolin: {
							tcp: {
								hosts: {
									"channel.internal:6379": "channel-proxy:6379",
								},
							},
						},
					},
				},
			},
		},
	};
}

test("merges TCP mappings from global, account, and channel scopes", () => {
	const conversation = resolveConversation(configWithTcpMappings(), "telegram/group");
	assert.ok(conversation);
	assert.deepEqual(conversation.gondolinTcpHosts, {
		"global.internal:5432": "global-proxy:5432",
		"postgres.internal:5432": "account-postgres:5432",
		"channel.internal:6379": "channel-proxy:6379",
	});
});

test("enables synthetic DNS only when TCP mappings exist", () => {
	const conversation = resolveConversation(configWithTcpMappings(), "telegram/group");
	assert.ok(conversation);
	assert.deepEqual(buildGondolinNetworkOptions(conversation), {
		dns: {
			mode: "synthetic",
			syntheticHostMapping: "per-host",
		},
		tcp: {
			hosts: {
				"global.internal:5432": "global-proxy:5432",
				"postgres.internal:5432": "account-postgres:5432",
				"channel.internal:6379": "channel-proxy:6379",
			},
		},
	});
});

test("preserves default Gondolin networking without TCP mappings", () => {
	const config: ChatConfig = {
		accounts: {
			telegram: {
				service: "telegram",
				botToken: "test-token",
				channels: { group: { id: "-1001" } },
			},
		},
	};
	const conversation = resolveConversation(config, "telegram/group");
	assert.ok(conversation);
	assert.deepEqual(buildGondolinNetworkOptions(conversation), {});
});
