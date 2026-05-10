import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SourceRuntimeStatus } from "../../src/hub/index.js";
import {
	loadPeerSourceConfigs,
	PeerSourceRuntime,
	type PeerSourceRuntimeHost,
} from "../../src/peer/sources/peer-source-runtime.js";

const tempDirs: string[] = [];

function writeJson(path: string, value: unknown): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("PeerSourceRuntime", () => {
	it("loads peer-local sources from global and cwd configs, with cwd overriding duplicate names", () => {
		const cwd = mkdtempSync(join(tmpdir(), "peer-source-cwd-"));
		const agentDir = mkdtempSync(join(tmpdir(), "peer-source-agent-"));
		const globalDir = mkdtempSync(join(tmpdir(), "peer-source-global-"));
		tempDirs.push(cwd, agentDir, globalDir);
		writeJson(join(agentDir, "sources.json"), {
			sources: [
				{ name: "agent-dir-only", transport: "stdio", command: "agent-dir" },
				{ name: "global-only", transport: "stdio", command: "agent-dir-global" },
			],
		});
		writeJson(join(globalDir, "sources.json"), {
			sources: [
				{ name: "global-only", transport: "stdio", command: "global" },
				{ name: "shared", transport: "stdio", command: "global-shared" },
			],
		});
		writeJson(join(cwd, ".pi", "sources.json"), {
			sources: [
				{ name: "shared", transport: "stdio", command: "cwd-shared" },
				{ name: "cwd-only", transport: "stdio", command: "cwd" },
			],
		});

		const loaded = loadPeerSourceConfigs({ cwd, agentDir, globalDir });

		expect(loaded.configs.map((config) => `${config.name}:${config.command}`)).toEqual([
			"agent-dir-only:agent-dir",
			"global-only:global",
			"shared:cwd-shared",
			"cwd-only:cwd",
		]);
		expect(
			loaded.configs.every((config) => typeof config.resourceId === "string" && config.resourceId.length > 0),
		).toBe(true);
		expect(loaded.configPathByName.get("agent-dir-only")).toBe(join(agentDir, "sources.json"));
		expect(loaded.configPathByName.get("global-only")).toBe(join(globalDir, "sources.json"));
		expect(loaded.configPathByName.get("shared")).toBe(join(cwd, ".pi", "sources.json"));
	});

	it("keeps source names unchanged and routes management actions by resourceId", async () => {
		const pauseSource = vi.fn(async () => {});
		const restartSource = vi.fn(async () => {});
		const removeSource = vi.fn(async () => {});
		const host: PeerSourceRuntimeHost = {
			start: vi.fn(async () => {}),
			stop: vi.fn(async () => {}),
			getStatuses: (): SourceRuntimeStatus[] => [
				{
					resourceId: "source-id",
					name: "local",
					transport: "stdio",
					agentId: "main",
					origin: "peer",
					status: "running",
				},
			],
			pauseSource,
			restartSource,
			removeSource,
		};
		const runtime = new PeerSourceRuntime({
			cwd: "/tmp/work",
			agentDir: "/tmp/agent",
			peerId: "peer a",
			isHubRunning: () => false,
			emitSourceMessage: vi.fn(async () => {}),
			host,
		});
		expect(runtime.getStatuses()).toEqual([
			{
				resourceId: "source-id",
				name: "local",
				transport: "stdio",
				agentId: "main",
				status: "running",
				origin: "peer",
				peerId: "peer a",
			},
		]);
		expect(runtime.hasLocalSourceResourceId("source-id")).toBe(true);
		expect(runtime.hasLocalSourceResourceId("missing-source")).toBe(false);

		await runtime.pauseSource("source-id");
		await runtime.restartSource("source-id");
		await runtime.removeSource("source-id");

		expect(pauseSource).toHaveBeenCalledWith("source-id");
		expect(restartSource).toHaveBeenCalledWith("source-id");
		expect(removeSource).toHaveBeenCalledWith("source-id");
	});

	it("removes peer-local source entries from the config file that defined them", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "peer-source-remove-cwd-"));
		const agentDir = mkdtempSync(join(tmpdir(), "peer-source-remove-agent-"));
		const globalDir = mkdtempSync(join(tmpdir(), "peer-source-remove-global-"));
		tempDirs.push(cwd, agentDir, globalDir);
		const sourcesPath = join(cwd, ".pi", "sources.json");
		writeJson(sourcesPath, {
			sources: [
				{ name: "remove-me", transport: "stdio", command: "node", disabled: true },
				{ name: "keep-me", transport: "stdio", command: "node", disabled: true },
			],
		});
		const runtime = new PeerSourceRuntime({
			cwd,
			agentDir,
			globalDir,
			peerId: "peer-a",
			isHubRunning: () => false,
			emitSourceMessage: vi.fn(async () => {}),
		});
		await runtime.start();
		const [removeMe] = runtime.getStatuses();

		await runtime.removeSource(removeMe!.resourceId!);

		const saved = JSON.parse(readFileSync(sourcesPath, "utf8")) as { sources: Array<{ name: string }> };
		expect(saved.sources.map((source) => source.name)).toEqual(["keep-me"]);
		expect(runtime.getStatuses().map((source) => source.name)).toEqual(["keep-me"]);
	});

	it("sends source messages to the configured agent id instead of only the bound peer agent", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "peer-source-agent-target-"));
		const agentDir = mkdtempSync(join(tmpdir(), "peer-source-agent-target-agent-"));
		tempDirs.push(cwd, agentDir);
		const payload = JSON.stringify({
			jsonrpc: "2.0",
			method: "queue/write",
			params: { content: "from source" },
		});
		writeJson(join(cwd, ".pi", "sources.json"), {
			sources: [
				{
					name: "child-source",
					transport: "stdio",
					command: process.execPath,
					args: ["-e", `console.log(${JSON.stringify(payload)})`],
					agentId: "child-a",
				},
			],
		});
		const emitSourceMessage = vi.fn(async () => {});
		const runtime = new PeerSourceRuntime({
			cwd,
			agentDir,
			peerId: "peer-a",
			isHubRunning: () => false,
			targetAgentId: () => "main",
			emitSourceMessage,
		});

		await runtime.start();
		await vi.waitFor(() => {
			expect(emitSourceMessage).toHaveBeenCalledWith("child-source", "from source", "child-a");
		});
		await runtime.stop();
	});
});
