import { afterEach, describe, expect, it, vi } from "vitest";
import { SourceManager } from "../src/hub/source-manager.ts";
import { defineSource } from "../src/workspace-definition.ts";

interface BroadcastCall {
	sourceName: string;
	data: string;
	subscriberAgentNames: string[];
}

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await wait(5);
	}
	throw new Error("Timed out waiting for condition");
}

describe("SourceManager", () => {
	const managers: SourceManager[] = [];

	afterEach(() => {
		for (const manager of managers) {
			manager.stopAll();
		}
		managers.splice(0, managers.length);
	});

	function createManager(options?: { initialRestartDelayMs?: number; maxRestartDelayMs?: number }): {
		manager: SourceManager;
		broadcasts: BroadcastCall[];
	} {
		const broadcasts: BroadcastCall[] = [];
		const manager = new SourceManager((sourceName, data, subscriberAgentNames) => {
			broadcasts.push({ sourceName, data, subscriberAgentNames });
		}, options);
		managers.push(manager);
		return { manager, broadcasts };
	}

	it("starts every declared source and broadcasts string output to declared subscribers", async () => {
		const { manager, broadcasts } = createManager();

		manager.syncSources(
			{
				"lark-bot": defineSource({
					execute(output) {
						output("hello");
					},
				}),
			},
			new Map([["lark-bot", new Set(["root", "reviewer"])]]),
			"/workspace",
		);

		await waitFor(() => broadcasts.length === 1);
		expect(broadcasts).toEqual([
			{ sourceName: "lark-bot", data: "hello", subscriberAgentNames: ["root", "reviewer"] },
		]);
		expect(manager.listSources()).toEqual([
			expect.objectContaining({ name: "lark-bot", status: "running", subscribers: ["root", "reviewer"] }),
		]);
	});

	it("starts sources even when no agents subscribe and rejects non-string output", async () => {
		const { manager, broadcasts } = createManager();
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		try {
			manager.syncSources(
				{
					"quiet-source": defineSource({
						execute(output) {
							output("visible");
							output({ bad: true } as never);
						},
					}),
				},
				new Map(),
				"/workspace",
			);

			await waitFor(() => manager.getSourceStats("quiet-source")?.status === "running");
			expect(broadcasts).toEqual([]);
			expect(stderr.mock.calls.some((call) => String(call[0]).includes("non-string output"))).toBe(true);
		} finally {
			stderr.mockRestore();
		}
	});

	it("restarts failed execute loops with exponential backoff", async () => {
		const { manager, broadcasts } = createManager({ initialRestartDelayMs: 5, maxRestartDelayMs: 20 });
		let attempts = 0;

		manager.syncSources(
			{
				flaky: defineSource({
					execute(output) {
						attempts += 1;
						if (attempts < 3) {
							throw new Error("boom");
						}
						output("recovered");
					},
				}),
			},
			new Map([["flaky", new Set(["root"])]]),
			"/workspace",
		);

		await waitFor(() => broadcasts.some((call) => call.data === "recovered"), 1000);
		expect(attempts).toBe(3);
		expect(manager.getSourceStats("flaky")?.restartCount).toBe(2);
	});

	it("aborts removed sources on sync", async () => {
		const { manager } = createManager({ initialRestartDelayMs: 5, maxRestartDelayMs: 20 });
		let aborted = false;

		manager.syncSources(
			{
				removable: defineSource({
					execute(_output, context) {
						context.signal.addEventListener("abort", () => {
							aborted = true;
						});
					},
				}),
			},
			new Map(),
			"/workspace",
		);

		manager.syncSources({}, new Map(), "/workspace");

		expect(aborted).toBe(true);
		expect(manager.getSourceStats("removable")).toBeUndefined();
	});
});
