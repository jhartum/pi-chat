import assert from "node:assert/strict";
import test from "node:test";

import {
	matchesTelegramTarget,
	resolveTelegramTarget,
	setTelegramThreadFormField,
	withTelegramThread,
} from "../src/telegram-target.js";

test("matches every message in a configured chat when no topic is selected", () => {
	const target = resolveTelegramTarget({ id: "-1001669827300" });

	assert.equal(matchesTelegramTarget(target, { chat: { id: -1001669827300 } }), true);
	assert.equal(matchesTelegramTarget(target, { chat: { id: -1001669827300 }, message_thread_id: 99 }), true);
	assert.equal(matchesTelegramTarget(target, { chat: { id: -1000000000000 } }), false);
});

test("matches only the configured Telegram topic", () => {
	const target = resolveTelegramTarget({ id: "-1001669827300", telegramThreadId: "1" });

	assert.equal(matchesTelegramTarget(target, { chat: { id: -1001669827300 }, message_thread_id: 1 }), true);
	assert.equal(matchesTelegramTarget(target, { chat: { id: -1001669827300 } }), false);
	assert.equal(matchesTelegramTarget(target, { chat: { id: -1001669827300 }, message_thread_id: 2 }), false);
});

test("adds the configured topic to JSON and multipart Telegram requests", () => {
	const target = resolveTelegramTarget({ id: "-1001669827300", telegramThreadId: "1" });

	assert.deepEqual(withTelegramThread(target, { chat_id: -1001669827300, text: "hello" }), {
		chat_id: -1001669827300,
		text: "hello",
		message_thread_id: 1,
	});
	const form = new FormData();
	setTelegramThreadFormField(target, form);
	assert.equal(form.get("message_thread_id"), "1");
});

test("rejects invalid Telegram topic IDs", () => {
	for (const telegramThreadId of ["", "0", "-1", "1.5", "general", "9007199254740992"]) {
		assert.throws(
			() => resolveTelegramTarget({ id: "-1001669827300", telegramThreadId }),
			/telegramThreadId must be a positive safe integer/,
		);
	}
});
