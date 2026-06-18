import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { migrateWorkspace } from "../src/workspace/workspace.ts";

let tempDir: string | undefined;

interface PersistedAgentConfig {
	name: string;
	parentName: string | null;
	description?: string;
	roles?: string[];
	model?: string;
	includeTools?: string[];
	excludeTools?: string[];
}

function createTempDir(prefix: string): string {
	tempDir = mkdtempSync(join(tmpdir(), prefix));
	return tempDir;
}

function writeJson(path: string, value: object): void {
	writeFileSync(path, `${JSON.stringify(value, null, "\t")}\n`);
}

function writeWorkspaceConfig(workspaceRoot: string, version: number): void {
	mkdirSync(join(workspaceRoot, ".dpi"), { recursive: true });
	writeJson(join(workspaceRoot, ".dpi", "config.json"), { version });
}

function writeAgentConfig(workspaceRoot: string, agentName: string, config: PersistedAgentConfig): void {
	const agentDir = join(workspaceRoot, "agents", agentName);
	mkdirSync(agentDir, { recursive: true });
	writeJson(join(agentDir, "agent.json"), config);
}

function writeSessionFile(workspaceRoot: string, agentName: string, filename: string, content: string): void {
	const sessionDir = join(workspaceRoot, ".dpi-sessions", agentName);
	mkdirSync(sessionDir, { recursive: true });
	writeFileSync(join(sessionDir, filename), content);
}

function readWorkspaceVersion(workspaceRoot: string): number {
	const raw = readFileSync(join(workspaceRoot, ".dpi", "config.json"), "utf-8");
	return (JSON.parse(raw) as { version: number }).version;
}

describe("d-pi agent-ts migration", () => {
	afterEach(() => {
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = undefined;
		}
	});

	it("converts agent.json to agent.ts, moves sessions, and deletes old schema artifacts", () => {
		const workspaceRoot = createTempDir("d-pi-agent-ts-migrate-");
		writeWorkspaceConfig(workspaceRoot, 2);
		writeAgentConfig(workspaceRoot, "root", {
			name: "root",
			parentName: null,
			description: "Root coordinator",
			roles: ["root-role"],
			model: "anthropic/claude-sonnet-4",
			includeTools: ["dispatch_read", "team"],
		});
		writeAgentConfig(workspaceRoot, "reviewer", {
			name: "reviewer",
			parentName: "root",
			description: "Reviews changes",
			roles: ["reviewer"],
			excludeTools: ["dispatch_bash", "set_model"],
		});
		writeSessionFile(workspaceRoot, "root", "root-session.jsonl", "root session\n");
		writeSessionFile(workspaceRoot, "reviewer", "reviewer-session.jsonl", "reviewer session\n");

		const result = migrateWorkspace(workspaceRoot);

		expect(result.fromVersion).toBe(2);
		expect(result.toVersion).toBeGreaterThan(2);
		expect(readWorkspaceVersion(workspaceRoot)).toBe(result.toVersion);

		const rootAgentTs = readFileSync(join(workspaceRoot, "agents", "root", "agent.ts"), "utf-8");
		expect(rootAgentTs).toContain("defineAgent(");
		expect(rootAgentTs).toContain('defineModel({ provider: "anthropic", name: "claude-sonnet-4" })');
		expect(rootAgentTs).toContain('defineSkill({ dir: "./skills" })');
		expect(rootAgentTs).toContain('defineContextFile({ type: "context", path: "./AGENTS.md" })');
		expect(rootAgentTs).toContain('defineContextFile({ type: "append_system", path: "./.pi/APPEND_SYSTEM.md" })');
		expect(rootAgentTs).toContain('roles: ["root-role"]');
		expect(rootAgentTs).toContain('defineTool({ name: "dispatch_read" })');
		expect(rootAgentTs).toContain('defineTool({ name: "team" })');
		expect(rootAgentTs).not.toContain('defineTool({ name: "dispatch_bash" })');

		const reviewerAgentTs = readFileSync(join(workspaceRoot, "agents", "reviewer", "agent.ts"), "utf-8");
		expect(reviewerAgentTs).toContain('import parentAgent from "../root/agent.ts"');
		expect(reviewerAgentTs).toContain("parent: parentAgent");
		expect(reviewerAgentTs).toContain('roles: ["reviewer"]');
		expect(reviewerAgentTs).toContain('defineTool({ name: "team" })');
		expect(reviewerAgentTs).not.toContain('defineTool({ name: "dispatch_bash" })');
		expect(reviewerAgentTs).not.toContain('defineTool({ name: "set_model" })');

		expect(readFileSync(join(workspaceRoot, "agents", "root", "session", "root-session.jsonl"), "utf-8")).toBe(
			"root session\n",
		);
		expect(
			readFileSync(join(workspaceRoot, "agents", "reviewer", "session", "reviewer-session.jsonl"), "utf-8"),
		).toBe("reviewer session\n");

		expect(existsSync(join(workspaceRoot, "agents", "root", "agent.json"))).toBe(false);
		expect(existsSync(join(workspaceRoot, "agents", "reviewer", "agent.json"))).toBe(false);
		expect(existsSync(join(workspaceRoot, ".dpi-sessions"))).toBe(false);
	});

	it("throws when includeTools contains an unknown tool name", () => {
		const workspaceRoot = createTempDir("d-pi-agent-ts-migrate-unknown-include-");
		writeWorkspaceConfig(workspaceRoot, 2);
		writeAgentConfig(workspaceRoot, "root", {
			name: "root",
			parentName: null,
			includeTools: ["dispatch_read", "unknown_tool_name"],
		});

		expect(() => migrateWorkspace(workspaceRoot)).toThrow(/unknown tool name "unknown_tool_name"/i);
		expect(existsSync(join(workspaceRoot, "agents", "root", "agent.ts"))).toBe(false);
		expect(existsSync(join(workspaceRoot, "agents", "root", "agent.json"))).toBe(true);
	});

	it("throws when excludeTools contains an unknown tool name", () => {
		const workspaceRoot = createTempDir("d-pi-agent-ts-migrate-unknown-exclude-");
		writeWorkspaceConfig(workspaceRoot, 2);
		writeAgentConfig(workspaceRoot, "root", {
			name: "root",
			parentName: null,
			excludeTools: ["dispatch_bash", "missing_tool_name"],
		});

		expect(() => migrateWorkspace(workspaceRoot)).toThrow(/unknown tool name "missing_tool_name"/i);
		expect(existsSync(join(workspaceRoot, "agents", "root", "agent.ts"))).toBe(false);
		expect(existsSync(join(workspaceRoot, "agents", "root", "agent.json"))).toBe(true);
	});
});
