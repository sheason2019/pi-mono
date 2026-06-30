import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkerToHubMessage } from "../src/types.ts";

let tempDir: string | undefined;

function freshWorkspace(): string {
	tempDir = mkdtempSync(join(tmpdir(), "d-pi-plan-update-"));
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
		getByName: (name: string) => { plan: { id: string; title: string; status: string }[] } | undefined;
	};
	_handleWorkerMessage: (worker: unknown, message: WorkerToHubMessage) => void;
	_gateway: { start: (port: number) => Promise<void>; url: () => string; stop: () => Promise<void> };
}

describe("Hub plan_update → registry → /api/team/public", () => {
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

	it("propagates plan_update from worker to the public team snapshot", async () => {
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
			agents: { name: string; plan: unknown[] }[];
		};
		expect(before.agents.find((a) => a.name === "root")?.plan).toEqual([]);

		internals._handleWorkerMessage(fakeWorker, {
			type: "plan_update",
			agentName: "root",
			plan: [
				{ id: "t1", title: "Step 1", status: "completed" },
				{ id: "t2", title: "Step 2", status: "in_progress" },
				{ id: "t3", title: "Step 3", description: "pending step", status: "pending" },
			],
		});

		expect(registry.getByName("root")?.plan).toHaveLength(3);
		expect(registry.getByName("root")?.plan[1]).toMatchObject({ id: "t2", status: "in_progress" });

		const after = (await (await fetch(`${url}/api/team/public`)).json()) as {
			agents: { name: string; plan: { id: string; title: string; status: string; description?: string }[] }[];
		};
		const rootPlan = after.agents.find((a) => a.name === "root")?.plan;
		expect(rootPlan).toHaveLength(3);
		expect(rootPlan?.[0]).toMatchObject({ id: "t1", status: "completed" });
		expect(rootPlan?.[2]?.description).toBe("pending step");

		await internals._gateway.stop();
	});

	it("ignores plan_update for an unknown agent without throwing", async () => {
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
				type: "plan_update",
				agentName: "ghost",
				plan: [{ id: "x", title: "x", status: "pending" }],
			}),
		).not.toThrow();
		expect(internals._registry.getByName("ghost")).toBeUndefined();
	});
});
