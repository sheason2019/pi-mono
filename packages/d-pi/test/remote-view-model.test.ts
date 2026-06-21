import { describe, expect, it, vi } from "vitest";
import type { DPiInteractiveSessionStateSnapshot } from "../src/tui/interactive/agent-session-proxy.ts";
import {
	createDPiInteractiveRemoteAgentSessionProxy,
	DPiInteractiveRemoteAgentSessionProxy,
} from "../src/tui/interactive/remote-agent-session-proxy.ts";
import { composeDPiInteractiveSnapshot, splitDPiInteractiveSnapshot } from "../src/tui/interactive/view-model.ts";

function snapshot(): DPiInteractiveSessionStateSnapshot {
	return {
		model: "anthropic/claude-sonnet-4",
		thinkingLevel: "medium",
		isStreaming: false,
		isCompacting: false,
		isBashRunning: false,
		steeringMessages: [],
		followUpMessages: [],
		sessionFile: "/tmp/session.jsonl",
		sessionName: "session",
		messages: [{ role: "user", content: "hello", timestamp: 1 }],
		banner: undefined,
		tokenUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, usingSubscription: false },
		contextUsage: { tokens: 0, contextWindow: 200000, percent: 0 },
		modelInfo: { id: "claude-sonnet-4", provider: "anthropic", reasoning: true, contextWindow: 200000 },
		autoCompactEnabled: true,
		cwd: "/tmp/workspace",
		availableProviderCount: 1,
		remoteSettings: {
			autoCompact: true,
			thinkingLevel: "medium",
			availableThinkingLevels: ["off", "low", "medium", "high"],
			steeringMode: "all",
			followUpMode: "all",
			enableSkillCommands: true,
			doubleEscapeAction: "tree",
			showImages: true,
			imageWidthCells: 60,
			autoResizeImages: true,
			blockImages: false,
			transport: "auto",
			httpIdleTimeoutMs: 600000,
			currentTheme: "default",
			availableThemes: ["default"],
			hideThinkingBlock: false,
			collapseChangelog: false,
			enableInstallTelemetry: false,
			treeFilterMode: "all",
			showHardwareCursor: false,
			editorPaddingX: 0,
			autocompleteMaxVisible: 10,
			quietStartup: false,
			clearOnShrink: true,
			showTerminalProgress: true,
			warnings: {},
		},
		scopedModelIds: null,
		enabledModelPatterns: undefined,
		extensionPaths: [],
	};
}

describe("remote-first interactive view model", () => {
	it("splits messages into realtime state and keeps status state message-free", () => {
		const full = snapshot();
		const split = splitDPiInteractiveSnapshot(full);

		expect("messages" in split.status).toBe(false);
		expect(split.realtime).toMatchObject({
			cursor: 1,
			page: expect.objectContaining({ index: 0, reason: "initial" }),
			messages: full.messages,
		});
		expect(composeDPiInteractiveSnapshot(split.status, split.realtime)).toEqual(full);
	});

	it("applies status and realtime SSE events through separate stores", () => {
		const full = snapshot();
		const { status, realtime } = splitDPiInteractiveSnapshot(full);
		const proxy = new DPiInteractiveRemoteAgentSessionProxy(status, realtime, {
			baseUrl: "https://dp.example/agents/root",
			fetch: vi.fn() as unknown as typeof fetch,
		});
		const events: string[] = [];
		proxy.subscribe((event) => events.push(event.type));

		proxy.applyNamedEventForTest({
			event: "status",
			data: JSON.stringify({ ...status, isStreaming: true }),
		});
		proxy.applyNamedEventForTest({
			event: "realtime",
			data: JSON.stringify({
				type: "upsert",
				cursor: 2,
				message: { id: "message-2", role: "assistant", content: [{ type: "text", text: "hi" }], timestamp: 2 },
			}),
		});

		expect(proxy.getSnapshot()).toMatchObject({
			isStreaming: true,
			messages: [expect.objectContaining({ content: "hello" }), expect.objectContaining({ id: "message-2" })],
		});
		expect(events).toEqual(["state_update", "message_update"]);
	});

	it("handles payload-less named SSE events without parsing undefined as JSON", () => {
		const full = snapshot();
		const { status, realtime } = splitDPiInteractiveSnapshot(full);
		const proxy = new DPiInteractiveRemoteAgentSessionProxy(status, realtime, {
			baseUrl: "https://dp.example/agents/root",
			fetch: vi.fn() as unknown as typeof fetch,
		});
		const events: string[] = [];
		proxy.subscribe((event) => events.push(event.type));

		expect(() =>
			proxy.applyNamedEventForTest({
				event: "compaction_start",
				data: "undefined",
			}),
		).not.toThrow();

		expect(events).toEqual(["compaction_start"]);
	});

	it("updates compacting status from payload-less compaction events", () => {
		const full = snapshot();
		const { status, realtime } = splitDPiInteractiveSnapshot(full);
		const proxy = new DPiInteractiveRemoteAgentSessionProxy(status, realtime, {
			baseUrl: "https://dp.example/agents/root",
			fetch: vi.fn() as unknown as typeof fetch,
		});

		proxy.applyNamedEventForTest({ event: "compaction_start", data: "undefined" });
		expect(proxy.getSnapshot().isCompacting).toBe(true);

		proxy.applyNamedEventForTest({ event: "compaction_end", data: "undefined" });
		expect(proxy.getSnapshot().isCompacting).toBe(false);
	});

	it("keeps existing client history when compact divider arrives as an increment", () => {
		const full = snapshot();
		const { status, realtime } = splitDPiInteractiveSnapshot(full);
		const proxy = new DPiInteractiveRemoteAgentSessionProxy(status, realtime, {
			baseUrl: "https://dp.example/agents/root",
			fetch: vi.fn() as unknown as typeof fetch,
		});

		proxy.applyNamedEventForTest({
			event: "realtime",
			data: JSON.stringify({
				type: "upsert",
				cursor: 1,
				message: {
					id: "compact-divider-1",
					role: "custom",
					customType: "compact-divider",
					content: "Compact completed 15s",
					timestamp: 2,
				},
			}),
		});
		proxy.applyNamedEventForTest({
			event: "realtime",
			data: JSON.stringify({
				type: "upsert",
				cursor: 2,
				message: { id: "message-after-compact", role: "user", content: "after compact", timestamp: 3 },
			}),
		});

		expect(proxy.getSnapshot().messages).toEqual([
			expect.objectContaining({ content: "hello" }),
			expect.objectContaining({ customType: "compact-divider" }),
			expect.objectContaining({ content: "after compact" }),
		]);
	});

	it("applies item-only realtime updates without adding compatibility messages", () => {
		const full = snapshot();
		const { status, realtime } = splitDPiInteractiveSnapshot(full);
		const proxy = new DPiInteractiveRemoteAgentSessionProxy(status, realtime, {
			baseUrl: "https://dp.example/agents/root",
			fetch: vi.fn() as unknown as typeof fetch,
		});

		proxy.applyNamedEventForTest({
			event: "realtime",
			data: JSON.stringify({
				type: "upsert",
				cursor: 2,
				item: {
					id: "turn-stats-1",
					type: "turn_stats",
					tps: 12.3,
					output: 4,
					input: 10,
					cacheRead: 5,
					cacheWrite: 0,
					total: 19,
					duration: 0.4,
					timestamp: 2,
				},
			}),
		});

		expect(proxy.getSnapshot().messages).toEqual(full.messages);
		expect(proxy.getSnapshot().transcriptItems).toEqual([
			expect.objectContaining({ type: "turn_stats", output: 4, total: 19 }),
		]);
	});

	it("creates the remote proxy from status and realtime endpoints instead of a monolithic state endpoint", async () => {
		const full = snapshot();
		const { status, realtime } = splitDPiInteractiveSnapshot(full);
		const requestedUrls: string[] = [];
		const fetchFn = vi.fn(async (input: string | URL | Request) => {
			const url = String(input);
			requestedUrls.push(url);
			if (url.endsWith("/status")) {
				return Response.json(status);
			}
			if (url.endsWith("/realtime")) {
				return Response.json(realtime);
			}
			return Response.json({ error: "unexpected" }, { status: 404 });
		}) as unknown as typeof fetch;

		const proxy = await createDPiInteractiveRemoteAgentSessionProxy({
			baseUrl: "https://dp.example/agents/root",
			fetch: fetchFn,
		});

		expect(proxy.getSnapshot()).toEqual(full);
		expect(requestedUrls).toEqual([
			"https://dp.example/agents/root/status",
			"https://dp.example/agents/root/realtime",
		]);
	});

	it("includes the worker error body when a POST request fails", async () => {
		const full = snapshot();
		const { status, realtime } = splitDPiInteractiveSnapshot(full);
		const proxy = new DPiInteractiveRemoteAgentSessionProxy(status, realtime, {
			baseUrl: "https://dp.example/agents/root",
			fetch: vi.fn(async () =>
				Response.json({ ok: false, error: "Nothing to compact (session too small)" }, { status: 400 }),
			) as unknown as typeof fetch,
		});

		await expect(proxy.compact()).rejects.toThrow(
			"compact returned HTTP 400: Nothing to compact (session too small)",
		);
	});
});
