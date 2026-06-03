import { beforeEach, describe, expect, it } from "vitest";
import { createRemoteToolsExtension } from "../src/agent-extension/remote-tools.ts";

let fetchCalls: Array<{ url: string | URL | Request; init: RequestInit | undefined }> = [];
let fetchResponse: { ok: boolean; body: unknown } = { ok: true, body: { ok: true, result: "done" } };

function makeApi() {
	return { DPI_HUB_URL: "http://h:1234", DPI_AUTH_TOKEN: "tok", agentId: "agent-1" };
}

function fetchImpl(url: string | URL | Request, init?: RequestInit): Promise<Response> {
	fetchCalls.push({ url, init });
	return Promise.resolve(
		new Response(JSON.stringify(fetchResponse.body), {
			status: fetchResponse.ok ? 200 : 500,
		}),
	);
}

beforeEach(() => {
	fetchCalls = [];
	fetchResponse = { ok: true, body: { ok: true, result: "done" } };
});

describe("remote tools extension", () => {
	// capture all the tools passed to registerTool
	const registered: Record<
		string,
		{ description: string; execute: (toolCallId: string, params: unknown) => Promise<unknown> }
	> = {};

	function captureAll() {
		const prev = { ...registered };
		for (const k of Object.keys(prev)) delete registered[k];
		createRemoteToolsExtension({
			api: makeApi(),
			fetchImpl,
			registerTool: (name, def) => {
				// ToolDefinition.execute signature is (toolCallId, params, signal, onUpdate, ctx).
				// The def is typed as `unknown` here, but in practice it has `execute`.
				registered[name] = def as unknown as {
					description: string;
					execute: (toolCallId: string, params: unknown) => Promise<unknown>;
				};
			},
		});
	}

	describe("remote tools extension", () => {
		beforeEach(() => {
			captureAll();
		});

		it("registers 7 tools", () => {
			expect(Object.keys(registered).sort()).toEqual([
				"remote_bash",
				"remote_edit",
				"remote_find",
				"remote_grep",
				"remote_ls",
				"remote_read",
				"remote_write",
			]);
			expect(registered.remote_bash.description).toContain("bash");
			expect(registered.remote_read.description).toContain("read");
		});

		it("remote_bash handler POSTs to /agents/{id}/remote-call and returns the result", async () => {
			const out = await registered.remote_bash.execute("call-id-x", { command: "ls" });
			expect(out).toEqual("done");
			expect(fetchCalls).toHaveLength(1);
			const first = fetchCalls[0]!;
			expect(first.url.toString()).toBe("http://h:1234/agents/agent-1/remote-call");
			const init = first.init!;
			const body = JSON.parse(String(init.body));
			expect(body.tool).toBe("bash");
			expect(body.params).toEqual({ command: "ls" });
			expect(typeof body.callId).toBe("string");
		});

		it("throws when the hub returns ok: false", async () => {
			fetchResponse = { ok: true, body: { ok: false, error: "Executor not available" } };
			await expect(registered.remote_bash.execute("call-id-y", { command: "ls" })).rejects.toThrow(
				/Executor not available/,
			);
		});

		it("throws when fetchImpl throws", async () => {
			const prev = fetchImpl;
			try {
				// Swap fetchImpl to a throwing one and re-capture
				for (const k of Object.keys(registered)) delete registered[k];
				createRemoteToolsExtension({
					api: makeApi(),
					fetchImpl: () => Promise.reject(new Error("ECONNREFUSED")),
					registerTool: (name, def) => {
						registered[name] = def as unknown as {
							description: string;
							execute: (toolCallId: string, params: unknown) => Promise<unknown>;
						};
					},
				});
				await expect(registered.remote_bash.execute("call-id-z", { command: "ls" })).rejects.toThrow(
					/Hub unreachable/,
				);
			} finally {
				// restore by re-running the standard captureAll
				void prev;
				captureAll();
			}
		});

		it("propagates server errors with the hub status", async () => {
			fetchResponse = { ok: false, body: { error: "server down" } };
			await expect(registered.remote_bash.execute("call-id-w", { command: "ls" })).rejects.toThrow(
				/Hub returned 500/,
			);
		});
	});
});
