import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatAgentIdentitySection, loadAgentIdentity } from "../src/hub/agent-identity.ts";
import type { AgentConfig } from "../src/types.ts";

/**
 * Tests for the agent.ts → system-prompt bridge. The worker
 * reads its own cwd/agent.ts at session start and inlines the
 * parsed config as a "## Agent identity" section in the system
 * prompt so the LLM has a self-description to coordinate with
 * peers. These tests cover the pure read + format path; the
 * worker wiring is exercised by the integration test in
 * `hub-restore-order.test.ts` (same worker instance, same
 * fs read).
 */

let tempDir: string | undefined;

function freshWorkspace(): string {
	tempDir = mkdtempSync(join(tmpdir(), "d-pi-agent-identity-"));
	return tempDir;
}

function writeAgentTs(workspace: string, entryName: string, config: AgentConfig, parentImportName?: string): void {
	const dir = join(workspace, "agents", entryName);
	mkdirSync(dir, { recursive: true });
	const lines = [
		`import { createDispatchBashTool, createDispatchReadTool, defineAgent, defineContextFile, defineModel, defineSkill } from ${JSON.stringify(pathToFileURL(join(process.cwd(), "src", "index.ts")).href)};`,
	];
	if (parentImportName) {
		lines.push(`import parentAgent from "../${parentImportName}/agent.ts";`);
	}
	lines.push("");
	lines.push("export default defineAgent({");
	if (parentImportName) {
		lines.push("\tparent: parentAgent,");
	}
	if (config.description !== undefined) {
		lines.push(`\tdescription: ${JSON.stringify(config.description)},`);
	}
	if (config.roles && config.roles.length > 0) {
		lines.push(`\troles: ${JSON.stringify(config.roles)},`);
	}
	if (config.model) {
		const slashIndex = config.model.indexOf("/");
		const provider = slashIndex === -1 ? "unknown" : config.model.slice(0, slashIndex);
		const name = slashIndex === -1 ? config.model : config.model.slice(slashIndex + 1);
		lines.push(`\tmodel: defineModel({ provider: ${JSON.stringify(provider)}, name: ${JSON.stringify(name)} }),`);
	}
	lines.push('\tskills: defineSkill({ dir: "./skills" }),');
	lines.push("\ttools: [");
	const toolNames =
		config.includeTools && config.includeTools.length > 0
			? config.includeTools
			: config.excludeTools && config.excludeTools.length > 0
				? ["dispatch_read"]
				: ["dispatch_read", "dispatch_bash"];
	for (const toolName of toolNames) {
		lines.push(
			`\t\t${toolName === "dispatch_bash" || toolName === "bash" ? "createDispatchBashTool" : "createDispatchReadTool"}(),`,
		);
	}
	lines.push("\t],");
	lines.push("\tcontextFiles: [");
	lines.push('\t\tdefineContextFile({ type: "context", path: "./AGENTS.md" }),');
	lines.push('\t\tdefineContextFile({ type: "append_system", path: "./.pi/APPEND_SYSTEM.md" }),');
	lines.push("\t],");
	lines.push("});");
	lines.push("");
	writeFileSync(join(dir, "agent.ts"), lines.join("\n"));
}

afterEach(() => {
	if (tempDir) {
		rmSync(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	}
});

describe("loadAgentIdentity", () => {
	it("returns normalized identity for a valid agent.ts", async () => {
		const workspace = freshWorkspace();
		writeAgentTs(workspace, "root", {
			name: "root",
			parentName: undefined,
			description: "Top-level orchestrator",
		});

		const config = await loadAgentIdentity(join(workspace, "agents", "root"));
		expect(config).toBeDefined();
		expect(config?.name).toBe("root");
		expect(config?.description).toBe("Top-level orchestrator");
	});

	it("returns undefined when agent.ts is missing", async () => {
		const workspace = freshWorkspace();
		mkdirSync(join(workspace, "agents", "lonely"), { recursive: true });
		await expect(loadAgentIdentity(join(workspace, "agents", "lonely"))).resolves.toBeUndefined();
	});

	it("returns undefined and warns (but does not throw) when agent.ts is corrupt", async () => {
		const workspace = freshWorkspace();
		const dir = join(workspace, "agents", "broken");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "agent.ts"), "export default {");

		const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		try {
			const config = await loadAgentIdentity(dir);
			expect(config).toBeUndefined();
			const warned = stderrSpy.mock.calls.some((call) => String(call[0]).includes("Failed to load agent.ts"));
			expect(warned).toBe(true);
		} finally {
			stderrSpy.mockRestore();
		}
	});

	it("normalizes parentName from the imported parent definition", async () => {
		const workspace = freshWorkspace();
		writeAgentTs(workspace, "root", { name: "wrong-root", parentName: undefined });
		writeAgentTs(
			workspace,
			"child",
			{
				name: "wrong-child",
				parentName: "wrong-parent",
				description: "A child agent.",
				roles: ["writer", "reviewer"],
				model: "anthropic/claude-sonnet-4",
				includeTools: ["read", "bash"],
			},
			"root",
		);

		const config = await loadAgentIdentity(join(workspace, "agents", "child"));
		expect(config).toEqual({
			name: "child",
			parentName: "root",
			description: "A child agent.",
			roles: ["writer", "reviewer"],
			model: "anthropic/claude-sonnet-4",
			includeTools: ["dispatch_read", "dispatch_bash"],
		});
	});
});

describe("formatAgentIdentitySection", () => {
	it("always emits the section header and the agent name", () => {
		const section = formatAgentIdentitySection({ name: "root", parentName: undefined });
		expect(section).toMatch(/^## Agent identity\n/);
		expect(section).toContain("name: `root`");
	});

	it("inlines the description prose (trimmed) when present and non-empty", () => {
		const section = formatAgentIdentitySection({
			name: "router",
			parentName: "root",
			description: "  Routes Lark messages to children.  \n",
		});
		// The trimmed prose is rendered as a paragraph between the
		// name line and the metadata block.
		expect(section).toContain("Routes Lark messages to children.");
		expect(section).not.toMatch(/^ +Routes/); // not indented
	});

	it("omits the description paragraph when the field is missing or empty/whitespace", () => {
		const missing = formatAgentIdentitySection({ name: "root", parentName: undefined });
		const empty = formatAgentIdentitySection({
			name: "root",
			parentName: undefined,
			description: "   \n  ",
		});
		// Neither should have a body paragraph — just the name line
		// and (maybe) metadata.
		const bodyLines = missing.split("\n").filter((line) => line && !line.startsWith("- ") && !line.startsWith("## "));
		expect(bodyLines).toHaveLength(0);

		const emptyBodyLines = empty
			.split("\n")
			.filter((line) => line && !line.startsWith("- ") && !line.startsWith("## "));
		expect(emptyBodyLines).toHaveLength(0);
	});

	it("emits all optional metadata fields when set", () => {
		const section = formatAgentIdentitySection({
			name: "child",
			parentName: "root",
			description: "A child agent.",
			roles: ["writer", "reviewer"],
			model: "anthropic/claude-sonnet-4",
			includeTools: ["read", "bash"],
		});
		expect(section).toContain("parent: `root`");
		expect(section).toContain("roles: `writer`, `reviewer`");
		expect(section).toContain("model: `anthropic/claude-sonnet-4`");
		expect(section).toContain("includeTools: `read`, `bash`");
		expect(section).not.toContain("excludeTools");
	});

	it("emits excludeTools when includeTools is absent", () => {
		const section = formatAgentIdentitySection({
			name: "auditor",
			parentName: "root",
			excludeTools: ["write", "edit", "bash"],
		});
		expect(section).toContain("excludeTools: `write`, `edit`, `bash`");
		expect(section).not.toContain("includeTools");
	});

	it("omits parentName when null (root agent case)", () => {
		const section = formatAgentIdentitySection({ name: "root", parentName: undefined });
		expect(section).not.toMatch(/parent:/);
	});

	it("omits empty arrays (zero-role, zero-include, zero-exclude) rather than rendering empty lists", () => {
		const section = formatAgentIdentitySection({
			name: "minimal",
			parentName: undefined,
			roles: [],
			includeTools: [],
			excludeTools: [],
		});
		expect(section).not.toMatch(/roles:/);
		expect(section).not.toMatch(/includeTools:/);
		expect(section).not.toMatch(/excludeTools:/);
	});
});
