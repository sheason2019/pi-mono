/**
 * Regression test for sheason2019/pi-mono issue #5.
 *
 * In connect mode the InteractiveMode is constructed with `runtimeHost = undefined`
 * (see `connect-mode.ts:20`), so `this.session` is undefined. The original
 * `cycleModel`/`cycleThinkingLevel` called `this.session!.X(...)` and crashed
 * with `TypeError: Cannot read properties of undefined (reading 'cycleModel')`.
 *
 * The fix routes the call through the connect-mode proxy when no local session
 * is available, so neither method should throw in connect mode and the proxy's
 * equivalent methods should be invoked with the expected arguments.
 */

import type { ThinkingLevel } from "@sheason/pi-agent-core";
import { describe, expect, it, vi } from "vitest";
import type { AgentSession, ModelCycleResult } from "../../../src/core/agent-session.ts";
import type { AgentSessionProxy } from "../../../src/core/agent-session-proxy.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";

type CycleModel = (this: unknown, direction: "forward" | "backward") => Promise<void>;
type CycleThinkingLevel = (this: unknown) => void;

const cycleModelProto = (InteractiveMode.prototype as unknown as { cycleModel: CycleModel }).cycleModel;
const cycleThinkingLevelProto = (InteractiveMode.prototype as unknown as { cycleThinkingLevel: CycleThinkingLevel })
	.cycleThinkingLevel;

/** Build a fake AgentSessionProxy that only implements what the cycle* methods
 *  touch. We use `vi.fn()` so we can assert on the exact call args. */
function createFakeProxy(): AgentSessionProxy & {
	cycleModel: ReturnType<typeof vi.fn>;
	cycleThinkingLevel: ReturnType<typeof vi.fn>;
} {
	const cycleModel = vi.fn((_direction: 1 | -1) => {
		// Mirrors RemoteAgentSessionProxy.cycleModel: fire-and-forget, returns void.
	});
	const cycleThinkingLevel = vi.fn((_direction: 1 | -1) => {
		// Mirrors RemoteAgentSessionProxy.cycleThinkingLevel: fire-and-forget, returns void.
	});
	const proxy = {
		cycleModel,
		cycleThinkingLevel,
	} as unknown as AgentSessionProxy & {
		cycleModel: ReturnType<typeof vi.fn>;
		cycleThinkingLevel: ReturnType<typeof vi.fn>;
	};
	return proxy;
}

type FakeThis = {
	session: AgentSession | undefined;
	proxy: AgentSessionProxy | undefined;
	showStatus: ReturnType<typeof vi.fn>;
	showError: ReturnType<typeof vi.fn>;
	footer: { invalidate: ReturnType<typeof vi.fn> };
	updateEditorBorderColor: ReturnType<typeof vi.fn>;
	maybeWarnAboutAnthropicSubscriptionAuth: ReturnType<typeof vi.fn>;
};

function createFakeThis(overrides: Partial<FakeThis> = {}): FakeThis {
	return {
		session: undefined,
		proxy: undefined,
		showStatus: vi.fn(),
		showError: vi.fn(),
		footer: { invalidate: vi.fn() },
		updateEditorBorderColor: vi.fn(),
		maybeWarnAboutAnthropicSubscriptionAuth: vi.fn(async () => {}),
		...overrides,
	};
}

describe("InteractiveMode cycle* methods in connect mode (issue #5)", () => {
	it("cycleModel('forward') routes through the proxy and does not throw", async () => {
		const proxy = createFakeProxy();
		const fakeThis = createFakeThis({ proxy });

		await expect(cycleModelProto.call(fakeThis, "forward")).resolves.toBeUndefined();

		expect(proxy.cycleModel).toHaveBeenCalledTimes(1);
		expect(proxy.cycleModel).toHaveBeenCalledWith(1);
		// Proxy returns void → result is undefined → status message is shown.
		expect(fakeThis.showStatus).toHaveBeenCalledWith("Only one model available");
		// Local-only side effects must NOT fire in connect mode.
		expect(fakeThis.footer.invalidate).not.toHaveBeenCalled();
		expect(fakeThis.updateEditorBorderColor).not.toHaveBeenCalled();
		expect(fakeThis.maybeWarnAboutAnthropicSubscriptionAuth).not.toHaveBeenCalled();
	});

	it("cycleModel('backward') routes through the proxy with direction -1", async () => {
		const proxy = createFakeProxy();
		const fakeThis = createFakeThis({ proxy });

		await expect(cycleModelProto.call(fakeThis, "backward")).resolves.toBeUndefined();

		expect(proxy.cycleModel).toHaveBeenCalledTimes(1);
		expect(proxy.cycleModel).toHaveBeenCalledWith(-1);
		expect(fakeThis.showStatus).toHaveBeenCalledWith("Only one model available");
	});

	it("cycleThinkingLevel routes through the proxy with direction 1 and does not throw", () => {
		const proxy = createFakeProxy();
		const fakeThis = createFakeThis({ proxy });

		expect(() => cycleThinkingLevelProto.call(fakeThis)).not.toThrow();

		expect(proxy.cycleThinkingLevel).toHaveBeenCalledTimes(1);
		expect(proxy.cycleThinkingLevel).toHaveBeenCalledWith(1);
		// Connect mode is fire-and-forget: the result arrives via SSE, so we
		// must not show any status here (no local level to display).
		expect(fakeThis.showStatus).not.toHaveBeenCalled();
		expect(fakeThis.footer.invalidate).not.toHaveBeenCalled();
		expect(fakeThis.updateEditorBorderColor).not.toHaveBeenCalled();
	});
});

describe("InteractiveMode cycle* methods in local mode (regression guard)", () => {
	it("cycleModel uses the local session and shows 'Only one model available' when nothing cycles", async () => {
		const sessionCycleModel = vi.fn(async (_direction: "forward" | "backward") => undefined);
		const fakeThis = createFakeThis({
			session: {
				cycleModel: sessionCycleModel,
				scopedModels: [],
			} as unknown as AgentSession,
		});

		await cycleModelProto.call(fakeThis, "forward");

		expect(sessionCycleModel).toHaveBeenCalledWith("forward");
		expect(fakeThis.showStatus).toHaveBeenCalledWith("Only one model available");
	});

	it("cycleModel shows 'Only one model in scope' when scopedModels is non-empty", async () => {
		const sessionCycleModel = vi.fn(async (_direction: "forward" | "backward") => undefined);
		const fakeThis = createFakeThis({
			session: {
				cycleModel: sessionCycleModel,
				scopedModels: [{ model: { id: "x" } }],
			} as unknown as AgentSession,
		});

		await cycleModelProto.call(fakeThis, "forward");

		expect(fakeThis.showStatus).toHaveBeenCalledWith("Only one model in scope");
	});

	it("cycleModel reports the switched model on success", async () => {
		const switched = {
			model: { id: "m2", name: "Two", reasoning: true },
			thinkingLevel: "high" as ThinkingLevel,
			isScoped: false,
		} as unknown as ModelCycleResult;
		const sessionCycleModel = vi.fn(async (_direction: "forward" | "backward") => switched);
		const fakeThis = createFakeThis({
			session: {
				cycleModel: sessionCycleModel,
				scopedModels: [],
			} as unknown as AgentSession,
		});

		await cycleModelProto.call(fakeThis, "forward");

		expect(fakeThis.showStatus).toHaveBeenCalledWith("Switched to Two (thinking: high)");
		expect(fakeThis.footer.invalidate).toHaveBeenCalledTimes(1);
		expect(fakeThis.updateEditorBorderColor).toHaveBeenCalledTimes(1);
		expect(fakeThis.maybeWarnAboutAnthropicSubscriptionAuth).toHaveBeenCalledWith(switched.model);
	});

	it("cycleThinkingLevel uses the local session and shows 'Current model does not support thinking' when undefined", () => {
		const fakeThis = createFakeThis({
			session: {
				cycleThinkingLevel: vi.fn(() => undefined),
			} as unknown as AgentSession,
		});

		cycleThinkingLevelProto.call(fakeThis);

		expect(fakeThis.showStatus).toHaveBeenCalledWith("Current model does not support thinking");
	});

	it("cycleThinkingLevel shows the new level on success", () => {
		const fakeThis = createFakeThis({
			session: {
				cycleThinkingLevel: vi.fn(() => "high" as ThinkingLevel),
			} as unknown as AgentSession,
		});

		cycleThinkingLevelProto.call(fakeThis);

		expect(fakeThis.showStatus).toHaveBeenCalledWith("Thinking level: high");
		expect(fakeThis.footer.invalidate).toHaveBeenCalledTimes(1);
		expect(fakeThis.updateEditorBorderColor).toHaveBeenCalledTimes(1);
	});
});
