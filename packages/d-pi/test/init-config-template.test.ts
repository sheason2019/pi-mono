import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initWorkspace, validateWorkspace } from "../src/workspace/workspace.ts";

let tmpRoot: string | undefined;

function freshWorkspace(): string {
	tmpRoot = join(tmpdir(), `d-pi-init-config-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	return tmpRoot;
}

describe("init template: strict-JSON output", () => {
	afterEach(() => {
		if (tmpRoot) {
			rmSync(tmpRoot, { recursive: true, force: true });
			tmpRoot = undefined;
		}
	});

	it("writes .dpi/config.json that JSON.parse accepts (no JS comments)", () => {
		const workspace = freshWorkspace();
		initWorkspace(workspace);

		const configPath = join(workspace, ".dpi", "config.json");
		expect(existsSync(configPath)).toBe(true);

		const raw = readFileSync(configPath, "utf-8");
		// Sanity: no JS-style line comments and no trailing commas
		expect(raw).not.toMatch(/\/\//);
		expect(raw).not.toMatch(/,[\s\n]*[}\]]/);

		// The point of the regression: strict JSON.parse must accept the file.
		const parsed = JSON.parse(raw) as { version: number };
		expect(parsed.version).toBe(1);
	});

	it("writes agents/root/agent.json that JSON.parse accepts (no JS comments)", () => {
		const workspace = freshWorkspace();
		initWorkspace(workspace);

		const agentConfigPath = join(workspace, "agents", "root", "agent.json");
		expect(existsSync(agentConfigPath)).toBe(true);

		const raw = readFileSync(agentConfigPath, "utf-8");
		expect(raw).not.toMatch(/\/\//);
		expect(raw).not.toMatch(/,[\s\n]*[}\]]/);

		const parsed = JSON.parse(raw) as { name: string; parentName: string | null };
		expect(parsed.name).toBe("root");
		expect(parsed.parentName).toBeNull();
	});

	it("validateWorkspace accepts the freshly-init config and reports version 1", () => {
		const workspace = freshWorkspace();
		initWorkspace(workspace);

		const config = validateWorkspace(workspace);
		expect(config.version).toBe(1);
	});

	it("AGENTS.md template documents the optional workspace and agent config keys", () => {
		const workspace = freshWorkspace();
		initWorkspace(workspace);

		const agentsMd = readFileSync(join(workspace, "AGENTS.md"), "utf-8");
		// Workspace-level keys
		expect(agentsMd).toMatch(/version/);
		expect(agentsMd).toMatch(/defaultModel/);
		expect(agentsMd).toMatch(/excludeTools/);
		// Agent-level keys
		expect(agentsMd).toMatch(/parentName/);
		expect(agentsMd).toMatch(/sessionId/);
	});
});
