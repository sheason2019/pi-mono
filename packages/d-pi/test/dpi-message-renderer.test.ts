import type { Component } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	type ExtensionAPI,
	type ExtensionContext,
	type InputEvent,
	type InputEventResult,
	initTheme,
	type MessageRenderer,
} from "@sheason/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { createDPiExtension } from "../src/extension/index.ts";
import { injectMeta } from "../src/extension/message-meta.ts";
import { dPiMessageTuiComponent } from "../src/tui-components/d-pi-message.ts";

const fakeTheme = {
	bg: (_name: string, text: string) => text,
	fg: (_name: string, text: string) => text,
};

function createRecordingTheme(): typeof fakeTheme & { fgCalls: string[]; bgCalls: string[] } {
	const fgCalls: string[] = [];
	const bgCalls: string[] = [];
	return {
		fgCalls,
		bgCalls,
		bg: (name: string, text: string) => {
			bgCalls.push(name);
			return text;
		},
		fg: (name: string, text: string) => {
			fgCalls.push(name);
			return text;
		},
	};
}

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function getDPiMessageRenderer(): MessageRenderer {
	return dPiMessageTuiComponent.render as MessageRenderer;
}

type SendMessageCall = {
	message: Parameters<ExtensionAPI["sendMessage"]>[0];
	options: Parameters<ExtensionAPI["sendMessage"]>[1];
};

function createWorkerHarness(): {
	channel: NonNullable<ReturnType<typeof createDPiExtension>["channel"]>;
	sendMessageCalls: SendMessageCall[];
	emit(event: "agent_start" | "turn_start" | "turn_end" | "agent_end"): void;
	emitInput(event: Omit<InputEvent, "type">): InputEventResult | undefined;
} {
	const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => void>>();
	const sendMessageCalls: SendMessageCall[] = [];
	const { factory, channel } = createDPiExtension({ mode: "worker", agentName: "agent-1", postToHub: () => {} });
	if (!channel) {
		throw new Error("worker channel was not created");
	}
	const api = {
		on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => void) => {
			const existing = handlers.get(event) ?? [];
			existing.push(handler);
			handlers.set(event, existing);
		},
		registerTool: () => {},
		registerCommand: () => {},
		registerMessageRenderer: () => {},
		sendMessage: (message: SendMessageCall["message"], options: SendMessageCall["options"]) => {
			sendMessageCalls.push({ message, options });
		},
	} as unknown as ExtensionAPI;
	factory(api);
	return {
		channel,
		sendMessageCalls,
		emit(event) {
			for (const handler of handlers.get(event) ?? []) {
				handler({ type: event }, {} as ExtensionContext);
			}
		},
		emitInput(event) {
			const handler = handlers.get("input")?.[0];
			return handler?.({ type: "input", ...event }, {} as ExtensionContext) as InputEventResult | undefined;
		},
	};
}

function messageContentText(content: SendMessageCall["message"]["content"]): string {
	if (typeof content === "string") {
		return content;
	}
	return content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

describe("d-pi message renderer", () => {
	it("exports d-pi-message rendering as a tui component definition", () => {
		initTheme("dark");
		const component = dPiMessageTuiComponent.render(
			{
				customType: "d-pi-message",
				content: injectMeta("hello **world**", "agent", undefined, { agentName: "agent-1" }),
				display: true,
				details: undefined,
			},
			{ expanded: false },
			fakeTheme,
		) as Component | undefined;

		expect(dPiMessageTuiComponent.customType).toBe("d-pi-message");
		expect(component).toBeDefined();
		expect(component!.render(80).map(stripAnsi).join("\n")).toContain("hello world");
	});

	it("renders meta as a header and message body as a user message bubble", () => {
		initTheme("dark");
		const renderer = getDPiMessageRenderer();
		const recordingTheme = createRecordingTheme();
		const component = renderer(
			{
				role: "custom",
				customType: "d-pi-message",
				content: injectMeta("hello **world**", "agent", undefined, { agentName: "agent-1" }),
				display: true,
				details: undefined,
				timestamp: Date.now(),
			},
			{ expanded: false },
			recordingTheme as never,
		) as Component | undefined;

		expect(component).toBeDefined();
		const raw = component!.render(80).join("\n");
		const rendered = raw.split("\n").map(stripAnsi);
		const text = rendered.join("\n");

		expect(text).toContain("agent:agent-1 · ");
		expect(text).not.toContain("agent:agent-1 - ");
		expect(text).toContain("hello world");
		expect(text).not.toContain("[meta(");
		expect(raw).not.toContain("\x1b]133;A\x07");
		expect(recordingTheme.fgCalls).toContain("warning");
		expect(recordingTheme.fgCalls).not.toContain("mdHeading");
		expect(recordingTheme.bgCalls).toContain("userMessageBg");
		expect(rendered.some((line) => visibleWidth(line) === 80)).toBe(true);
	});

	it("renders connect auth name between source and time", () => {
		initTheme("dark");
		const renderer = getDPiMessageRenderer();
		const component = renderer(
			{
				role: "custom",
				customType: "d-pi-message",
				content: injectMeta("hello", "connect", {
					name: "lixujie",
					description: "",
				}),
				display: true,
				details: undefined,
				timestamp: Date.now(),
			},
			{ expanded: false },
			fakeTheme as never,
		) as Component | undefined;

		expect(component).toBeDefined();
		const header = component!.render(80).map(stripAnsi)[0];

		expect(header).toContain("connect · lixujie · ");
		expect(header).not.toContain("connect - lixujie - ");
	});

	it("renders 'connect <id>' in the header when a connectId is present", () => {
		initTheme("dark");
		const renderer = getDPiMessageRenderer();
		const component = renderer(
			{
				role: "custom",
				customType: "d-pi-message",
				content: injectMeta("hello", "connect", undefined, { connectId: "abc-123" }),
				display: true,
				details: undefined,
				timestamp: Date.now(),
			},
			{ expanded: false },
			fakeTheme as never,
		) as Component | undefined;

		expect(component).toBeDefined();
		const header = component!.render(80).map(stripAnsi)[0];

		expect(header).toContain("connect abc-123");
	});

	it("renders just 'connect' (with trailing space) when no connectId is present", () => {
		initTheme("dark");
		const renderer = getDPiMessageRenderer();
		const component = renderer(
			{
				role: "custom",
				customType: "d-pi-message",
				content: injectMeta("hello", "connect"),
				display: true,
				details: undefined,
				timestamp: Date.now(),
			},
			{ expanded: false },
			fakeTheme as never,
		) as Component | undefined;

		expect(component).toBeDefined();
		const header = component!.render(80).map(stripAnsi)[0];

		// Trailing space distinguishes the bare label from "connect <id>".
		expect(header).toContain("connect ");
		expect(header).not.toContain("connect abc-123");
	});

	it("queues incoming messages with default 'next' mode (triggerTurn) until agent_end", () => {
		const harness = createWorkerHarness();

		harness.emit("agent_start");
		harness.emit("turn_start");
		harness.emit("turn_end");
		// No mode → defaults to "next" → extension maps to { triggerTurn: true }
		harness.channel.deliverMessage("queued during run", "source-a");

		expect(harness.sendMessageCalls).toHaveLength(1);
		const queuedContent = messageContentText(harness.sendMessageCalls[0].message.content);
		expect(harness.sendMessageCalls[0].options).toEqual({ triggerTurn: true });
		expect(queuedContent).toContain("queued during run");
		expect(queuedContent).toContain("[meta(");
		expect(harness.sendMessageCalls[0].message.details).toMatchObject({
			sourceName: "source-a",
			sourceType: "source",
		});

		harness.emit("agent_end");
		// After agent_end, deliver with explicit "steer" mode → extension
		// maps to { deliverAs: "steer", triggerTurn: true } so an idle
		// agent wakes up immediately. The `triggerTurn` is the Bug 2 fix;
		// pre-fix this would have just been { deliverAs: "steer" } and the
		// message would have landed as a bare session entry without ever
		// prompting the agent.
		harness.channel.deliverMessage("after run", "source-a", "steer");

		expect(harness.sendMessageCalls[1].options).toEqual({ deliverAs: "steer", triggerTurn: true });
	});

	it("wraps interactive input as meta-bearing custom messages", () => {
		const harness = createWorkerHarness();

		const result = harness.emitInput({
			text: "connect next-turn",
			source: "interactive",
			// No streamingBehaviour → defaults to { triggerTurn: true }
		});

		expect(result).toEqual({ action: "handled" });
		expect(harness.sendMessageCalls).toHaveLength(1);
		expect(harness.sendMessageCalls[0].options).toEqual({ triggerTurn: true });
		expect(harness.sendMessageCalls[0].message.customType).toBe("d-pi-message");
		const queuedContent = messageContentText(harness.sendMessageCalls[0].message.content);
		expect(queuedContent).toContain("connect next-turn");
		expect(queuedContent).toContain("[meta(");
		expect(harness.sendMessageCalls[0].message.details).toMatchObject({ sourceType: "connect" });
	});
});
