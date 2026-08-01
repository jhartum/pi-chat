import assert from "node:assert/strict";
import test from "node:test";

import { resolveGondolinMemory } from "../src/gondolin.js";

test("uses the configured Gondolin VM memory", () => {
	assert.equal(resolveGondolinMemory({ PI_CHAT_GONDOLIN_MEMORY: " 512M " }), "512M");
});

test("leaves Gondolin memory at its library default when unset", () => {
	assert.equal(resolveGondolinMemory({}), undefined);
});
