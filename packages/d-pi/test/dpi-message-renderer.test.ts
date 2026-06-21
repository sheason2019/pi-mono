import { describe, expect, it } from "vitest";
import type {
	ExtensionAPI,
	ExtensionContext,
	InputEvent,
	InputEventResult,
	MessageRenderer,
} from "../src/extension/contracts.ts";
import { createDPiExtension } from "../src/extension/index.ts";

function getRegisteredMessageRenderers(): string[] {
	const renderers: string[] = [];
	const { factory } = createDPiExtension({ mode: "client", hubUrl: "http://localhost:9090" });
	const api = {
		on: () => {},
		registerMessageRenderer: (customType: string, _renderer: MessageRenderer) => {
			renderers.push(customType);
		},
		registerCommand: () => {},
	} as unknown as ExtensionAPI;
	factory(api);
	return renderers;
}

function createWorkerHarness(): {
	emit(event: "agent_start" | "turn_start" | "turn_end" | "agent_end"): void;
	emitInput(event: Omit<InputEvent, "type">): InputEventResult | undefined;
} {
	const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => void>>();
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
	} as unknown as ExtensionAPI;
	factory(api);
	return {
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

describe("d-pi worker input routing", () => {
	it("does not register the legacy d-pi custom message renderer", () => {
		expect(getRegisteredMessageRenderers()).not.toContain("d-pi-message");
	});

	it("does not intercept worker interactive input", () => {
		const harness = createWorkerHarness();

		harness.emit("agent_start");
		harness.emit("turn_start");
		harness.emit("turn_end");

		const result = harness.emitInput({
			text: "connect next-turn",
			source: "interactive",
			// No streamingBehaviour → defaults to { triggerTurn: true }
		});

		expect(result).toBeUndefined();
	});
});
