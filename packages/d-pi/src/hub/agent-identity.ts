import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentConfig } from "../types.ts";

/**
 * Read `agent.json` from an agent's cwd and return the parsed
 * config, or `undefined` if the file does not exist or is not
 * valid JSON.
 *
 * Used by the worker at session-start to inject the agent's
 * identity (name, description, parent, model, roles, tool
 * allow/deny lists) into the system prompt as the
 * "## Agent identity" section.
 *
 * The worker is single-process and reads its own cwd's agent.json
 * (which the hub has just written before spawning the worker), so
 * this is a sync read. We do not validate the schema — invalid
 * JSON surfaces as a stderr warning + missing identity section
 * rather than as a hub start failure, so an experimental agent
 * with a broken agent.json does not block the rest of the
 * network.
 */
export function readAgentConfig(agentDir: string): AgentConfig | undefined {
	const configPath = join(agentDir, "agent.json");
	let raw: string;
	try {
		raw = readFileSync(configPath, "utf-8");
	} catch {
		return undefined;
	}
	try {
		return JSON.parse(raw) as AgentConfig;
	} catch {
		process.stderr.write(`[d-pi] Failed to parse agent.json at ${configPath}; skipping identity injection\n`);
		return undefined;
	}
}

/**
 * Read the per-agent `.d-pi-subscribed-events` allowlist file
 * from the agent's cwd. Returns the set of EventKey strings the
 * agent has opted into, or `null` if the file is absent (i.e.
 * the agent has no per-workspace opt-in and should fall back to
 * whatever is in `agent.json`, ultimately defaulting to
 * "subscribe to everything").
 *
 * File format: one EventKey per line. Blank lines and lines
 * starting with `#` are ignored. The literal `*` is permitted
 * for symmetry with `subscribedEvents: ["*"]` in agent.json —
 * it means "subscribe to everything" and is treated identically
 * to the file's absence.
 *
 * The file is intentionally a leading-dotfile at the workspace
 * scope (`agents/<name>/.d-pi-subscribed-events`) so the standard
 * workspace `.gitignore` (`agents/*`) keeps it out of any
 * outer git tree. Operators who want the rule to follow the
 * agent across machines and clones should put the list in
 * `agent.json`'s `subscribedEvents` field instead.
 *
 * Returns an empty Set (not null) if the file exists but is
 * empty or only contains comments — that's a deliberate "I want
 * zero events" opt-in, distinct from "I have no opt-in" (null).
 */
export function readSubscribedEventsFile(agentDir: string): Set<string> | null {
	const filePath = join(agentDir, ".d-pi-subscribed-events");
	let raw: string;
	try {
		raw = readFileSync(filePath, "utf-8");
	} catch {
		return null;
	}
	const events = new Set<string>();
	for (const line of raw.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (trimmed === "" || trimmed.startsWith("#")) continue;
		if (trimmed === "*") return new Set(["*"]);
		events.add(trimmed);
	}
	return events;
}

/**
 * Format a parsed `agent.json` as the "## Agent identity" section
 * that the worker appends to the agent's system prompt.
 *
 * The format is intentionally flat and key-value, not nested,
 * because every key is meant to be a single fact the LLM can
 * scan: who am I, what's my parent, what model do I run, what
 * tools can I reach, etc. We do not embed the entire JSON object
 * (which would be a maintenance liability if fields are renamed
 * or removed); we enumerate the known fields explicitly.
 *
 * Optional fields are omitted from the output entirely (rather
 * than rendered as `(unset)`) so the LLM doesn't learn false
 * defaults. `null`-valued fields (e.g. `parentName: null` for
 * the root agent) are also omitted — "I have no parent" is
 * implicit in the agent-tree, not a fact the LLM needs to know.
 */
export function formatAgentIdentitySection(config: AgentConfig): string {
	const lines: string[] = ["## Agent identity", ""];
	lines.push(`- name: \`${config.name}\``);

	if (config.description?.trim()) {
		lines.push("");
		lines.push(config.description.trim());
	}

	const meta: string[] = [];
	if (config.parentName) meta.push(`parent: \`${config.parentName}\``);
	if (config.roles && config.roles.length > 0) {
		meta.push(`roles: ${config.roles.map((r) => `\`${r}\``).join(", ")}`);
	}
	if (config.model) meta.push(`model: \`${config.model}\``);
	if (config.sessionId) meta.push(`sessionId: \`${config.sessionId}\``);
	if (config.includeTools && config.includeTools.length > 0) {
		meta.push(`includeTools: ${config.includeTools.map((t) => `\`${t}\``).join(", ")}`);
	} else if (config.excludeTools && config.excludeTools.length > 0) {
		meta.push(`excludeTools: ${config.excludeTools.map((t) => `\`${t}\``).join(", ")}`);
	}

	if (meta.length > 0) {
		lines.push("");
		lines.push("Metadata (for self-reference; do not mention in user-bound prose):");
		for (const m of meta) lines.push(`- ${m}`);
	}

	return lines.join("\n");
}
