import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkerToHubMessage } from "../src/types.ts";

let tempDir: string | undefined;

function freshWorkspace(): string {
	tempDir = mkdtempSync(join(tmpdir(), "d-pi-description-update-"));
	return tempDir;
}

afterEach(() => {
	if (tempDir) {
		rmSync(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	}
});

interface HubInternals {
	_registry: {
		register: (record: unknown) => void;
		getByName: (name: string) => { description?: string } | undefined;
	};
	_handleWorkerMessage: (worker: unknown, message: WorkerToHubMessage) => void;
	_gateway: { start: (port: number) => Promise<void>; url: () => string; stop: () => Promise<void> };
}

describe("Hub description_update → registry → /api/team/public", () => {
	beforeEach(async () => {
		vi.resetModules();
		vi.doMock("node:worker_threads", async () => {
			const actual = await vi.importActual<typeof import("node:worker_threads")>("node:worker_threads");
			class FakeWorker {
				private listeners: Array<(msg: unknown) => void> = [];
				constructor(_url: unknown, options?: { workerData?: { agentName?: string; port?: number } }) {
					const agentName = options?.workerData?.agentName;
					const port = options?.workerData?.port ?? 0;
					queueMicrotask(() => {
						for (const l of this.listeners) l({ type: "ready", agentName, port });
					});
				}
				on(event: string, handler: (msg: unknown) => void): void {
					if (event === "message") this.listeners.push(handler);
				}
				off(): void {}
				postMessage(): void {}
			}
			return { ...actual, Worker: FakeWorker };
		});
	});

	it("propagates description_update from worker to the public team snapshot", async () => {
		const { Hub: HubMocked } = await import("../src/hub/hub.ts");
		const workspace = freshWorkspace();
		const hub = new HubMocked({
			port: 0,
			workspaceRoot: workspace,
			cwd: workspace,
			workspaceContext: {
				workspaceRoot: workspace,
				additionalSkillPaths: [],
				workspaceModelPaths: {},
				workspaceContextFiles: [],
				workspaceSourcePaths: {},
			},
		});
		const internals = hub as unknown as HubInternals;
		const registry = internals._registry;
		const fakeWorker = { postMessage: () => {}, on: () => {}, off: () => {} } as never;
		registry.register({
			name: "root",
			parentName: undefined,
			children: [],
			status: "ready",
			plan: [],
			worker: fakeWorker,
			cwd: workspace,
		} as never);

		await internals._gateway.start(0);
		const url = internals._gateway.url();

		const before = (await (await fetch(`${url}/api/team/public`)).json()) as {
			agents: { name: string; description?: string }[];
		};
		expect(before.agents.find((a) => a.name === "root")?.description).toBeUndefined();

		internals._handleWorkerMessage(fakeWorker, {
			type: "description_update",
			agentName: "root",
			description: "Root orchestrator that delegates work to subagents",
		});

		expect(registry.getByName("root")?.description).toBe("Root orchestrator that delegates work to subagents");

		const after = (await (await fetch(`${url}/api/team/public`)).json()) as {
			agents: { name: string; description?: string }[];
		};
		expect(after.agents.find((a) => a.name === "root")?.description).toBe(
			"Root orchestrator that delegates work to subagents",
		);

		await internals._gateway.stop();
	});

	it("clears the description when the worker reports undefined", async () => {
		const { Hub: HubMocked } = await import("../src/hub/hub.ts");
		const workspace = freshWorkspace();
		const hub = new HubMocked({
			port: 0,
			workspaceRoot: workspace,
			cwd: workspace,
			workspaceContext: {
				workspaceRoot: workspace,
				additionalSkillPaths: [],
				workspaceModelPaths: {},
				workspaceContextFiles: [],
				workspaceSourcePaths: {},
			},
		});
		const internals = hub as unknown as HubInternals;
		const registry = internals._registry;
		const fakeWorker = { postMessage: () => {}, on: () => {}, off: () => {} } as never;
		registry.register({
			name: "root",
			parentName: undefined,
			children: [],
			status: "ready",
			plan: [],
			description: "stale",
			worker: fakeWorker,
			cwd: workspace,
		} as never);

		internals._handleWorkerMessage(fakeWorker, {
			type: "description_update",
			agentName: "root",
			description: undefined,
		});

		expect(registry.getByName("root")?.description).toBeUndefined();
	});

	it("ignores description_update for an unknown agent without throwing", async () => {
		const { Hub: HubMocked } = await import("../src/hub/hub.ts");
		const workspace = freshWorkspace();
		const hub = new HubMocked({
			port: 0,
			workspaceRoot: workspace,
			cwd: workspace,
			workspaceContext: {
				workspaceRoot: workspace,
				additionalSkillPaths: [],
				workspaceModelPaths: {},
				workspaceContextFiles: [],
				workspaceSourcePaths: {},
			},
		});
		const internals = hub as unknown as HubInternals;
		const fakeWorker = { postMessage: () => {}, on: () => {}, off: () => {} } as never;

		expect(() =>
			internals._handleWorkerMessage(fakeWorker, {
				type: "description_update",
				agentName: "ghost",
				description: "nobody",
			}),
		).not.toThrow();
		expect(internals._registry.getByName("ghost")).toBeUndefined();
	});
});
