import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { getChildAgentSessionFile } from "../../src/hub/agents/child-agent-layout.js";
import { runExport } from "../../src/hub/commands/export.js";
import { runImport } from "../../src/hub/commands/import.js";
import { getAgentsConfigPath, getSessionFile } from "../../src/hub/config.js";
import { exportWorkspaceArchive, importWorkspaceArchive, initializeWorkspace } from "../../src/hub/workspace.js";

function createTempWorkspace(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

function cleanup(path: string): void {
	rmSync(path, { recursive: true, force: true });
}

function writeSingleFileTar(path: string, entryName: string, content: string): void {
	const body = Buffer.from(content);
	const header = Buffer.alloc(512);
	header.write(entryName, 0, 100, "utf8");
	header.write("0000644\0 ", 100, 8, "ascii");
	header.write("0000000\0 ", 108, 8, "ascii");
	header.write("0000000\0 ", 116, 8, "ascii");
	header.write(`${body.byteLength.toString(8).padStart(10, "0")}\0 `, 124, 12, "ascii");
	header.write("0000000000\0 ", 136, 12, "ascii");
	header.fill(0x20, 148, 156);
	header.write("0", 156, 1, "ascii");
	header.write("ustar", 257, 6, "ascii");
	header.write("00", 263, 2, "ascii");
	let checksum = 0;
	for (const byte of header) {
		checksum += byte;
	}
	header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
	const padding = Buffer.alloc((512 - (body.byteLength % 512)) % 512);
	writeFileSync(path, Buffer.concat([header, body, padding, Buffer.alloc(1024)]));
}

describe("workspace archive", () => {
	it("exports and imports .pi-hub and .pi as a single tar archive", () => {
		const source = createTempWorkspace("pi-hub-export-source-");
		const target = createTempWorkspace("pi-hub-export-target-");
		const archive = join(tmpdir(), `pi-hub-workspace-${Date.now()}.tar`);
		try {
			initializeWorkspace(source);
			mkdirSync(join(source, ".pi", "skills", "demo"), { recursive: true });
			writeFileSync(join(source, ".pi", "sources.json"), '{"sources":[]}\n', "utf8");
			writeFileSync(join(source, ".pi", "skills", "demo", "SKILL.md"), "# Demo\n", "utf8");
			mkdirSync(join(source, ".pi-hub", "agents"), { recursive: true });
			writeFileSync(join(source, ".pi-hub", "agents", "child-a.jsonl"), '{"type":"session"}\n', "utf8");

			const exported = exportWorkspaceArchive(archive, source);
			const imported = importWorkspaceArchive(archive, target);

			expect(exported.archivePath).toBe(archive);
			expect(imported.archivePath).toBe(archive);
			expect(readFileSync(join(target, ".pi", "sources.json"), "utf8")).toBe('{"sources":[]}\n');
			expect(readFileSync(join(target, ".pi", "skills", "demo", "SKILL.md"), "utf8")).toBe("# Demo\n");
			expect(readFileSync(join(target, ".pi-hub", "agents", "child-a.jsonl"), "utf8")).toBe('{"type":"session"}\n');
			expect(existsSync(join(target, ".pi-hub", "session.jsonl"))).toBe(true);
		} finally {
			cleanup(source);
			cleanup(target);
			rmSync(archive, { force: true });
		}
	});

	it("imports session history with local sessionFile paths on a different machine", () => {
		const source = createTempWorkspace("pi-hub-import-path-source-");
		const target = createTempWorkspace("pi-hub-import-path-target-");
		const archive = join(tmpdir(), `pi-hub-import-path-${Date.now()}.tar`);
		try {
			initializeWorkspace(source);
			writeFileSync(
				getSessionFile(source),
				'{"type":"session","id":"root-session"}\n{"role":"user","content":"root history"}\n',
			);
			mkdirSync(join(source, ".pi"), { recursive: true });
			mkdirSync(join(source, ".child-agent", "child-a"), { recursive: true });
			writeFileSync(getChildAgentSessionFile(source, "child-a"), '{"type":"session","id":"child-session"}\n');
			writeFileSync(
				getAgentsConfigPath(source),
				`${JSON.stringify(
					{
						version: 2,
						agents: [
							{
								id: "root",
								kind: "root",
								sessionFile: getSessionFile(source),
								createdAt: new Date(0).toISOString(),
								lifecycle: "persistent",
							},
							{
								id: "child-a",
								kind: "child",
								parentId: "root",
								sessionFile: getChildAgentSessionFile(source, "child-a"),
								createdAt: new Date(0).toISOString(),
								lifecycle: "persistent",
							},
						],
					},
					null,
					2,
				)}\n`,
			);

			const exported = exportWorkspaceArchive(archive, source);
			const imported = importWorkspaceArchive(archive, target);
			const importedAgents = JSON.parse(readFileSync(getAgentsConfigPath(target), "utf8")) as {
				agents: Array<{ id: string; sessionFile: string }>;
			};

			expect(exported.includedRoots).toContain(".child-agent");
			expect(imported.includedRoots).toContain(".child-agent");
			expect(importedAgents.agents.find((agent) => agent.id === "root")?.sessionFile).toBe(getSessionFile(target));
			expect(importedAgents.agents.find((agent) => agent.id === "child-a")?.sessionFile).toBe(
				getChildAgentSessionFile(target, "child-a"),
			);
			expect(readFileSync(getSessionFile(target), "utf8")).toContain("root history");
			expect(readFileSync(getChildAgentSessionFile(target, "child-a"), "utf8")).toContain("child-session");
		} finally {
			cleanup(source);
			cleanup(target);
			rmSync(archive, { force: true });
		}
	});

	it("refuses to import over an existing workspace unless force is set", () => {
		const source = createTempWorkspace("pi-hub-force-source-");
		const target = createTempWorkspace("pi-hub-force-target-");
		const archive = join(tmpdir(), `pi-hub-force-${Date.now()}.tar`);
		try {
			initializeWorkspace(source);
			exportWorkspaceArchive(archive, source);
			mkdirSync(join(target, ".pi"), { recursive: true });
			writeFileSync(join(target, ".pi", "sources.json"), '{"old":true}\n', "utf8");

			expect(() => importWorkspaceArchive(archive, target)).toThrow(/already exists/);
			importWorkspaceArchive(archive, target, { force: true });
			expect(readFileSync(join(target, ".pi-hub", "session.jsonl"), "utf8")).toContain('"type":"session"');
			expect(existsSync(join(target, ".pi", "sources.json"))).toBe(false);
		} finally {
			cleanup(source);
			cleanup(target);
			rmSync(archive, { force: true });
		}
	});

	it("wires export and import commands with --force", () => {
		const source = createTempWorkspace("pi-hub-cli-export-source-");
		const target = createTempWorkspace("pi-hub-cli-export-target-");
		const archive = join(tmpdir(), `pi-hub-cli-${Date.now()}.tar`);
		try {
			initializeWorkspace(source);
			mkdirSync(join(source, ".pi"), { recursive: true });
			writeFileSync(join(source, ".pi", "agents.json"), '{"agents":[]}\n', "utf8");
			mkdirSync(join(target, ".pi-hub"), { recursive: true });

			expect(runExport([archive], source)).toBe(0);
			expect(() => runImport([archive], target)).toThrow(/already exists/);
			expect(runImport([archive, "--force"], target)).toBe(0);
			expect(readFileSync(join(target, ".pi", "agents.json"), "utf8")).toBe('{"agents":[]}\n');
		} finally {
			cleanup(source);
			cleanup(target);
			rmSync(archive, { force: true });
		}
	});

	it("rejects tar entries outside .pi-hub and .pi", () => {
		const target = createTempWorkspace("pi-hub-malicious-target-");
		const archive = join(tmpdir(), `pi-hub-malicious-${Date.now()}.tar`);
		try {
			writeSingleFileTar(archive, "../evil.txt", "owned");

			expect(() => importWorkspaceArchive(archive, target)).toThrow(/outside supported workspace roots/);
			expect(existsSync(join(target, "evil.txt"))).toBe(false);
		} finally {
			cleanup(target);
			rmSync(archive, { force: true });
		}
	});

	it("prints command-specific archive help", () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		try {
			expect(runExport(["--help"])).toBe(0);
			expect(runImport(["--help"])).toBe(0);
			const output = log.mock.calls.map((call) => call.join(" ")).join("\n");
			expect(output).toContain("Usage: d-pi hub export <archive.tar>");
			expect(output).toContain("Included workspace roots:");
			expect(output).toContain("Usage: d-pi hub import <archive.tar> [--force]");
			expect(output).toContain("Use --force to replace existing workspace state.");
		} finally {
			log.mockRestore();
		}
	});
});
