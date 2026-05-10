import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRegistry } from "../../src/hub/agents/agent-registry.js";
import { getChildAgentSessionFile } from "../../src/hub/agents/child-agent-layout.js";
import type { AgentRecord, AgentRegistryFile } from "../../src/hub/agents/types.js";
import { MAIN_AGENT_ID } from "../../src/hub/agents/types.js";
import { getAgentsConfigPath, getSessionFile } from "../../src/hub/config.js";

const tempDirs: string[] = [];

function writeJson(path: string, value: unknown): void {
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

describe("AgentRegistry", () => {
	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("creates default root and writes agents.json when file is missing", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-hub-agents-missing-"));
		tempDirs.push(cwd);
		const path = getAgentsConfigPath(cwd);
		expect(existsSync(path)).toBe(false);

		const reg = AgentRegistry.open(cwd);
		expect(existsSync(path)).toBe(true);
		const root = reg.get(MAIN_AGENT_ID);
		expect(root).toBeDefined();
		expect(root?.id).toBe(MAIN_AGENT_ID);
		expect(root?.kind).toBe("root");
		expect(root?.lifecycle).toBe("persistent");
		expect(root?.sessionFile).toBe(getSessionFile(cwd));
		const raw = JSON.parse(readFileSync(path, "utf8")) as AgentRegistryFile;
		expect(raw.version).toBe(2);
		expect(raw.agents).toHaveLength(1);
		expect(raw.agents[0]?.id).toBe(MAIN_AGENT_ID);
	});

	it("persists and reloads saved registry", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-hub-agents-reload-"));
		tempDirs.push(cwd);
		const s1 = AgentRegistry.open(cwd);
		const child = s1.createChild({
			parentId: MAIN_AGENT_ID,
			sessionFile: join(cwd, ".pi-hub", "agents", "c1.jsonl"),
			name: "Worker",
		});
		s1.update({ ...child, name: "Renamed" });
		s1.save();

		const s2 = AgentRegistry.open(cwd);
		const reloaded = s2.get(child.id);
		expect(reloaded?.name).toBe("Renamed");
	});

	it("rejects duplicate agent ids", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-hub-agents-dup-"));
		tempDirs.push(cwd);
		const reg = AgentRegistry.open(cwd);
		reg.createChild({ id: "helper", parentId: MAIN_AGENT_ID, sessionFile: join(cwd, "a.jsonl") });
		expect(() =>
			reg.createChild({ id: "helper", parentId: MAIN_AGENT_ID, sessionFile: join(cwd, "b.jsonl") }),
		).toThrow();
	});

	it("rejects an existing agents.json with duplicate agent ids on open", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-hub-agents-dup-on-disk-"));
		tempDirs.push(cwd);
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		const t = new Date(0).toISOString();
		const sf = getSessionFile(cwd);
		const dupFile = {
			version: 1 as const,
			agents: [
				{ id: MAIN_AGENT_ID, kind: "main" as const, sessionFile: sf, createdAt: t },
				{ id: "dup", kind: "child" as const, sessionFile: join(cwd, "a.jsonl"), createdAt: t },
				{ id: "dup", kind: "child" as const, sessionFile: join(cwd, "b.jsonl"), createdAt: t },
			],
		};
		writeJson(getAgentsConfigPath(cwd), dupFile);
		expect(() => AgentRegistry.open(cwd)).toThrow(/Duplicate agent id/);
	});

	it("migrates v1 main registry to v2 root tree", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-hub-agents-v1-migrate-"));
		tempDirs.push(cwd);
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		const t = new Date(0).toISOString();
		writeJson(getAgentsConfigPath(cwd), {
			version: 1,
			agents: [
				{ id: "main", kind: "main", sessionFile: getSessionFile(cwd), createdAt: t },
				{ id: "child-a", kind: "child", sessionFile: join(cwd, "child-a.jsonl"), createdAt: t, createdBy: "main" },
			],
		});

		const registry = AgentRegistry.open(cwd);
		const root = registry.require("root");
		const child = registry.require("child-a");
		expect(root.kind).toBe("root");
		expect(root.lifecycle).toBe("persistent");
		expect(registry.get("main")).toBeUndefined();
		expect(child.parentId).toBe("root");
		expect(child.createdBy).toBe("root");
		expect(child.lifecycle).toBe("persistent");
		const saved = JSON.parse(readFileSync(getAgentsConfigPath(cwd), "utf8")) as AgentRegistryFile;
		expect(saved.version).toBe(2);
		expect(saved.agents.map((agent) => agent.id).sort()).toEqual(["child-a", "root"]);
	});

	it("rejects invalid registry: main is required and cannot be a child", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-hub-agents-badmain-"));
		tempDirs.push(cwd);
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		const bad1: AgentRegistryFile = { version: 2, agents: [] };
		writeJson(getAgentsConfigPath(cwd), bad1);
		expect(() => AgentRegistry.open(cwd)).toThrow();

		const cwd2 = mkdtempSync(join(tmpdir(), "pi-hub-agents-badmain2-"));
		tempDirs.push(cwd2);
		mkdirSync(join(cwd2, ".pi"), { recursive: true });
		const bad2: AgentRegistryFile = {
			version: 2,
			agents: [
				{
					id: MAIN_AGENT_ID,
					kind: "child",
					sessionFile: getSessionFile(cwd2),
					createdAt: new Date(0).toISOString(),
					parentId: MAIN_AGENT_ID,
					lifecycle: "persistent",
				},
			],
		};
		writeJson(getAgentsConfigPath(cwd2), bad2);
		expect(() => AgentRegistry.open(cwd2)).toThrow();
	});

	it("rejects child records with empty sessionFile on load and on create", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-hub-agents-empty-sf-"));
		tempDirs.push(cwd);
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		const file: AgentRegistryFile = {
			version: 2,
			agents: [
				{
					id: MAIN_AGENT_ID,
					kind: "root",
					sessionFile: getSessionFile(cwd),
					createdAt: new Date(0).toISOString(),
					lifecycle: "persistent",
				},
				{
					id: "x",
					kind: "child",
					parentId: MAIN_AGENT_ID,
					sessionFile: "  ",
					createdAt: new Date(0).toISOString(),
					lifecycle: "persistent",
				},
			],
		};
		writeJson(getAgentsConfigPath(cwd), file);
		expect(() => AgentRegistry.open(cwd)).toThrow();

		const cwd2 = mkdtempSync(join(tmpdir(), "pi-hub-agents-empty-sf2-"));
		tempDirs.push(cwd2);
		const r = AgentRegistry.open(cwd2);
		expect(() => r.createChild({ parentId: MAIN_AGENT_ID, sessionFile: "" })).toThrow();
		expect(() => r.createChild({ parentId: MAIN_AGENT_ID, sessionFile: "   " })).toThrow();
	});

	it("generates unique sanitized child ids", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-hub-agents-ids-"));
		tempDirs.push(cwd);
		const r = AgentRegistry.open(cwd);
		const a = r.createChild({ parentId: MAIN_AGENT_ID, name: "Weird Name!", sessionFile: join(cwd, "1.jsonl") });
		const b = r.createChild({ parentId: MAIN_AGENT_ID, name: "Weird Name!", sessionFile: join(cwd, "2.jsonl") });
		const c = r.createChild({ parentId: MAIN_AGENT_ID, sessionFile: join(cwd, "3.jsonl") });
		const ids = [a.id, b.id, c.id];
		expect(new Set(ids).size).toBe(3);
		for (const id of ids) {
			expect(id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
		}
	});

	it("resolves new child session paths under .child-agent", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-hub-agents-child-dir-"));
		tempDirs.push(cwd);
		const r = AgentRegistry.open(cwd);
		const child = r.createChildResolvingSessionPath({ id: "child-a", parentId: MAIN_AGENT_ID, name: "Child A" });

		expect(child.sessionFile).toBe(getChildAgentSessionFile(cwd, "child-a"));
		expect(child.sessionFile).toContain(`${join(".child-agent", "child-a", "session.jsonl")}`);
	});

	it("persists child hub executor policy and node container executor configs", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-hub-agents-executors-"));
		tempDirs.push(cwd);
		const r = AgentRegistry.open(cwd);

		const defaultChild = r.createChild({
			id: "default-child",
			parentId: MAIN_AGENT_ID,
			sessionFile: join(cwd, "default.jsonl"),
		});
		const isolatedChild = r.createChild({
			id: "isolated-child",
			parentId: MAIN_AGENT_ID,
			sessionFile: join(cwd, "isolated.jsonl"),
			hubExecutor: "disabled",
			executors: [
				{
					id: "node-tools",
					type: "node-container",
					peerId: "node-tools",
					image: "node:22",
					command: ["npx", "d-pi", "peer"],
					token: "dpi_scoped_executor_token",
				},
			],
		});
		r.save();

		const reloaded = AgentRegistry.open(cwd);
		expect(reloaded.require(defaultChild.id).hubExecutor).toBe("enabled");
		expect(reloaded.require(isolatedChild.id).hubExecutor).toBe("disabled");
		expect(reloaded.require(isolatedChild.id).executors).toEqual([
			{
				id: "node-tools",
				type: "node-container",
				peerId: "node-tools",
				image: "node:22",
				command: ["npx", "d-pi", "peer"],
				token: "dpi_scoped_executor_token",
			},
		]);
	});

	it("rejects duplicate executor ids and peer ids within a child agent", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-hub-agents-executor-dup-"));
		tempDirs.push(cwd);
		const r = AgentRegistry.open(cwd);

		expect(() =>
			r.createChild({
				id: "bad-child",
				parentId: MAIN_AGENT_ID,
				sessionFile: join(cwd, "bad.jsonl"),
				executors: [
					{ id: "node-a", type: "node-container", peerId: "dup", image: "node:22", command: ["node"], token: "a" },
					{ id: "node-a", type: "node-container", peerId: "dup", image: "node:22", command: ["node"], token: "b" },
				],
			}),
		).toThrow(/Duplicate executor/);
	});

	it("removeChild is non-destructive to session files and cannot remove root", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-hub-agents-rm-"));
		tempDirs.push(cwd);
		const sessionPath = join(cwd, ".pi-hub", "kid.jsonl");
		mkdirSync(join(cwd, ".pi-hub"), { recursive: true });
		writeFileSync(sessionPath, "x\n", "utf8");
		const r = AgentRegistry.open(cwd);
		const ch = r.createChild({ id: "kid", parentId: MAIN_AGENT_ID, sessionFile: sessionPath });
		r.removeChild(ch.id);
		expect(existsSync(sessionPath)).toBe(true);
		expect(r.get("kid")).toBeUndefined();
		expect(() => r.removeChild(MAIN_AGENT_ID)).toThrow();
	});

	it("update persists changed metadata", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-hub-agents-update-"));
		tempDirs.push(cwd);
		const r = AgentRegistry.open(cwd);
		const main = r.require(MAIN_AGENT_ID);
		const next: AgentRecord = { ...main, name: "Primary", description: "D" };
		r.update(next);
		r.save();
		const r2 = AgentRegistry.open(cwd);
		const m2 = r2.require(MAIN_AGENT_ID);
		expect(m2.name).toBe("Primary");
		expect(m2.description).toBe("D");
	});

	it("getAll returns deep clones; mutating results does not affect registry", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-hub-agents-clone-"));
		tempDirs.push(cwd);
		const r = AgentRegistry.open(cwd);
		const all = r.getAll();
		all[0]!.id = "tampered" as string;
		expect(r.require(MAIN_AGENT_ID).id).toBe(MAIN_AGENT_ID);
		const one = r.get(MAIN_AGENT_ID);
		if (one) (one as { id?: string }).id = "x";
		expect(r.require(MAIN_AGENT_ID).id).toBe(MAIN_AGENT_ID);
	});

	it("require throws a clear error for a missing agent id", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-hub-agents-req-"));
		tempDirs.push(cwd);
		const r = AgentRegistry.open(cwd);
		expect(() => r.require("missing")).toThrowError(/Unknown agent id:\s*missing/);
	});

	it("removeChild throws a clear error for a missing agent id", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-hub-agents-rm-miss-"));
		tempDirs.push(cwd);
		const r = AgentRegistry.open(cwd);
		expect(() => r.removeChild("missing")).toThrowError(/Unknown agent id:\s*missing/);
	});

	it("invalid JSON in agents.json mentions the config path", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-hub-agents-badjson-"));
		tempDirs.push(cwd);
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		const path = getAgentsConfigPath(cwd);
		writeFileSync(path, "{ not valid json", "utf8");
		try {
			AgentRegistry.open(cwd);
			expect.unreachable("expected open to throw");
		} catch (e) {
			expect(e).toBeInstanceOf(Error);
			const msg = (e as Error).message;
			expect(msg).toContain("Invalid JSON");
			expect(msg).toContain(path);
		}
	});
});
