import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionProxy } from "../../../src/core/agent-session-proxy.ts";
import { handleProtocolRequest } from "../../../src/modes/serve/protocol-core.ts";

/**
 * Regression test for Bug 1 in connect mode: the `Option+Up` shortcut
 * (queue restore) only cleared local TUI state. The server's queue was
 * unaffected. The fix added a `clear-queue` action to the protocol
 * core that calls `proxy.clearQueue()` and returns the dropped
 * messages so the connect client can put them back in the editor.
 */
describe("serve-mode /clear-queue action (Bug 1)", () => {
	let proxy: AgentSessionProxy & { clearQueue: ReturnType<typeof vi.fn> };

	beforeEach(() => {
		proxy = {
			clearQueue: vi.fn(() => ({ steering: ["a", "b"], followUp: ["c"] })),
		} as unknown as AgentSessionProxy & { clearQueue: ReturnType<typeof vi.fn> };
	});

	it("action 'clear-queue' invokes proxy.clearQueue() and returns the dropped messages", async () => {
		const result = await handleProtocolRequest(proxy, "clear-queue", undefined);
		expect(proxy.clearQueue).toHaveBeenCalledOnce();
		expect(result.status).toBe(200);
		const body = result.body as { ok: boolean; dropped: { steering: string[]; followUp: string[] } };
		expect(body.ok).toBe(true);
		expect(body.dropped).toEqual({ steering: ["a", "b"], followUp: ["c"] });
	});

	it("returns an empty snapshot when the session queue is empty", async () => {
		(proxy.clearQueue as ReturnType<typeof vi.fn>).mockReturnValueOnce({ steering: [], followUp: [] });
		const result = await handleProtocolRequest(proxy, "clear-queue", undefined);
		const body = result.body as { ok: boolean; dropped: { steering: string[]; followUp: string[] } };
		expect(body.dropped).toEqual({ steering: [], followUp: [] });
	});
});
