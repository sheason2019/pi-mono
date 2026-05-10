import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai";
import { AuthStorage, createAgentSessionServices, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { HubRuntime, initializeWorkspace } from "../../src/hub/index.js";
import type { HubAgentViewModel } from "../../src/hub/session/hub-view-document.js";
import { PeerRuntime } from "../../src/peer/runtime/peer-runtime.js";

function getMessageText(message: unknown): string {
	if (!message || typeof message !== "object" || !("content" in message)) {
		return "";
	}
	const content = (message as { content?: string | Array<{ type: string; text?: string }> }).content;
	if (typeof content === "string") {
		return content;
	}
	if (!Array.isArray(content)) {
		return "";
	}
	return content
		.filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n");
}

function getTimelineMessageTexts(agent: HubAgentViewModel | undefined): string[] {
	if (!agent) {
		return [];
	}
	return getAgentMessages(agent).map((message) => getMessageText(message));
}

function getTimelineUserMessages(agent: HubAgentViewModel | undefined): Array<{ text: string; source: unknown }> {
	if (!agent) {
		return [];
	}
	return getAgentMessages(agent)
		.filter((message) => message.role === "user")
		.map((message) => ({
			text: getMessageText(message),
			source: "messageSource" in message ? message.messageSource : undefined,
		}));
}

function getAgentMessages(agent: HubAgentViewModel) {
	return agent.items.flatMap((item) => (item.type === "message" ? [item.message] : []));
}

describe.sequential("hub-peer roundtrip", () => {
	it.sequential(
		"peer messages wake an idle agent by flushing the input queue",
		async () => {
			const workspaceDir = mkdtempSync(join(tmpdir(), "pi-peer-idle-wakeup-workspace-"));
			const agentDir = mkdtempSync(join(tmpdir(), "pi-peer-idle-wakeup-agent-"));
			const faux = registerFauxProvider({
				provider: "faux-peer-idle-wakeup",
				models: [{ id: "faux-1", name: "Faux 1", reasoning: false }],
			});
			const responseText = "已收到 peer 消息。";
			faux.setResponses([fauxAssistantMessage(responseText)]);

			const authStorage = AuthStorage.inMemory();
			authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");
			const modelRegistry = ModelRegistry.inMemory(authStorage);
			modelRegistry.registerProvider(faux.getModel().provider, {
				baseUrl: faux.getModel().baseUrl,
				apiKey: "faux-key",
				api: faux.api,
				models: faux.models.map((model) => ({
					id: model.id,
					name: model.name,
					api: model.api,
					reasoning: model.reasoning,
					input: model.input,
					cost: model.cost,
					contextWindow: model.contextWindow,
					maxTokens: model.maxTokens,
					baseUrl: model.baseUrl,
				})),
			});

			initializeWorkspace(workspaceDir);
			const services = await createAgentSessionServices({
				cwd: workspaceDir,
				agentDir,
				authStorage,
				modelRegistry,
			});

			const logs = { info: vi.fn(), warning: vi.fn(), error: vi.fn() };
			const hub = HubRuntime.open(workspaceDir, { logs });
			const peer = new PeerRuntime({
				hubUrl: "http://127.0.0.1:1",
				peerId: "peer-roundtrip",
				version: "test",
				cwd: workspaceDir,
				agentDir: join(agentDir, "peer-runtime"),
			});

			try {
				const adapter = await hub.initializeAgentAdapter({
					services,
					model: faux.getModel(),
				});
				const address = await hub.start({ host: "127.0.0.1", port: 0 });
				const connectedPeer = new PeerRuntime({
					hubUrl: `http://127.0.0.1:${address.port}`,
					token: hub.rootTokenForDisplay,
					peerId: "peer-roundtrip",
					version: "test",
					cwd: workspaceDir,
					agentDir: join(agentDir, "peer-runtime"),
				});

				try {
					await connectedPeer.start();
					await vi.waitFor(
						() => {
							expect(connectedPeer.appState.isReady()).toBe(true);
						},
						{ timeout: 5000 },
					);
					const sessionPromptSpy = vi.spyOn((hub.agentAdapter ?? adapter).session.agent, "prompt");
					await connectedPeer.queueWrite("hi");
					await connectedPeer.queueFlush();

					await vi.waitFor(
						() => {
							expect(hub.sessionService.getSnapshot().lastError).toBeUndefined();
							expect((hub.agentAdapter ?? adapter).session.messages.map(getMessageText)).toContain(responseText);
						},
						{ timeout: 5000 },
					);
					const userMessage = (hub.agentAdapter ?? adapter).session.messages.find(
						(message) => message.role === "user",
					);
					expect(userMessage).toBeDefined();
					expect(getMessageText(userMessage)).toBe("hi");
					expect(userMessage && "messageSource" in userMessage ? userMessage.messageSource : undefined).toEqual(
						expect.objectContaining({
							kind: "peer",
							name: "peer-roundtrip",
						}),
					);
					expect(
						sessionPromptSpy.mock.calls.some(
							(call) =>
								Array.isArray(call[0]) &&
								call[0].some((message) => getMessageText(message) === "hi" && message.role === "user"),
						),
					).toBe(true);
				} finally {
					await connectedPeer.stop();
				}
			} finally {
				await peer.stop().catch(() => {});
				await hub.stop().catch(() => {});
				faux.unregister();
				rmSync(workspaceDir, { recursive: true, force: true });
				rmSync(agentDir, { recursive: true, force: true });
			}
		},
		10_000,
	);

	it.sequential(
		"keeps rapid peer messages as distinct user messages when flushed",
		async () => {
			const workspaceDir = mkdtempSync(join(tmpdir(), "pi-peer-multi-flush-workspace-"));
			const agentDir = mkdtempSync(join(tmpdir(), "pi-peer-multi-flush-agent-"));
			const faux = registerFauxProvider({
				provider: "faux-peer-rapid-flush",
				models: [{ id: "faux-1", name: "Faux 1", reasoning: false }],
			});
			const firstResponseText = "已收到第一条输入。";
			const secondResponseText = "已收到第二条输入。";
			faux.setResponses([
				fauxAssistantMessage(firstResponseText),
				fauxAssistantMessage(secondResponseText),
				fauxAssistantMessage("已收到额外输入。"),
			]);

			const authStorage = AuthStorage.inMemory();
			authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");
			const modelRegistry = ModelRegistry.inMemory(authStorage);
			modelRegistry.registerProvider(faux.getModel().provider, {
				baseUrl: faux.getModel().baseUrl,
				apiKey: "faux-key",
				api: faux.api,
				models: faux.models.map((model) => ({
					id: model.id,
					name: model.name,
					api: model.api,
					reasoning: model.reasoning,
					input: model.input,
					cost: model.cost,
					contextWindow: model.contextWindow,
					maxTokens: model.maxTokens,
					baseUrl: model.baseUrl,
				})),
			});

			initializeWorkspace(workspaceDir);
			const services = await createAgentSessionServices({
				cwd: workspaceDir,
				agentDir,
				authStorage,
				modelRegistry,
			});

			const logs = { info: vi.fn(), warning: vi.fn(), error: vi.fn() };
			const hub = HubRuntime.open(workspaceDir, { logs });
			const peer = new PeerRuntime({
				hubUrl: "http://127.0.0.1:1",
				peerId: "peer-roundtrip",
				version: "test",
				cwd: workspaceDir,
				agentDir: join(agentDir, "peer-runtime"),
			});

			try {
				const adapter = await hub.initializeAgentAdapter({
					services,
					model: faux.getModel(),
				});
				const address = await hub.start({ host: "127.0.0.1", port: 0 });
				const connectedPeer = new PeerRuntime({
					hubUrl: `http://127.0.0.1:${address.port}`,
					token: hub.rootTokenForDisplay,
					peerId: "peer-roundtrip",
					version: "test",
					cwd: workspaceDir,
					agentDir: join(agentDir, "peer-runtime"),
				});

				try {
					await connectedPeer.start();
					await vi.waitFor(
						() => {
							expect(connectedPeer.appState.isReady()).toBe(true);
						},
						{ timeout: 5000 },
					);
					const activeAdapter = hub.agentAdapter ?? adapter;
					const sessionPromptSpy = vi.spyOn(activeAdapter.session.agent, "prompt");
					const agentSteerSpy = vi.spyOn(activeAdapter.session.agent, "steer");
					await connectedPeer.queueWrite("第一条");
					await connectedPeer.queueWrite("第二条");
					await vi.waitFor(
						() => {
							const agent = connectedPeer.appState.getSnapshot().selectedAgent;
							expect(agent?.queue.messages).toEqual([]);
						},
						{ timeout: 5000 },
					);

					await vi.waitFor(
						() => {
							const texts = getTimelineMessageTexts(connectedPeer.appState.getSnapshot().selectedAgent);
							expect(hub.sessionService.getSnapshot().lastError).toBeUndefined();
							expect(texts).toContain(firstResponseText);
							expect(texts).toContain(secondResponseText);
						},
						{ timeout: 5000 },
					);
					const userMessages = getTimelineUserMessages(connectedPeer.appState.getSnapshot().selectedAgent);
					expect(userMessages).toHaveLength(2);
					expect(userMessages[0]).toEqual({
						text: "第一条",
						source: expect.objectContaining({ kind: "peer", name: "peer-roundtrip" }),
					});
					expect(userMessages[1]).toEqual({
						text: "第二条",
						source: expect.objectContaining({ kind: "peer", name: "peer-roundtrip" }),
					});
					expect(userMessages.map((message) => message.text).join("\n")).not.toContain("From peer/peer-roundtrip");
					const promptBatches = sessionPromptSpy.mock.calls
						.map((call) => call[0])
						.filter((input) => Array.isArray(input));
					const combinedMessage = promptBatches
						.flatMap((input) => (Array.isArray(input) ? input.map(getMessageText) : []))
						.find((text) => text.includes("第一条") && text.includes("第二条"));
					expect(combinedMessage).toBeUndefined();
					const singleBatchWithBothMessages = promptBatches.find(
						(input) =>
							Array.isArray(input) &&
							input.some((message) => getMessageText(message) === "第一条") &&
							input.some((message) => getMessageText(message) === "第二条"),
					);
					if (singleBatchWithBothMessages) {
						expect(singleBatchWithBothMessages.map(getMessageText)).toEqual(["第一条", "第二条"]);
					}
					expect(agentSteerSpy.mock.calls.map((call) => getMessageText(call[0]))).not.toContain("第二条");
				} finally {
					await connectedPeer.stop();
				}
			} finally {
				await peer.stop().catch(() => {});
				await hub.stop().catch(() => {});
				faux.unregister();
				rmSync(workspaceDir, { recursive: true, force: true });
				rmSync(agentDir, { recursive: true, force: true });
			}
		},
		10_000,
	);

	it.sequential(
		"automatically drains rapid peer messages one at a time without merging",
		async () => {
			const workspaceDir = mkdtempSync(join(tmpdir(), "pi-peer-post-run-drain-workspace-"));
			const agentDir = mkdtempSync(join(tmpdir(), "pi-peer-post-run-drain-agent-"));
			const faux = registerFauxProvider({
				provider: "faux-peer-rapid-drain",
				models: [{ id: "faux-1", name: "Faux 1", reasoning: false }],
			});
			const firstQueuedResponse = "自动处理了运行中排队的第一条消息。";
			const secondQueuedResponse = "自动处理了运行中排队的第二条消息。";
			faux.setResponses([
				fauxAssistantMessage("abcdefghijklmnopqrstuvwxyz".repeat(3)),
				fauxAssistantMessage(firstQueuedResponse),
				fauxAssistantMessage(secondQueuedResponse),
			]);

			const authStorage = AuthStorage.inMemory();
			authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");
			const modelRegistry = ModelRegistry.inMemory(authStorage);
			modelRegistry.registerProvider(faux.getModel().provider, {
				baseUrl: faux.getModel().baseUrl,
				apiKey: "faux-key",
				api: faux.api,
				models: faux.models.map((model) => ({
					id: model.id,
					name: model.name,
					api: model.api,
					reasoning: model.reasoning,
					input: model.input,
					cost: model.cost,
					contextWindow: model.contextWindow,
					maxTokens: model.maxTokens,
					baseUrl: model.baseUrl,
				})),
			});

			initializeWorkspace(workspaceDir);
			const services = await createAgentSessionServices({
				cwd: workspaceDir,
				agentDir,
				authStorage,
				modelRegistry,
			});

			const hub = HubRuntime.open(workspaceDir);
			const peer = new PeerRuntime({
				hubUrl: "http://127.0.0.1:1",
				peerId: "peer-roundtrip",
				version: "test",
				cwd: workspaceDir,
				agentDir: join(agentDir, "peer-runtime"),
			});

			try {
				await hub.initializeAgentAdapter({
					services,
					model: faux.getModel(),
				});
				const address = await hub.start({ host: "127.0.0.1", port: 0 });
				const connectedPeer = new PeerRuntime({
					hubUrl: `http://127.0.0.1:${address.port}`,
					token: hub.rootTokenForDisplay,
					peerId: "peer-roundtrip",
					version: "test",
					cwd: workspaceDir,
					agentDir: join(agentDir, "peer-runtime"),
				});

				try {
					await connectedPeer.start();
					await connectedPeer.queueWrite("先运行一轮");

					await connectedPeer.queueWrite("运行中排队的下一轮");
					await connectedPeer.queueWrite("运行中排队的补充");

					await vi.waitFor(
						() => {
							const texts = getTimelineMessageTexts(connectedPeer.appState.getSnapshot().selectedAgent);
							expect(texts).toContain(firstQueuedResponse);
							expect(texts).toContain(secondQueuedResponse);
							expect(connectedPeer.appState.getSnapshot().selectedAgent?.queue.messages).toEqual([]);
						},
						{ timeout: 8000 },
					);
					const drainedUserMessages = getTimelineUserMessages(connectedPeer.appState.getSnapshot().selectedAgent)
						.map((message) => message.text)
						.filter((text) => text.startsWith("运行中排队"));
					expect(drainedUserMessages).toEqual(["运行中排队的下一轮", "运行中排队的补充"]);
				} finally {
					await connectedPeer.stop();
				}
			} finally {
				await peer.stop().catch(() => {});
				await hub.stop().catch(() => {});
				faux.unregister();
				rmSync(workspaceDir, { recursive: true, force: true });
				rmSync(agentDir, { recursive: true, force: true });
			}
		},
		15_000,
	);

	it.sequential(
		"source messages wake an idle agent by flushing the input queue",
		async () => {
			const workspaceDir = mkdtempSync(join(tmpdir(), "pi-peer-source-wakeup-workspace-"));
			const agentDir = mkdtempSync(join(tmpdir(), "pi-peer-source-wakeup-agent-"));
			const faux = registerFauxProvider({
				provider: "faux-peer-source-wakeup",
				models: [{ id: "faux-1", name: "Faux 1", reasoning: false }],
			});
			const responseText = "已收到 source 唤醒消息。";
			faux.setResponses([fauxAssistantMessage(responseText)]);

			const authStorage = AuthStorage.inMemory();
			authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");
			const modelRegistry = ModelRegistry.inMemory(authStorage);
			modelRegistry.registerProvider(faux.getModel().provider, {
				baseUrl: faux.getModel().baseUrl,
				apiKey: "faux-key",
				api: faux.api,
				models: faux.models.map((model) => ({
					id: model.id,
					name: model.name,
					api: model.api,
					reasoning: model.reasoning,
					input: model.input,
					cost: model.cost,
					contextWindow: model.contextWindow,
					maxTokens: model.maxTokens,
					baseUrl: model.baseUrl,
				})),
			});

			initializeWorkspace(workspaceDir);
			const services = await createAgentSessionServices({
				cwd: workspaceDir,
				agentDir,
				authStorage,
				modelRegistry,
			});

			const hub = HubRuntime.open(workspaceDir);
			const peer = new PeerRuntime({
				hubUrl: "http://127.0.0.1:1",
				peerId: "peer-roundtrip",
				version: "test",
				cwd: workspaceDir,
				agentDir: join(agentDir, "peer-runtime"),
			});

			try {
				const adapter = await hub.initializeAgentAdapter({
					services,
					model: faux.getModel(),
				});
				const address = await hub.start({ host: "127.0.0.1", port: 0 });
				const connectedPeer = new PeerRuntime({
					hubUrl: `http://127.0.0.1:${address.port}`,
					token: hub.rootTokenForDisplay,
					peerId: "peer-roundtrip",
					version: "test",
					cwd: workspaceDir,
					agentDir: join(agentDir, "peer-runtime"),
				});

				try {
					await connectedPeer.start();
					await adapter.enqueueFromSource("timer-wakeup-2min", "定时唤醒");

					await vi.waitFor(
						() => {
							expect(adapter.session.messages.map(getMessageText)).toContain(responseText);
							const userMessage = adapter.session.messages.find((message) => message.role === "user");
							expect(userMessage).toBeDefined();
							expect(getMessageText(userMessage)).toBe("定时唤醒");
							expect(
								userMessage && "messageSource" in userMessage ? userMessage.messageSource : undefined,
							).toEqual({
								kind: "source",
								name: "timer-wakeup-2min",
							});
							expect(userMessage ? getMessageText(userMessage) : "").not.toContain("[message source:");
							expect(adapter.session.getSteeringMessages()).toEqual([]);
							expect(adapter.session.getFollowUpMessages()).toEqual([]);
						},
						{ timeout: 5000 },
					);
				} finally {
					await connectedPeer.stop();
				}
			} finally {
				await peer.stop().catch(() => {});
				await hub.stop().catch(() => {});
				faux.unregister();
				rmSync(workspaceDir, { recursive: true, force: true });
				rmSync(agentDir, { recursive: true, force: true });
			}
		},
		10_000,
	);

	it.sequential(
		"syncs queued input text and clears it through /dequeue",
		async () => {
			const workspaceDir = mkdtempSync(join(tmpdir(), "pi-peer-roundtrip-workspace-"));
			const agentDir = mkdtempSync(join(tmpdir(), "pi-peer-roundtrip-agent-"));
			const faux = registerFauxProvider({
				provider: "faux-peer-dequeue",
				models: [{ id: "faux-1", name: "Faux 1", reasoning: false }],
				tokensPerSecond: 20,
				tokenSize: { min: 1, max: 1 },
			});
			faux.setResponses([fauxAssistantMessage("abcdefghijklmnopqrstuvwxyz".repeat(8))]);

			const authStorage = AuthStorage.inMemory();
			authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");
			const modelRegistry = ModelRegistry.inMemory(authStorage);
			modelRegistry.registerProvider(faux.getModel().provider, {
				baseUrl: faux.getModel().baseUrl,
				apiKey: "faux-key",
				api: faux.api,
				models: faux.models.map((model) => ({
					id: model.id,
					name: model.name,
					api: model.api,
					reasoning: model.reasoning,
					input: model.input,
					cost: model.cost,
					contextWindow: model.contextWindow,
					maxTokens: model.maxTokens,
					baseUrl: model.baseUrl,
				})),
			});

			initializeWorkspace(workspaceDir);
			const services = await createAgentSessionServices({
				cwd: workspaceDir,
				agentDir,
				authStorage,
				modelRegistry,
			});

			const hub = HubRuntime.open(workspaceDir);
			const peer = new PeerRuntime({
				hubUrl: "http://127.0.0.1:1",
				peerId: "peer-roundtrip",
				version: "test",
				cwd: workspaceDir,
				agentDir: join(agentDir, "peer-runtime"),
			});

			try {
				await hub.initializeAgentAdapter({
					services,
					model: faux.getModel(),
				});
				const address = await hub.start({ host: "127.0.0.1", port: 0 });
				const hubUrl = `http://127.0.0.1:${address.port}`;
				const connectedPeer = new PeerRuntime({
					hubUrl,
					token: hub.rootTokenForDisplay,
					peerId: "peer-roundtrip",
					version: "test",
					cwd: workspaceDir,
					agentDir: join(agentDir, "peer-runtime"),
				});

				try {
					await connectedPeer.start();
					const adapter = hub.agentAdapter;
					expect(adapter).toBeDefined();
					void adapter!.session.prompt("先开始回答");
					await vi.waitFor(
						() => {
							expect(hub.sessionService.getSnapshot().lastRunStartedAt).toEqual(expect.any(String));
						},
						{ timeout: 5000 },
					);

					await connectedPeer.queueWrite("先修正这一段");
					await connectedPeer.queueWrite("之后补一句");
					await connectedPeer.invokeCommand("dequeue");

					await vi.waitFor(
						() => {
							const agent = connectedPeer.appState.getSnapshot().selectedAgent;
							expect(agent?.queue.messages).toEqual([]);
						},
						{ timeout: 5000 },
					);

					await connectedPeer.abort();
				} finally {
					await connectedPeer.stop();
				}
			} finally {
				await peer.stop().catch(() => {});
				await hub.stop().catch(() => {});
				faux.unregister();
				rmSync(workspaceDir, { recursive: true, force: true });
				rmSync(agentDir, { recursive: true, force: true });
			}
		},
		10_000,
	);
});
