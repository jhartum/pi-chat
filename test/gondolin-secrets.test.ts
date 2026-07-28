import assert from "node:assert/strict";
import test from "node:test";

import { resolveConversation } from "../src/config.js";
import type { ChatConfig } from "../src/core/config-types.js";
import { resolveSecretEnvironment } from "../src/gondolin.js";

function conversationWithSecretHost(host: string) {
	const config: ChatConfig = {
		gondolin: {
			secrets: {
				TOKEN: { value: "test-secret", hosts: [host] },
			},
		},
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
	return conversation;
}

test("allows private addresses only for configured secret hosts", async () => {
	const { httpHooks } = resolveSecretEnvironment(conversationWithSecretHost("service.example.com"));
	assert.ok(httpHooks?.isIpAllowed);

	assert.equal(
		await httpHooks.isIpAllowed({
			hostname: "service.example.com",
			ip: "100.68.58.117",
			family: 4,
			port: 443,
			protocol: "https",
		}),
		true,
	);
	assert.equal(
		await httpHooks.isIpAllowed({
			hostname: "other.example.com",
			ip: "100.68.58.117",
			family: 4,
			port: 443,
			protocol: "https",
		}),
		false,
	);
});
