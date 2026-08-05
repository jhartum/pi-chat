import { type Dirent, constants as fsConstants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative } from "node:path";
import { parseFrontmatter } from "@mariozechner/pi-coding-agent";

export interface ChatPromptSkill {
	name: string;
	description: string;
	filePath: string;
}

function isInsideHostPath(root: string, value: string): boolean {
	const rel = relative(root, value);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function escapeXml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

export async function safeReadMountedText(root: string, filePath: string): Promise<string> {
	try {
		const realRoot = await realpath(root);
		const resolvedPath = await realpath(filePath);
		if (!isInsideHostPath(realRoot, resolvedPath)) return "";
		const handle = await open(resolvedPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
		try {
			const info = await handle.stat();
			if (!info.isFile()) return "";
			return await handle.readFile("utf8");
		} finally {
			await handle.close();
		}
	} catch {
		return "";
	}
}

/**
 * Parse a skill's YAML frontmatter. Delegates to the pi runtime's frontmatter
 * parser, which understands real YAML (folded scalars, quoted values, booleans).
 * The previous hand-rolled line parser treated the folded-scalar indicator of
 * `description: >-` as the description itself, hiding multi-line skill
 * descriptions from the model's skill list.
 */
export function parseSkillFrontmatter(content: string): {
	name?: string;
	description?: string;
	disabled?: boolean;
} {
	const { frontmatter } = parseFrontmatter(content);
	const name = typeof frontmatter.name === "string" ? frontmatter.name : undefined;
	const description = typeof frontmatter.description === "string" ? frontmatter.description : undefined;
	const disabled = frontmatter["disable-model-invocation"] === true;
	return { name, description, disabled };
}

export async function loadSafeChatSkills(root: string): Promise<ChatPromptSkill[]> {
	const skillsRoot = join(root, "skills");
	const skills: ChatPromptSkill[] = [];
	async function addSkill(filePath: string, defaultName: string): Promise<void> {
		const content = await safeReadMountedText(root, filePath);
		const frontmatter = parseSkillFrontmatter(content);
		if (!frontmatter.description?.trim() || frontmatter.disabled) return;
		skills.push({ name: frontmatter.name || defaultName, description: frontmatter.description, filePath });
	}
	async function walkSkills(dir: string, depth: number): Promise<void> {
		if (depth > 8) return;
		let entries: Dirent<string>[];
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.isSymbolicLink()) continue;
			const fullPath = join(dir, entry.name);
			if (entry.isFile() && extname(entry.name).toLowerCase() === ".md") {
				await addSkill(fullPath, basename(entry.name, ".md"));
				continue;
			}
			if (!entry.isDirectory()) continue;
			const skillMd = join(fullPath, "SKILL.md");
			try {
				const info = await lstat(skillMd);
				if (info.isFile()) {
					await addSkill(skillMd, entry.name);
					continue;
				}
			} catch {
				// Not a skill root; recurse below.
			}
			await walkSkills(fullPath, depth + 1);
		}
	}
	await walkSkills(skillsRoot, 0);
	return skills;
}

export function formatChatSkillsForPrompt(skills: ChatPromptSkill[]): string {
	if (skills.length === 0) return "";
	const lines = [
		"\n\nThe following skills provide specialized instructions for specific tasks.",
		"Use the read tool to load a skill's file when the task matches its description.",
		"When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
		"",
		"<available_skills>",
	];
	for (const skill of skills) {
		lines.push("  <skill>");
		lines.push(`    <name>${escapeXml(skill.name)}</name>`);
		lines.push(`    <description>${escapeXml(skill.description)}</description>`);
		lines.push(`    <location>${escapeXml(skill.filePath)}</location>`);
		lines.push("  </skill>");
	}
	lines.push("</available_skills>");
	return lines.join("\n");
}
