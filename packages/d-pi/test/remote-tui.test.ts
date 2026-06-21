import { describe, expect, it } from "vitest";
import { createRemoteTuiOptionsFromConnectSession } from "../src/connect/connect-mode.ts";
import type { DPiServiceEvent, DPiServiceSnapshot } from "../src/service/protocol.ts";
import { buildRemoteFooterView } from "../src/tui/components/remote-footer.ts";
import {
	buildRemoteMessageListView,
	type DPiRemoteMessageListViewModel,
} from "../src/tui/components/remote-message-list.ts";
import {
	createDPiRemoteTuiController,
	type DPiRemoteTuiClient,
	type DPiRemoteTuiConnectionState,
} from "../src/tui/remote-tui.ts";

type ClientEventListener = (event: DPiServiceEvent) => void;

class FakeRemoteTuiClient implements DPiRemoteTuiClient {
	readonly calls: string[] = [];
	snapshot: DPiServiceSnapshot | undefined;
	events: DPiServiceEvent[] = [];
	errors: unknown[] = [];
	private listeners = new Set<ClientEventListener>();
	private pendingError: unknown;

	constructor(snapshot?: DPiServiceSnapshot) {
		this.snapshot = snapshot;
	}

	onEvent(listener: ClientEventListener): () => void {
		this.calls.push("onEvent");
		this.listeners.add(listener);
		return () => {
			this.calls.push("unsubscribe");
			this.listeners.delete(listener);
		};
	}

	async connect(options?: { subscribe?: boolean }): Promise<void> {
		this.calls.push(`connect:${String(options?.subscribe)}`);
		if (this.pendingError !== undefined) {
			const error = this.pendingError;
			this.pendingError = undefined;
			throw error;
		}
	}

	disconnect(): void {
		this.calls.push("disconnect");
	}

	getSnapshot(): DPiServiceSnapshot | undefined {
		return this.snapshot;
	}

	getEvents(): readonly DPiServiceEvent[] {
		return [...this.events];
	}

	getErrors(): readonly unknown[] {
		return [...this.errors];
	}

	listenerCount(): number {
		return this.listeners.size;
	}

	async prompt(text: string): Promise<void> {
		this.calls.push(`prompt:${text}`);
		if (this.pendingError !== undefined) {
			const error = this.pendingError;
			this.pendingError = undefined;
			throw error;
		}
	}

	async steer(text: string): Promise<void> {
		this.calls.push(`steer:${text}`);
	}

	async followUp(text: string): Promise<void> {
		this.calls.push(`followUp:${text}`);
	}

	async setAgentName(agentName: string, options?: { subscribe?: boolean }): Promise<void> {
		this.calls.push(`setAgentName:${agentName}:${String(options?.subscribe)}`);
	}

	emit(event: DPiServiceEvent): void {
		if (event.type === "snapshot") {
			this.snapshot = event.snapshot;
		} else {
			this.events.push(event);
		}
		for (const listener of this.listeners) {
			listener(event);
		}
	}

	failNext(error: unknown): void {
		this.pendingError = error;
	}
}

function snapshot(state: DPiServiceSnapshot["state"], agentName = "root"): DPiServiceSnapshot {
	return {
		agentName,
		state,
	};
}

describe("remote-first TUI message list", () => {
	// Parity marker: message-rendering:assistant-and-user-transcript
	it("renders user, assistant, custom, tool-ish, and worker event text", () => {
		const view = buildRemoteMessageListView({
			snapshot: snapshot({
				messages: [
					{ id: "u1", role: "user", content: "ship it" },
					{ id: "a1", role: "assistant", content: "working on it" },
					{ id: "c1", role: "custom", sourceName: "helper", content: "handoff ready" },
					{ id: "t1", type: "tool_result", toolName: "remote_read", content: "read complete" },
				],
			}),
			events: [{ type: "worker", event: "token", data: { text: "streamed token" } }],
		});

		expect(view.text).toContain("user: ship it");
		expect(view.text).toContain("assistant: working on it");
		expect(view.text).toContain("custom[helper]: handoff ready");
		expect(view.text).toContain("tool[remote_read]: read complete");
		expect(view.text).toContain("worker.token: streamed token");
		expect(view.items.map((item) => item.role)).toEqual(["user", "assistant", "custom", "tool", "worker"]);
	});

	it("does not render internal worker state events as transcript messages", () => {
		const view = buildRemoteMessageListView({
			snapshot: snapshot({ messages: [] }),
			events: [
				{
					type: "worker",
					event: "state",
					data: {
						agent: { sessionId: "d-pi-session-1", status: "ready" },
						extensions: { tools: [{ name: "send_message", description: "internal tool definition" }] },
					},
				},
				{ type: "snapshot", snapshot: snapshot({ messages: [] }) },
			],
		});

		expect(view.items).toEqual([]);
		expect(view.text).toBe("No remote messages yet.");
		expect(view.text).not.toContain("worker.state");
		expect(view.text).not.toContain("internal tool definition");
	});
});

describe("remote-first TUI footer", () => {
	// Parity marker: footer-status:runtime-status-footer
	it("renders agent, connection state, streaming, busy, queued, and model status", () => {
		const footer = buildRemoteFooterView({
			snapshot: snapshot({
				streaming: true,
				busy: true,
				queued: 2,
				model: "gpt-5.5",
			}),
			connectionState: "connected",
		});

		expect(footer.text).toBe("agent root | connected | streaming | busy | queued 2 | model gpt-5.5");
		expect(footer.segments).toEqual(["agent root", "connected", "streaming", "busy", "queued 2", "model gpt-5.5"]);
	});
});

describe("DPi remote TUI controller", () => {
	// Parity marker: streaming-tools:runtime-worker-event-feed
	it("starts with subscribe, renders snapshots and events, then stops cleanly", async () => {
		const client = new FakeRemoteTuiClient(snapshot({ messages: [{ role: "assistant", content: "hello" }] }));
		const controller = createDPiRemoteTuiController({ client });

		await controller.start();
		client.emit({ type: "worker", event: "token", data: { text: "world" } });
		const rendered = controller.render();
		await controller.stop();

		expect(client.calls).toEqual(["connect:true", "onEvent", "unsubscribe", "disconnect"]);
		expect(rendered.connectionState satisfies DPiRemoteTuiConnectionState).toBe("connected");
		expect(rendered.messages satisfies DPiRemoteMessageListViewModel).toMatchObject({
			text: expect.stringContaining("assistant: hello"),
		});
		expect(rendered.messages.text).toContain("worker.token: world");
		expect(rendered.footer.text).toContain("agent root");
		expect(rendered.errors).toEqual([]);
	});

	it("does not register duplicate listeners when started repeatedly", async () => {
		const client = new FakeRemoteTuiClient(snapshot({ status: "ready" }));
		let changes = 0;
		const controller = createDPiRemoteTuiController({
			client,
			onChange: () => {
				changes += 1;
			},
		});

		await controller.start();
		await controller.start();
		client.emit({ type: "worker", event: "token", data: { text: "hello" } });

		expect(client.listenerCount()).toBe(1);
		expect(changes).toBe(2);
	});

	it("stops idempotently and removes the active listener", async () => {
		const client = new FakeRemoteTuiClient(snapshot({ status: "ready" }));
		const controller = createDPiRemoteTuiController({ client });

		await controller.start();
		await controller.stop();
		await controller.stop();

		expect(client.listenerCount()).toBe(0);
	});

	it("cleans up failed starts so a later start can retry", async () => {
		const client = new FakeRemoteTuiClient(snapshot({ status: "ready" }));
		client.failNext(new Error("connect rejected"));
		const controller = createDPiRemoteTuiController({ client });

		await expect(controller.start()).rejects.toThrow("connect rejected");
		expect(client.listenerCount()).toBe(0);
		expect(controller.render().connectionState).toBe("disconnected");

		await controller.start();

		expect(client.listenerCount()).toBe(1);
		expect(controller.render().connectionState).toBe("connected");
	});

	// Parity marker: input-keybindings:editable-input-bindings
	it("submits non-empty prompts when idle and steers while streaming, busy, or queued", async () => {
		const client = new FakeRemoteTuiClient(snapshot({ streaming: false, busy: false }));
		const controller = createDPiRemoteTuiController({ client });

		await controller.submit("  ");
		await controller.submit(" first prompt ");
		client.snapshot = snapshot({ streaming: true, busy: false });
		await controller.submit("stream steer");
		client.snapshot = snapshot({ streaming: false, busy: true });
		await controller.submit("busy steer");
		client.snapshot = snapshot({ streaming: false, busy: false, queued: 1 });
		await controller.submit("queued steer");

		expect(client.calls).toEqual([
			"prompt:first prompt",
			"steer:stream steer",
			"steer:busy steer",
			"steer:queued steer",
		]);
	});

	// Parity marker: commands-selectors:command-and-agent-surfaces
	it("routes followUp and agent switches through the remote client", async () => {
		const client = new FakeRemoteTuiClient(snapshot({ status: "ready" }));
		const controller = createDPiRemoteTuiController({ client });

		await controller.followUp("continue");
		await controller.switchAgent("helper");

		expect(client.calls).toEqual(["followUp:continue", "setAgentName:helper:true"]);
	});

	it("records operation failures in render errors without losing client errors", async () => {
		const client = new FakeRemoteTuiClient(snapshot({ status: "ready" }));
		client.errors.push(new Error("background stream failed"));
		client.failNext(new Error("prompt rejected"));
		const controller = createDPiRemoteTuiController({ client });

		await controller.submit("hello");

		expect(controller.render().errors).toEqual(["prompt rejected", "background stream failed"]);
	});

	it("records connect failures and exposes disconnected state", async () => {
		const client = new FakeRemoteTuiClient(snapshot({ status: "ready" }));
		client.failNext(new Error("connect rejected"));
		const controller = createDPiRemoteTuiController({ client });

		await expect(controller.start()).rejects.toThrow("connect rejected");

		expect(controller.render()).toMatchObject({
			connectionState: "disconnected",
			errors: ["connect rejected"],
		});
	});
});

describe("remote TUI connect-mode helper", () => {
	it("builds remote client options without changing the legacy connect child", () => {
		expect(
			createRemoteTuiOptionsFromConnectSession({
				agentUrl: "https://dp.example/agents/root%20agent",
				hubUrl: "https://dp.example/",
				authToken: "token",
			}),
		).toEqual({
			baseUrl: "https://dp.example",
			agentName: "root agent",
			authHeaders: { Authorization: "Bearer token" },
		});
	});
});
