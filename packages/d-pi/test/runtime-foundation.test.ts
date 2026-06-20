import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AgentHarnessError } from "@earendil-works/pi-agent-core";
import type {
	AgentHarnessResources,
	AgentHarnessStreamOptions,
	AgentTool,
	ThinkingLevel,
} from "@earendil-works/pi-agent-core/node";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { buildAgentTsSource } from "../src/agent-config.ts";
import { readLoadedAgentDefinitionFromTs } from "../src/agent-loader.ts";
import { DPiContextManager } from "../src/context/context-manager.ts";
import {
	type DPiAgentHarness,
	type DPiAgentHarnessEvent,
	type DPiAgentHarnessEventListener,
	type DPiAgentHarnessFactoryOptions,
	DPiAgentRuntime,
} from "../src/runtime/agent-runtime.ts";
import { createDPiRuntimeError, isDPiRuntimeError } from "../src/runtime/errors.ts";
import { DPiModelManager } from "../src/runtime/model-manager.ts";
import { DPiSessionStore } from "../src/runtime/session-store.ts";
import type { DPiPromptOptions } from "../src/runtime/types.ts";

let tempDir: string | undefined;

function makeModel(provider = "anthropic", id = "claude-sonnet-4-5"): Model<Api> {
	return {
		id,
		name: id,
		api: "anthropic-messages",
		baseUrl: "https://api.anthropic.com",
		provider,
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 32_000,
	};
}

function createTempWorkspace(): string {
	tempDir = mkdtempSync(join(tmpdir(), "d-pi-runtime-foundation-"));
	return tempDir;
}

function write(path: string, content: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
}

function createAgent(workspaceRoot: string, agentName: string, description: string): string {
	const agentDir = join(workspaceRoot, "agents", agentName);
	write(
		join(agentDir, "agent.ts"),
		buildAgentTsSource({
			name: agentName,
			parentName: undefined,
			description,
		}),
	);
	write(join(agentDir, "AGENTS.md"), `agent context for ${agentName}`);
	return agentDir;
}

class FakeHarness implements DPiAgentHarness {
	readonly calls: { method: "prompt" | "steer" | "followUp" | "nextTurn"; text: string }[] = [];
	private readonly listeners = new Set<DPiAgentHarnessEventListener>();
	private busy = false;
	private promptBarrier: Promise<void> | undefined;

	setBusy(value: boolean): void {
		this.busy = value;
	}

	holdPromptUntil(promise: Promise<void>): void {
		this.promptBarrier = promise;
	}

	async prompt(text: string): Promise<AssistantMessage> {
		this.calls.push({ method: "prompt", text });
		if (this.busy) {
			throw new AgentHarnessError("busy", "fake harness is busy");
		}
		this.busy = true;
		try {
			await this.promptBarrier;
			return {
				role: "assistant",
				content: [{ type: "text", text: "ok" }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			};
		} finally {
			this.busy = false;
		}
	}

	async steer(text: string): Promise<void> {
		this.calls.push({ method: "steer", text });
		if (this.busy) {
			throw new AgentHarnessError("busy", "fake harness is busy");
		}
	}

	async followUp(text: string): Promise<void> {
		this.calls.push({ method: "followUp", text });
	}

	async nextTurn(text: string): Promise<void> {
		this.calls.push({ method: "nextTurn", text });
	}

	subscribe(listener: DPiAgentHarnessEventListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	emit(event: DPiAgentHarnessEvent): void {
		for (const listener of this.listeners) {
			listener(event);
		}
	}
}

async function createRuntime(workspaceRoot: string, fakeHarness: FakeHarness): Promise<DPiAgentRuntime> {
	const agentDir = createAgent(workspaceRoot, "root", "Original identity.");
	const agentDefinition = await readLoadedAgentDefinitionFromTs(agentDir);
	const sessionStore = new DPiSessionStore({
		cwd: workspaceRoot,
		sessionsRoot: join(workspaceRoot, ".pi", "sessions"),
	});
	const session = await sessionStore.create({ id: "runtime-session" });
	return new DPiAgentRuntime({
		agentName: "root",
		cwd: workspaceRoot,
		session: session.session,
		modelManager: new DPiModelManager({ model: makeModel() }),
		contextManager: new DPiContextManager({
			workspaceRoot,
			agentName: "root",
			agentDir,
			cwd: agentDir,
			agentDefinition,
		}),
		harnessFactory: () => fakeHarness,
	});
}

afterEach(() => {
	if (tempDir) {
		rmSync(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	}
});

describe("d-pi runtime foundation", () => {
	it("uses an already resolved agent.ts model without loading provider defaults", () => {
		const manager = new DPiModelManager({ model: makeModel() });

		expect(manager.getModelInfo()).toMatchObject({
			id: "claude-sonnet-4-5",
			provider: "anthropic",
			displayName: "claude-sonnet-4-5",
			contextWindow: 200_000,
		});
		expect("setModelSpec" in manager).toBe(false);
	});

	it("creates, lists, and opens sessions through the d-pi session boundary", async () => {
		const workspaceRoot = createTempWorkspace();
		const store = new DPiSessionStore({
			cwd: workspaceRoot,
			sessionsRoot: join(workspaceRoot, ".pi", "sessions"),
		});

		const created = await store.create({ id: "session-1" });
		const listed = await store.list();
		const opened = await store.open("session-1");

		expect(created.info).toMatchObject({ id: "session-1", path: expect.stringContaining(".jsonl") });
		expect(listed.map((session) => session.id)).toEqual(["session-1"]);
		expect(await opened.session.getMetadata()).toEqual(created.metadata);
	});

	it("opens the most recent persisted session for a cwd", async () => {
		const workspaceRoot = createTempWorkspace();
		const store = new DPiSessionStore({
			cwd: workspaceRoot,
			sessionsRoot: join(workspaceRoot, ".pi", "sessions"),
		});
		await store.create({ cwd: workspaceRoot, id: "old-session" });
		await new Promise((resolve) => setTimeout(resolve, 5));
		const recent = await store.create({ cwd: workspaceRoot, id: "recent-session" });
		const timestamp = Date.now();
		await recent.session.appendMessage({ role: "user", content: [{ type: "text", text: "restored" }], timestamp });

		const restored = await store.openRecent({ cwd: workspaceRoot });

		expect(restored?.info.id).toBe("recent-session");
		expect((await restored?.session.buildContext())?.messages).toEqual([
			{ role: "user", content: [{ type: "text", text: "restored" }], timestamp },
		]);
	});

	it("initializes snapshots with restored session messages", async () => {
		const workspaceRoot = createTempWorkspace();
		const agentDir = createAgent(workspaceRoot, "root", "Original identity.");
		const store = new DPiSessionStore({
			cwd: workspaceRoot,
			sessionsRoot: join(workspaceRoot, ".pi", "sessions"),
		});
		const session = await store.create({ id: "runtime-session" });
		const timestamp = Date.now();
		await session.session.appendMessage({
			role: "user",
			content: [{ type: "text", text: "hello before reconnect" }],
			timestamp,
		});
		const initialContext = await session.session.buildContext();

		const runtime = new DPiAgentRuntime({
			agentName: "root",
			cwd: workspaceRoot,
			session: session.session,
			sessionInfo: session.info,
			initialMessages: initialContext.messages,
			modelManager: new DPiModelManager({ model: makeModel() }),
			contextManager: new DPiContextManager({ workspaceRoot, agentName: "root", agentDir, cwd: agentDir }),
			harnessFactory: () => new FakeHarness(),
		});

		expect(runtime.getSnapshot().session.id).toBe("runtime-session");
		expect(runtime.getSnapshot().messages).toEqual([
			{ role: "user", content: [{ type: "text", text: "hello before reconnect" }], timestamp },
		]);
		runtime.dispose();
	});

	it("routes prompt modes to the harness and normalizes harness queue events", async () => {
		const workspaceRoot = createTempWorkspace();
		const fakeHarness = new FakeHarness();
		const runtime = await createRuntime(workspaceRoot, fakeHarness);
		const events: string[] = [];
		runtime.subscribe((event) => {
			events.push(event.type);
		});

		await runtime.prompt("next", { mode: "next" } satisfies DPiPromptOptions);
		await runtime.prompt("steer", { mode: "steer" } satisfies DPiPromptOptions);
		await runtime.prompt("follow", { mode: "followUp" } satisfies DPiPromptOptions);
		fakeHarness.emit({ type: "queue_update", steer: [], followUp: [], nextTurn: [] });

		expect(fakeHarness.calls).toEqual([
			{ method: "prompt", text: "next" },
			{ method: "steer", text: "steer" },
			{ method: "followUp", text: "follow" },
		]);
		expect(events).toContain("queue_update");
	});

	it("normalizes consumed queued user messages into runtime message events", async () => {
		const workspaceRoot = createTempWorkspace();
		const fakeHarness = new FakeHarness();
		const runtime = await createRuntime(workspaceRoot, fakeHarness);
		const events: unknown[] = [];
		runtime.subscribe((event) => {
			events.push(event);
		});

		fakeHarness.emit({
			type: "message_end",
			message: {
				role: "user",
				content: [{ type: "text", text: "queued user input" }],
				timestamp: 123,
			},
		});

		expect(events).toEqual([
			{
				type: "message",
				agentName: "root",
				message: {
					role: "user",
					content: [{ type: "text", text: "queued user input" }],
					timestamp: 123,
				},
			},
		]);
		expect(runtime.getSnapshot().messages).toEqual([
			{
				role: "user",
				content: [{ type: "text", text: "queued user input" }],
				timestamp: 123,
			},
		]);
	});

	it("normalizes error events without an agent name to the current agent", async () => {
		const workspaceRoot = createTempWorkspace();
		const fakeHarness = new FakeHarness();
		const runtime = await createRuntime(workspaceRoot, fakeHarness);
		const error = createDPiRuntimeError("network", "provider timed out", { retryable: true });
		const events: DPiAgentHarnessEvent[] = [];
		runtime.subscribe((event) => {
			events.push(event);
		});

		fakeHarness.emit({ type: "error", error });

		expect(events).toEqual([{ type: "error", agentName: "root", error }]);
	});

	it("emits native-style turn stats at agent end from all assistant messages in the run", async () => {
		const workspaceRoot = createTempWorkspace();
		const fakeHarness = new FakeHarness();
		const runtime = await createRuntime(workspaceRoot, fakeHarness);
		const events: DPiAgentHarnessEvent[] = [];
		runtime.subscribe((event) => {
			events.push(event);
		});

		fakeHarness.emit({ type: "agent_start" });
		expect(events.at(-1)).toMatchObject({ type: "agent_start", agentName: "root" });
		fakeHarness.emit({
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "ok" }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				usage: {
					input: 1200,
					output: 300,
					cacheRead: 800,
					cacheWrite: 100,
					totalTokens: 999999,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.123 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			},
		});
		expect(events.some((event) => event.type === "turn_stats")).toBe(false);
		fakeHarness.emit({
			type: "agent_end",
			messages: [
				{
					role: "assistant",
					content: [{ type: "text", text: "ok" }],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "claude-sonnet-4-5",
					usage: {
						input: 1200,
						output: 300,
						cacheRead: 800,
						cacheWrite: 100,
						totalTokens: 999999,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.123 },
					},
					stopReason: "stop",
					timestamp: Date.now(),
				},
				{
					role: "assistant",
					content: [{ type: "text", text: "second" }],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "claude-sonnet-4-5",
					usage: {
						input: 10,
						output: 20,
						cacheRead: 30,
						cacheWrite: 40,
						totalTokens: 999999,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 },
					},
					stopReason: "stop",
					timestamp: Date.now(),
				},
			],
		});
		await new Promise<void>((resolve) => setImmediate(resolve));

		expect(events.some((event) => event.type === "agent_end")).toBe(true);
		expect(events.find((event) => event.type === "turn_stats")).toMatchObject({
			type: "turn_stats",
			input: 1210,
			output: 320,
			cacheRead: 830,
			cacheWrite: 140,
			total: 2500,
		});
	});

	it("does not emit empty turn stats when an agent run has no assistant token usage", async () => {
		const workspaceRoot = createTempWorkspace();
		const fakeHarness = new FakeHarness();
		const runtime = await createRuntime(workspaceRoot, fakeHarness);
		const events: DPiAgentHarnessEvent[] = [];
		runtime.subscribe((event) => {
			events.push(event);
		});

		fakeHarness.emit({ type: "agent_start" });
		fakeHarness.emit({
			type: "agent_end",
			messages: [
				{
					role: "toolResult",
					toolCallId: "tool-ls",
					toolName: "dispatch_ls",
					content: [{ type: "text", text: ".pi/\nagent.ts" }],
					isError: false,
					timestamp: Date.now(),
				},
			],
		});
		await new Promise<void>((resolve) => setImmediate(resolve));

		expect(events.some((event) => event.type === "agent_end")).toBe(true);
		expect(events.some((event) => event.type === "turn_stats")).toBe(false);
	});

	it("queues next prompts while active and when the harness reports busy", async () => {
		const workspaceRoot = createTempWorkspace();
		const fakeHarness = new FakeHarness();
		const runtime = await createRuntime(workspaceRoot, fakeHarness);
		let releasePrompt: () => void = () => {};
		const promptRelease = new Promise<void>((resolve) => {
			releasePrompt = resolve;
		});
		fakeHarness.holdPromptUntil(promptRelease);

		const activePrompt = runtime.prompt("running", { mode: "next" });
		try {
			await expect(runtime.prompt("queued", { mode: "next" })).resolves.toBeUndefined();
		} finally {
			releasePrompt();
			await activePrompt.catch(() => undefined);
		}

		expect(fakeHarness.calls.slice(0, 2)).toEqual([
			{ method: "prompt", text: "running" },
			{ method: "nextTurn", text: "queued" },
		]);

		fakeHarness.setBusy(true);
		await expect(runtime.prompt("busy queued", { mode: "next" })).resolves.toBeUndefined();
		expect(fakeHarness.calls.at(-1)).toEqual({ method: "nextTurn", text: "busy queued" });
	});

	it("forwards foundation options through the harness factory boundary", async () => {
		const workspaceRoot = createTempWorkspace();
		const fakeHarness = new FakeHarness();
		const agentDir = createAgent(workspaceRoot, "root", "Original identity.");
		const sessionStore = new DPiSessionStore({
			cwd: workspaceRoot,
			sessionsRoot: join(workspaceRoot, ".pi", "sessions"),
		});
		const session = await sessionStore.create({ id: "runtime-session" });
		const tool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo text",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
		};
		const resources: AgentHarnessResources = {
			skills: [
				{
					name: "review",
					description: "Review code",
					content: "Review instructions",
					filePath: join(workspaceRoot, "skills", "review", "SKILL.md"),
				},
			],
			promptTemplates: [{ name: "plan", content: "Make a plan" }],
		};
		const streamOptions: AgentHarnessStreamOptions = {
			headers: { "x-runtime": "d-pi" },
			timeoutMs: 1234,
		};
		const thinkingLevel: ThinkingLevel = "medium";
		const getApiKeyAndHeaders = async () => ({
			apiKey: "test-key",
			headers: { authorization: "Bearer test-key" },
		});
		let capturedOptions: DPiAgentHarnessFactoryOptions | undefined;

		new DPiAgentRuntime({
			agentName: "root",
			cwd: workspaceRoot,
			session: session.session,
			modelManager: new DPiModelManager({ model: makeModel() }),
			contextManager: new DPiContextManager({ workspaceRoot, agentName: "root", agentDir, cwd: agentDir }),
			tools: [tool],
			resources,
			getApiKeyAndHeaders,
			streamOptions,
			activeToolNames: ["echo"],
			thinkingLevel,
			harnessFactory: (options) => {
				capturedOptions = options;
				return fakeHarness;
			},
		});

		expect(capturedOptions?.tools).toEqual([tool]);
		expect(capturedOptions?.resources).toEqual(resources);
		expect(capturedOptions?.getApiKeyAndHeaders).toBe(getApiKeyAndHeaders);
		expect(capturedOptions?.streamOptions).toEqual(streamOptions);
		expect(capturedOptions?.activeToolNames).toEqual(["echo"]);
		expect(capturedOptions?.thinkingLevel).toBe(thinkingLevel);
	});

	it("maps fake harness busy failures from non-next modes to DPiRuntimeError", async () => {
		const workspaceRoot = createTempWorkspace();
		const fakeHarness = new FakeHarness();
		fakeHarness.setBusy(true);
		const runtime = await createRuntime(workspaceRoot, fakeHarness);

		await expect(runtime.prompt("steer", { mode: "steer" })).rejects.toMatchObject({
			name: "DPiRuntimeError",
			code: "busy",
			retryable: true,
		});
	});

	it("reloads context into the snapshot and keeps snapshots JSON round-trippable", async () => {
		const workspaceRoot = createTempWorkspace();
		const fakeHarness = new FakeHarness();
		const runtime = await createRuntime(workspaceRoot, fakeHarness);
		const agentDir = join(workspaceRoot, "agents", "root");

		expect(runtime.getSnapshot().context.systemPromptParts.join("\n")).toContain("Original identity.");

		write(join(agentDir, "AGENTS.md"), "reloaded agent context");

		await runtime.reloadContext();
		const snapshot = runtime.getSnapshot();
		const parsed = JSON.parse(JSON.stringify(snapshot)) as typeof snapshot;

		expect(snapshot.context.systemPromptParts.join("\n")).toContain("Original identity.");
		expect(snapshot.context.contextFiles).toEqual([
			{ path: join(agentDir, "AGENTS.md"), content: "reloaded agent context" },
		]);
		expect(parsed.context.systemPromptParts).toEqual(snapshot.context.systemPromptParts);
		expect(isDPiRuntimeError(parsed)).toBe(false);
	});
});
