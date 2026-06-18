import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadWorkspaceContext } from "../src/workspace/workspace.ts";

let tmpRoot: string | undefined;

function createWorkspace(): string {
	tmpRoot = mkdtempSync(join(tmpdir(), "d-pi-architecture-"));
	return tmpRoot;
}

function touch(path: string): void {
	mkdirSync(path, { recursive: true });
}

function write(path: string, content: string): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, content);
}

describe("team-template workspace context", () => {
	afterEach(() => {
		if (tmpRoot) {
			rmSync(tmpRoot, { recursive: true, force: true });
			tmpRoot = undefined;
		}
	});

	it("loads only workspace-level team-template resources and skips role resources", () => {
		const workspaceRoot = createWorkspace();
		write(join(workspaceRoot, "team-template", "AGENTS.md"), "architecture global");
		touch(join(workspaceRoot, "team-template", "skills"));
		write(join(workspaceRoot, "team-template", "extensions", "architecture.js"), "export default function() {}");
		write(join(workspaceRoot, "team-template", "roles", "root", "AGENTS.md"), "root role");
		touch(join(workspaceRoot, "team-template", "roles", "root", "skills"));
		write(
			join(workspaceRoot, "team-template", "roles", "root", "extensions", "root.js"),
			"export default function() {}",
		);
		write(join(workspaceRoot, "team-template", "roles", "frontend", "AGENTS.md"), "frontend role");
		touch(join(workspaceRoot, "team-template", "roles", "frontend", "skills"));
		write(
			join(workspaceRoot, "team-template", "roles", "frontend", "extensions", "frontend.js"),
			"export default function() {}",
		);
		touch(join(workspaceRoot, "skills"));
		write(join(workspaceRoot, "extensions", "workspace.js"), "export default function() {}");

		const context = loadWorkspaceContext(workspaceRoot, { agentName: "root", roles: ["frontend"] });

		expect(context.additionalAgentsFiles).toEqual([
			{ path: join(workspaceRoot, "team-template", "AGENTS.md"), content: "architecture global" },
		]);
		expect(context.additionalSkillPaths).toEqual([
			join(workspaceRoot, "team-template", "skills"),
			join(workspaceRoot, "skills"),
		]);
		expect(context.additionalExtensionPaths).toEqual([
			join(workspaceRoot, "team-template", "extensions", "architecture.js"),
			join(workspaceRoot, "extensions", "workspace.js"),
		]);
	});

	it("ignores explicit roles for runtime resource loading", () => {
		const workspaceRoot = createWorkspace();
		write(join(workspaceRoot, "team-template", "roles", "root", "AGENTS.md"), "root role");
		write(join(workspaceRoot, "team-template", "roles", "reviewer", "AGENTS.md"), "reviewer role");

		const context = loadWorkspaceContext(workspaceRoot, { agentName: "worker", roles: ["reviewer"] });

		expect(context.additionalAgentsFiles).toEqual([]);
		expect(context.additionalSkillPaths).toEqual([]);
		expect(context.additionalExtensionPaths).toEqual([]);
	});

	it("does not require an implicit root role to exist", () => {
		const workspaceRoot = createWorkspace();
		write(join(workspaceRoot, "team-template", "AGENTS.md"), "architecture global");

		const context = loadWorkspaceContext(workspaceRoot, { agentName: "root" });

		expect(context.additionalAgentsFiles).toEqual([
			{ path: join(workspaceRoot, "team-template", "AGENTS.md"), content: "architecture global" },
		]);
	});

	it("does not fail when an agent declares an unknown role because roles are metadata-only", () => {
		const workspaceRoot = createWorkspace();
		touch(join(workspaceRoot, "team-template", "roles", "known"));

		expect(() => loadWorkspaceContext(workspaceRoot, { agentName: "worker", roles: ["missing"] })).not.toThrow();
	});
});
