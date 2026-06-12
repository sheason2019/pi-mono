import type { ExtensionAPI, ExtensionHandler } from "@sheason/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { createDPiExtension } from "../src/extension/index.ts";

/**
 * Regression tests for the source-message routing path through the
 * d-pi worker extension. Bug 2: source messages with mode="steer" were
 * not triggering an agent turn when the agent was idle, because the
 * extension forwarded `deliverAs: "steer"` only and `sendCustomMessage`
 * only queues when the agent is already streaming — for an idle agent
 * the message would land as a bare entry in the session log and the
 * agent would never actually process it.
 *
 * The fix is to always pass `triggerTurn: true` regardless of mode. The
 * `deliverAs` field then controls the *queueing* behavior when the agent
 * is already mid-turn (steer-vs-followUp), which is the original
 * semantic the user-facing TUI Enter / Ctrl+Enter vocabulary was modeling.
 */

interface CapturedCall {
	customType: string;
	content: unknown;
	display: boolean;
	details: unknown;
	options: unknown;
}

function makeChannel(): Parameters<typeof createDPiExtension>[0] {
	return {
		mode: "worker",
		agentName: "test-agent",
		postToHub: vi.fn(),
	};
}

/**
 * Build a minimal ExtensionAPI stub that records the only calls the
 * d-pi extension actually makes on the worker side: `sendMessage`,
 * `on("input", ...)`, `registerCommand`, `registerTool`, and
 * `registerMessageRenderer`. Every other method on the surface is
 * a no-op so TypeScript stays happy and any accidental call from the
 * extension is observable as a test failure ("X is not a function").
 */
function makePi(): { pi: ExtensionAPI; captured: CapturedCall[]; inputHandler: (e: unknown) => unknown } {
	const captured: CapturedCall[] = [];
	let inputHandler: ((e: unknown) => unknown) | undefined;
	const noop = vi.fn();

	const pi: Partial<ExtensionAPI> = {
		sendMessage: ((message: unknown, options: unknown) => {
			captured.push({
				customType: (message as { customType: string }).customType,
				content: (message as { content: unknown }).content,
				display: (message as { display: boolean }).display,
				details: (message as { details: unknown }).details,
				options,
			});
		}) as unknown as ExtensionAPI["sendMessage"],
		registerCommand: noop as unknown as ExtensionAPI["registerCommand"],
		registerTool: noop as unknown as ExtensionAPI["registerTool"],
		registerMessageRenderer: noop as unknown as ExtensionAPI["registerMessageRenderer"],
		// The `on` overloads in the type are exhaustive by event name; the
		// d-pi extension subscribes to "input" specifically, so we cast
		// through unknown to a narrow string-typed shim that records
		// whichever handler it is given.
		on: ((event: string, handler: ExtensionHandler<unknown, unknown>) => {
			if (event === "input") {
				inputHandler = handler as unknown as (e: unknown) => unknown;
			}
		}) as unknown as ExtensionAPI["on"],
	};

	return { pi: pi as ExtensionAPI, captured, inputHandler: (e) => (inputHandler ? inputHandler(e) : undefined) };
}

describe("d-pi extension: source-message routing (Bug 2)", () => {
	it("mode=steer triggers a new turn when agent is idle", () => {
		const { pi, captured, inputHandler } = makePi();
		const { factory, channel } = createDPiExtension(makeChannel());
		factory(pi);

		// Simulate a source event arriving at the worker
		channel!.deliverMessage("hello from lark", "lark-bot", "steer");

		expect(captured).toHaveLength(1);
		expect(captured[0].customType).toBe("d-pi-message");
		expect(captured[0].display).toBe(true);
		// The fix: triggerTurn must be true so an idle agent wakes up.
		// deliverAs: "steer" remains so that if the agent happens to be
		// mid-turn, the message is queued as a steer injection rather
		// than a new-turn prompt.
		const opts = captured[0].options as { triggerTurn?: boolean; deliverAs?: string };
		expect(opts.triggerTurn).toBe(true);
		expect(opts.deliverAs).toBe("steer");
		// inputHandler isn't used in this test but TypeScript needs the
		// variable referenced to avoid "declared but never used".
		expect(typeof inputHandler).toBe("function");
	});

	it("mode=next triggers a new turn (no deliverAs)", () => {
		const { pi, captured, inputHandler } = makePi();
		const { factory, channel } = createDPiExtension(makeChannel());
		factory(pi);

		channel!.deliverMessage("next turn please", "lark-bot", "next");

		expect(captured).toHaveLength(1);
		const opts = captured[0].options as { triggerTurn?: boolean; deliverAs?: string };
		expect(opts.triggerTurn).toBe(true);
		// For non-steer, we don't pin deliverAs — the session decides
		// queueing based on streaming state.
		expect(opts.deliverAs).toBeUndefined();
		expect(typeof inputHandler).toBe("function");
	});

	it("TUI input with steer (alt+enter) also triggers a new turn", () => {
		const { pi, captured, inputHandler } = makePi();
		const { factory } = createDPiExtension(makeChannel());
		factory(pi);

		const result = inputHandler({
			source: "interactive",
			text: "user typed something",
			streamingBehavior: "steer",
		});
		expect(result).toEqual({ action: "handled" });

		expect(captured).toHaveLength(1);
		const opts = captured[0].options as { triggerTurn?: boolean; deliverAs?: string };
		expect(opts.triggerTurn).toBe(true);
		expect(opts.deliverAs).toBe("steer");
	});

	it("TUI input without steer (regular Enter) triggers a new turn", () => {
		const { pi, captured, inputHandler } = makePi();
		const { factory } = createDPiExtension(makeChannel());
		factory(pi);

		const result = inputHandler({
			source: "interactive",
			text: "regular enter",
		});
		expect(result).toEqual({ action: "handled" });

		expect(captured).toHaveLength(1);
		const opts = captured[0].options as { triggerTurn?: boolean; deliverAs?: string };
		expect(opts.triggerTurn).toBe(true);
		expect(opts.deliverAs).toBeUndefined();
	});
});
