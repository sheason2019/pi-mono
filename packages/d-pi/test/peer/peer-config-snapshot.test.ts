import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectPeerConfigSnapshot } from "../../src/peer/config/peer-config-snapshot.js";

const tempDirs: string[] = [];

function writeJson(path: string, value: unknown): void {
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("collectPeerConfigSnapshot", () => {
	it("collects peer global and cwd Pi config including auth and context files", () => {
		const cwd = mkdtempSync(join(tmpdir(), "peer-config-cwd-"));
		const agentDir = mkdtempSync(join(tmpdir(), "peer-config-agent-"));
		const globalDir = mkdtempSync(join(tmpdir(), "peer-config-global-"));
		tempDirs.push(cwd, agentDir, globalDir);
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeJson(join(agentDir, "auth.json"), { demo: { type: "api_key", key: "secret" } });
		writeJson(join(agentDir, "models.json"), { providers: { globalOnly: { models: [{ id: "g" }] } } });
		writeJson(join(agentDir, "settings.json"), { defaultProvider: "globalOnly" });
		writeJson(join(globalDir, "mcp.json"), {
			servers: [{ name: "global-mcp", transport: "stdio", command: "node" }],
		});
		writeFileSync(join(agentDir, "AGENTS.md"), "global context", "utf8");
		mkdirSync(join(globalDir, "skills", "global-skill"), { recursive: true });
		writeFileSync(
			join(globalDir, "skills", "global-skill", "SKILL.md"),
			"---\nname: global-skill\ndescription: global skill\n---\n\nUse global skill.",
			"utf8",
		);
		writeJson(join(cwd, ".pi", "models.json"), { providers: { cwdOnly: { models: [{ id: "c" }] } } });
		writeJson(join(cwd, ".pi", "settings.json"), { defaultModel: "c" });
		writeJson(join(cwd, ".pi", "mcp.json"), { servers: [{ name: "cwd-mcp", transport: "stdio", command: "node" }] });
		writeFileSync(join(cwd, "AGENTS.md"), "cwd context", "utf8");

		const snapshot = collectPeerConfigSnapshot({ cwd, agentDir, globalDir, now: () => "2026-04-26T04:00:00.000Z" });

		expect(snapshot.cwd).toBe(cwd);
		expect(snapshot.global?.auth?.demo?.type).toBe("api_key");
		expect(snapshot.global?.models).toMatchObject({ providers: { globalOnly: expect.any(Object) } });
		expect(snapshot.global?.settings).toMatchObject({ defaultProvider: "globalOnly" });
		expect(snapshot.global?.mcp).toMatchObject({ servers: [expect.objectContaining({ name: "global-mcp" })] });
		expect(snapshot.global?.skills).toEqual([
			expect.objectContaining({ name: "global-skill", content: expect.stringContaining("Use global skill.") }),
		]);
		expect(snapshot.cwdLayer?.models).toMatchObject({ providers: { cwdOnly: expect.any(Object) } });
		expect(snapshot.cwdLayer?.settings).toMatchObject({ defaultModel: "c" });
		expect(snapshot.cwdLayer?.mcp).toMatchObject({ servers: [expect.objectContaining({ name: "cwd-mcp" })] });
		const context = [...(snapshot.global?.contextFiles ?? []), ...(snapshot.cwdLayer?.contextFiles ?? [])];
		expect(context.map((file) => file.content)).toContain("global context");
		expect(context.map((file) => file.content)).toContain("cwd context");
	});
});
