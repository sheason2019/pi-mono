import { describe, expect, it, vi } from "vitest";
import type { DPiInteractiveAgentSessionProxy } from "../src/tui/interactive/agent-session-proxy.ts";
import { handleDPiConnectSlashCommand } from "../src/tui/interactive/run-connect-interactive-mode.ts";
import { submitDPiInteractiveEditorText } from "../src/tui/interactive/submit.ts";

function createProxy(overrides: Partial<DPiInteractiveAgentSessionProxy> = {}): DPiInteractiveAgentSessionProxy {
	const proxy = {
		isStreaming: false,
		prompt: vi.fn(async () => {}),
		steer: vi.fn(),
	} as unknown as DPiInteractiveAgentSessionProxy;
	return { ...proxy, ...overrides };
}

describe("d-pi interactive editor submit", () => {
	it("reports prompt errors instead of leaving an unhandled rejection that crashes the TUI child", async () => {
		const error = new Error("prompt returned HTTP 500");
		const onError = vi.fn();
		const proxy = createProxy({
			prompt: vi.fn(async () => {
				throw error;
			}),
		});

		await expect(submitDPiInteractiveEditorText(proxy, "你好", onError)).resolves.toBeUndefined();

		expect(onError).toHaveBeenCalledWith(error);
		expect(proxy.prompt).toHaveBeenCalledWith("你好");
	});

	it("routes text to steer while the proxy is streaming", async () => {
		const proxy = createProxy({ isStreaming: true });

		await submitDPiInteractiveEditorText(proxy, "interrupt", vi.fn());

		expect(proxy.steer).toHaveBeenCalledWith("interrupt");
	});

	it("handles known connect slash commands locally instead of sending them as prompts", async () => {
		const statuses: string[] = [];
		const proxy = createProxy({
			prompt: vi.fn(async () => {}),
			reload: vi.fn(async () => {}),
			setModel: vi.fn(),
		});

		await expect(
			handleDPiConnectSlashCommand("/reload", {
				proxy,
				showStatus: (text) => statuses.push(text),
				stop: vi.fn(async () => {}),
			}),
		).resolves.toBe(true);
		await expect(
			handleDPiConnectSlashCommand("/model anthropic/claude-sonnet-4", {
				proxy,
				showStatus: (text) => statuses.push(text),
				stop: vi.fn(async () => {}),
			}),
		).resolves.toBe(true);

		expect(proxy.reload).toHaveBeenCalled();
		expect(proxy.setModel).toHaveBeenCalledWith("anthropic/claude-sonnet-4");
		expect(proxy.prompt).not.toHaveBeenCalled();
		expect(statuses).toEqual(["Reloaded", "Model: anthropic/claude-sonnet-4"]);
	});

	it("leaves unknown slash commands available for remote command handling", async () => {
		const proxy = createProxy();

		await expect(
			handleDPiConnectSlashCommand("/unknown arg", {
				proxy,
				showStatus: vi.fn(),
				stop: vi.fn(async () => {}),
			}),
		).resolves.toBe(false);
	});
});
