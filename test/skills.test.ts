import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { formatChatSkillsForPrompt, loadSafeChatSkills, parseSkillFrontmatter } from "../src/skills.js";

test("parseSkillFrontmatter unfolds folded YAML descriptions", () => {
	const { name, description } = parseSkillFrontmatter(`---
name: s3
description: >-
  Use for NeSoft daily standup recording and transcription artifacts in
  S3-compatible storage: inspect, upload, download, and manage their access.
---

# body`);
	assert.equal(name, "s3");
	assert.equal(
		description,
		"Use for NeSoft daily standup recording and transcription artifacts in S3-compatible storage: inspect, upload, download, and manage their access.",
	);
});

test("parseSkillFrontmatter handles plain and quoted single-line descriptions", () => {
	assert.equal(
		parseSkillFrontmatter("---\nname: psql\ndescription: Use for PostgreSQL work through the psql CLI.\n---").description,
		"Use for PostgreSQL work through the psql CLI.",
	);
	assert.equal(
		parseSkillFrontmatter("---\nname: psql\ndescription: \"Use for PostgreSQL work through the psql CLI.\"\n---").description,
		"Use for PostgreSQL work through the psql CLI.",
	);
});

test("parseSkillFrontmatter parses disable-model-invocation as a boolean", () => {
	const frontmatter = parseSkillFrontmatter(`---
name: hidden
description: Not for the model.
disable-model-invocation: true
---`);
	assert.equal(frontmatter.disabled, true);
});

test("parseSkillFrontmatter returns empty when frontmatter is missing", () => {
	const frontmatter = parseSkillFrontmatter("# just a body");
	assert.equal(frontmatter.name, undefined);
	assert.equal(frontmatter.description, undefined);
	assert.equal(frontmatter.disabled, false);
});

test("loadSafeChatSkills discovers directory and single-file skills with unfolded descriptions", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-chat-skills-"));
	try {
		await mkdir(join(root, "skills", "s3"), { recursive: true });
		await writeFile(
			join(root, "skills", "s3", "SKILL.md"),
			`---
name: s3
description: >-
  Use for daily standup artifacts in
  S3 storage.
---
# S3`,
		);
		await writeFile(
			join(root, "skills", "plain.md"),
			`---
name: plain
description: Single line skill.
---
# Plain`,
		);
		await mkdir(join(root, "skills", "hidden"), { recursive: true });
		await writeFile(
			join(root, "skills", "hidden", "SKILL.md"),
			`---
name: hidden
description: Not for the model.
disable-model-invocation: true
---
# Hidden`,
		);

		const skills = await loadSafeChatSkills(root);
		assert.deepEqual(
			skills.map((skill) => skill.name).sort(),
			["plain", "s3"],
			"disabled skills must be excluded",
		);
		assert.equal(skills.find((skill) => skill.name === "s3")?.description, "Use for daily standup artifacts in S3 storage.");
		assert.equal(skills.find((skill) => skill.name === "plain")?.filePath, join(root, "skills", "plain.md"));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("formatChatSkillsForPrompt escapes descriptions and lists locations", () => {
	const prompt = formatChatSkillsForPrompt([
		{ name: "s3", description: "Use for <daily> standup & more", filePath: "/shared/skills/nesoft/s3/SKILL.md" },
	]);
	assert.match(prompt, /<name>s3<\/name>/);
	assert.match(prompt, /<description>Use for &lt;daily&gt; standup &amp; more<\/description>/);
	assert.match(prompt, /<location>\/shared\/skills\/nesoft\/s3\/SKILL\.md<\/location>/);
});
