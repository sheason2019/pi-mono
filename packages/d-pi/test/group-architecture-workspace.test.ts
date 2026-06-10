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

describe("group-architecture workspace context", () => {
	afterEach(() => {
		if (tmpRoot) {
			rmSync(tmpRoot, { recursive: true, force: true });
			tmpRoot = undefined;
		}
	});

	it("loads architecture global, root role, explicit roles, then workspace-local resources for root agents", () => {
		const workspaceRoot = createWorkspace();
		write(join(workspaceRoot, "group-architecture", "AGENTS.md"), "architecture global");
		touch(join(workspaceRoot, "group-architecture", "skills"));
		write(
			join(workspaceRoot, "group-architecture", "extensions", "architecture.js"),
			"export default function() {}",
		);
		write(join(workspaceRoot, "group-architecture", "roles", "root", "AGENTS.md"), "root role");
		touch(join(workspaceRoot, "group-architecture", "roles", "root", "skills"));
		write(
			join(workspaceRoot, "group-architecture", "roles", "root", "extensions", "root.js"),
			"export default function() {}",
		);
		write(join(workspaceRoot, "group-architecture", "roles", "frontend", "AGENTS.md"), "frontend role");
		touch(join(workspaceRoot, "group-architecture", "roles", "frontend", "skills"));
		write(
			join(workspaceRoot, "group-architecture", "roles", "frontend", "extensions", "frontend.js"),
			"export default function() {}",
		);
		touch(join(workspaceRoot, "skills"));
		write(join(workspaceRoot, "extensions", "workspace.js"), "export default function() {}");

		const context = loadWorkspaceContext(workspaceRoot, { agentName: "root", roles: ["frontend"] });

		expect(context.additionalAgentsFiles).toEqual([
			{ path: join(workspaceRoot, "group-architecture", "AGENTS.md"), content: "architecture global" },
			{ path: join(workspaceRoot, "group-architecture", "roles", "root", "AGENTS.md"), content: "root role" },
			{
				path: join(workspaceRoot, "group-architecture", "roles", "frontend", "AGENTS.md"),
				content: "frontend role",
			},
		]);
		expect(context.additionalSkillPaths).toEqual([
			join(workspaceRoot, "group-architecture", "skills"),
			join(workspaceRoot, "group-architecture", "roles", "root", "skills"),
			join(workspaceRoot, "group-architecture", "roles", "frontend", "skills"),
			join(workspaceRoot, "skills"),
		]);
		expect(context.additionalExtensionPaths).toEqual([
			join(workspaceRoot, "group-architecture", "extensions", "architecture.js"),
			join(workspaceRoot, "group-architecture", "roles", "root", "extensions", "root.js"),
			join(workspaceRoot, "group-architecture", "roles", "frontend", "extensions", "frontend.js"),
			join(workspaceRoot, "extensions", "workspace.js"),
		]);
	});

	it("does not apply the root role to non-root agents unless explicitly requested", () => {
		const workspaceRoot = createWorkspace();
		write(join(workspaceRoot, "group-architecture", "roles", "root", "AGENTS.md"), "root role");
		write(join(workspaceRoot, "group-architecture", "roles", "reviewer", "AGENTS.md"), "reviewer role");

		const context = loadWorkspaceContext(workspaceRoot, { agentName: "worker", roles: ["reviewer"] });

		expect(context.additionalAgentsFiles).toEqual([
			{
				path: join(workspaceRoot, "group-architecture", "roles", "reviewer", "AGENTS.md"),
				content: "reviewer role",
			},
		]);
	});

	it("does not require an implicit root role to exist", () => {
		const workspaceRoot = createWorkspace();
		write(join(workspaceRoot, "group-architecture", "AGENTS.md"), "architecture global");

		const context = loadWorkspaceContext(workspaceRoot, { agentName: "root" });

		expect(context.additionalAgentsFiles).toEqual([
			{ path: join(workspaceRoot, "group-architecture", "AGENTS.md"), content: "architecture global" },
		]);
	});

	it("fails when an agent declares an unknown role", () => {
		const workspaceRoot = createWorkspace();
		touch(join(workspaceRoot, "group-architecture", "roles", "known"));

		expect(() => loadWorkspaceContext(workspaceRoot, { agentName: "worker", roles: ["missing"] })).toThrow(
			`Unknown agent role "missing": ${join(workspaceRoot, "group-architecture", "roles", "missing")}`,
		);
	});
});