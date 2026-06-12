import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionProxy } from "../../../src/core/agent-session-proxy.ts";
import { handleApiRequest } from "../../../src/modes/serve/api-handlers.ts";

/**
 * Regression test for Bug 1 in connect mode: the `Option+Up` shortcut
 * (queue restore) only cleared local TUI state. The server's queue was
 * unaffected. The fix added a `clear-queue` HTTP endpoint to the
 * serve-mode API that calls `proxy.clearQueue()` and returns the
 * dropped messages so the connect client can put them back in the
 * editor.
 */
describe("serve-mode /clear-queue endpoint (Bug 1)", () => {
	let proxy: AgentSessionProxy & { clearQueue: ReturnType<typeof vi.fn> };
	let res: ServerResponse;
	let writeHead: ReturnType<typeof vi.fn>;
	let end: ReturnType<typeof vi.fn>;
	let capturedBody: string;

	beforeEach(() => {
		capturedBody = "";
		writeHead = vi.fn();
		end = vi.fn((body?: string) => {
			capturedBody = body ?? "";
		});
		res = {
			writeHead,
			end,
		} as unknown as ServerResponse;
		proxy = {
			clearQueue: vi.fn(() => ({ steering: ["a", "b"], followUp: ["c"] })),
		} as unknown as AgentSessionProxy & { clearQueue: ReturnType<typeof vi.fn> };
	});

	function makeReq(method: string, url: string, body: unknown): IncomingMessage {
		const req = {
			method,
			url,
			on: (event: string, handler: (data?: Buffer | Error) => void) => {
				if (event === "data") {
					// emit body chunks asynchronously; the handler awaits
					// 'end' before calling our handler
					queueMicrotask(() => handler(Buffer.from(body === undefined ? "" : JSON.stringify(body))));
				} else if (event === "end") {
					queueMicrotask(() => handler());
				}
			},
		};
		return req as unknown as IncomingMessage;
	}

	it("POST /clear-queue invokes proxy.clearQueue() and returns the dropped messages", async () => {
		await handleApiRequest(proxy, makeReq("POST", "/clear-queue", undefined), res);

		expect(proxy.clearQueue).toHaveBeenCalledOnce();
		expect(writeHead).toHaveBeenCalledWith(200, expect.objectContaining({ "Content-Type": "application/json" }));
		expect(end).toHaveBeenCalledOnce();

		const response = JSON.parse(capturedBody);
		expect(response.ok).toBe(true);
		expect(response.dropped).toEqual({ steering: ["a", "b"], followUp: ["c"] });
	});

	it("POST /clear-queue returns an empty snapshot when the session queue is empty", async () => {
		(proxy.clearQueue as ReturnType<typeof vi.fn>).mockReturnValueOnce({ steering: [], followUp: [] });
		await handleApiRequest(proxy, makeReq("POST", "/clear-queue", undefined), res);
		const response = JSON.parse(capturedBody);
		expect(response.dropped).toEqual({ steering: [], followUp: [] });
	});
});
