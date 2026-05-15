import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { ExtensionContext } from "@sheason/pi-coding-agent";
import { Value } from "typebox/value";
import { describe, expect, it, vi } from "vitest";
import { jsonSchemaToTypebox } from "../../src/hub/mcp/json-schema-to-typebox.js";
import type { McpClientHandle } from "../../src/hub/mcp/mcp-client.js";
import {
	buildMcpPrefixedToolName,
	wrapMcpServerAsToolDefinitions,
	wrapMcpToolAsToolDefinition,
} from "../../src/hub/mcp/mcp-tool-bridge.js";

const ctx = { notify: () => {} } as unknown as ExtensionContext;

function createStubClient(partial: Partial<Client> & { callTool: Client["callTool"] }): Client {
	return partial as Client;
}

describe("wrapMcpToolAsToolDefinition", () => {
	it("uses mcp__ server __ tool prefix, label, and description", () => {
		const callTool = vi.fn();
		const client = createStubClient({
			callTool: callTool as Client["callTool"],
		});
		callTool.mockResolvedValue({ content: [{ type: "text", text: "ok" }], isError: false });
		const r = wrapMcpToolAsToolDefinition("mySrv", client, {
			name: "doThing",
			description: "Does a thing",
			inputSchema: { type: "object", properties: { x: { type: "string" } } },
		});
		expect("skipped" in r).toBe(false);
		if ("skipped" in r) {
			return;
		}
		const def = r;
		expect(def.name).toBe("mcp__mySrv__doThing");
		expect(def.label).toBe("doThing");
		expect(def.description).toBe("Does a thing");
	});

	it("converts inputSchema with jsonSchemaToTypebox (integration)", () => {
		const callTool = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
		const r = wrapMcpToolAsToolDefinition("s", createStubClient({ callTool: callTool as Client["callTool"] }), {
			name: "t",
			inputSchema: { type: "object", properties: { n: { type: "number" } }, required: ["n"] },
		});
		expect("skipped" in r).toBe(false);
		if ("skipped" in r) {
			return;
		}
		const expected = jsonSchemaToTypebox({
			type: "object",
			properties: { n: { type: "number" } },
			required: ["n"],
		});
		expect(Value.Check(r.parameters, { n: 1 })).toBe(true);
		expect(r.parameters).toEqual(expected);
	});

	it("execute round-trips callTool with unprefixed name and args", async () => {
		const callTool = vi
			.fn()
			.mockResolvedValue({ content: [{ type: "text", text: "pong" }], isError: false, structuredContent: { v: 1 } });
		const r = wrapMcpToolAsToolDefinition("s", createStubClient({ callTool: callTool as Client["callTool"] }), {
			name: "ping",
			inputSchema: { type: "object", properties: { k: { type: "string" } }, required: ["k"] },
		});
		expect("skipped" in r).toBe(false);
		if ("skipped" in r) {
			return;
		}
		const out = await r.execute("tc1", { k: "a" }, undefined, undefined, ctx);
		expect(callTool).toHaveBeenCalledWith({ name: "ping", arguments: { k: "a" } }, undefined, expect.anything());
		expect(out.content).toEqual([{ type: "text", text: "pong" }]);
		expect((out.details as { structuredContent?: unknown } | null)?.structuredContent).toEqual({ v: 1 });
	});

	it("throws to signal tool error when result.isError is true", async () => {
		const callTool = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "nope" }], isError: true });
		const r = wrapMcpToolAsToolDefinition("s", createStubClient({ callTool: callTool as Client["callTool"] }), {
			name: "f",
			inputSchema: { type: "object", properties: {} },
		});
		expect("skipped" in r).toBe(false);
		if ("skipped" in r) {
			return;
		}
		await expect(r.execute("x", {}, undefined, undefined, ctx)).rejects.toThrow(/mcp|nope|tool/i);
	});

	it("throws when callTool rejects", async () => {
		const callTool = vi.fn().mockRejectedValue(new Error("transport down"));
		const r = wrapMcpToolAsToolDefinition("s", createStubClient({ callTool: callTool as Client["callTool"] }), {
			name: "g",
			inputSchema: { type: "object", properties: {} },
		});
		expect("skipped" in r).toBe(false);
		if ("skipped" in r) {
			return;
		}
		await expect(r.execute("x", {}, undefined, undefined, ctx)).rejects.toThrow("transport down");
	});

	it("skips when prefixed name is longer than 64 characters", () => {
		const server = "a".repeat(20);
		const tool = "b".repeat(50);
		const r = wrapMcpToolAsToolDefinition(
			server,
			createStubClient({ callTool: (async () => ({})) as unknown as Client["callTool"] }),
			{ name: tool, inputSchema: {} },
		);
		expect("skipped" in r).toBe(true);
		if (!("skipped" in r)) {
			return;
		}
		expect(r.toolName).toBe(tool);
		expect(r.reason).toMatch(/64|length|long/i);
	});

	it("skips when prefixed name has invalid characters", () => {
		const r = wrapMcpToolAsToolDefinition(
			"sv",
			createStubClient({ callTool: (async () => ({})) as unknown as Client["callTool"] }),
			{ name: "bad name spaces", inputSchema: {} },
		);
		expect("skipped" in r).toBe(true);
	});

	it("double-prefix: server tool named mcp__x__y gets prefixed again under a different server", () => {
		// 8 ("mcp__a__") + 56 inner = 64 chars max; keep full prefixed name in valid range
		const long = `mcp__${"z".repeat(29)}__${"q".repeat(20)}`;
		const name = buildMcpPrefixedToolName("a", long);
		expect(name.length).toBeLessThanOrEqual(64);
		expect(name).toMatch(/^[a-zA-Z0-9_-]+$/);
		const r = wrapMcpToolAsToolDefinition(
			"a",
			createStubClient({ callTool: (async () => ({})) as unknown as Client["callTool"] }),
			{ name: long, inputSchema: { type: "object", properties: {} } },
		);
		if ("skipped" in r) {
			expect(r.reason).toBeDefined();
		} else {
			expect(r.name.length).toBeLessThanOrEqual(64);
		}
	});
});

describe("wrapMcpServerAsToolDefinitions", () => {
	it("adds resource synthetic tools only when supportedCapabilities.resources", () => {
		const listResources = vi.fn().mockResolvedValue({ resources: [] });
		const readResource = vi.fn();
		const client = createStubClient({
			callTool: vi.fn() as Client["callTool"],
			listResources: listResources as Client["listResources"],
			readResource: readResource as Client["readResource"],
			listPrompts: vi.fn() as Client["listPrompts"],
			getPrompt: vi.fn() as Client["getPrompt"],
		});
		const hOn: McpClientHandle = {
			client,
			capabilities: { tools: [], resources: [], prompts: [] },
			supportedCapabilities: { tools: false, resources: true, prompts: false },
			transport: "stdio",
			close: async () => {},
		};
		const on = wrapMcpServerAsToolDefinitions("u", hOn);
		const names = on.tools.map((t) => t.name);
		expect(names).toContain("mcp__u__list_resources");
		expect(names).toContain("mcp__u__read_resource");

		const hOff: McpClientHandle = {
			...hOn,
			supportedCapabilities: { tools: false, resources: false, prompts: false },
		};
		const off = wrapMcpServerAsToolDefinitions("u2", hOff);
		expect(off.tools.map((t) => t.name).some((n) => n.includes("list_resources"))).toBe(false);
		expect(off.skipped.some((s) => s.kind === "resource")).toBe(true);
	});

	it("adds prompt synthetic tools only when supportedCapabilities.prompts", () => {
		const listPrompts = vi.fn().mockResolvedValue({ prompts: [] });
		const getPrompt = vi.fn();
		const client = createStubClient({
			callTool: vi.fn() as Client["callTool"],
			listResources: vi.fn() as Client["listResources"],
			readResource: vi.fn() as Client["readResource"],
			listPrompts: listPrompts as Client["listPrompts"],
			getPrompt: getPrompt as Client["getPrompt"],
		});
		const h: McpClientHandle = {
			client,
			capabilities: { tools: [], resources: [], prompts: [] },
			supportedCapabilities: { tools: false, resources: false, prompts: true },
			transport: "stdio",
			close: async () => {},
		};
		const { tools } = wrapMcpServerAsToolDefinitions("p", h);
		expect(tools.map((t) => t.name).sort()).toEqual(["mcp__p__get_prompt", "mcp__p__list_prompts"].sort());
	});

	it("synthetic list_resources calls client.listResources with pagination and returns contents", async () => {
		const listResources = vi
			.fn()
			.mockResolvedValueOnce({ resources: [{ uri: "a" }], nextCursor: "c1" })
			.mockResolvedValueOnce({ resources: [{ uri: "b" }] });
		const client = createStubClient({
			callTool: vi.fn() as Client["callTool"],
			listResources: listResources as Client["listResources"],
			readResource: vi.fn() as Client["readResource"],
			listPrompts: vi.fn() as Client["listPrompts"],
			getPrompt: vi.fn() as Client["getPrompt"],
		});
		const h: McpClientHandle = {
			client,
			capabilities: { tools: [], resources: [], prompts: [] },
			supportedCapabilities: { tools: false, resources: true, prompts: false },
			transport: "stdio",
			close: async () => {},
		};
		const { tools } = wrapMcpServerAsToolDefinitions("srv", h);
		const def = tools.find((t) => t.name === "mcp__srv__list_resources");
		expect(def).toBeDefined();
		const res = await def!.execute("id", {}, undefined, undefined, ctx);
		expect(listResources).toHaveBeenCalled();
		const detail = res.details as { resources: { uri: string }[] };
		expect(detail.resources.map((r) => r.uri).sort()).toEqual(["a", "b"]);
	});

	it("synthetic read_resource calls readResource and returns details.contents", async () => {
		const readResource = vi.fn().mockResolvedValue({
			contents: [{ uri: "u", mimeType: "text/plain", text: "hi" }],
		});
		const client = createStubClient({
			callTool: vi.fn() as Client["callTool"],
			listResources: vi.fn() as Client["listResources"],
			readResource: readResource as Client["readResource"],
			listPrompts: vi.fn() as Client["listPrompts"],
			getPrompt: vi.fn() as Client["getPrompt"],
		});
		const h: McpClientHandle = {
			client,
			capabilities: { tools: [], resources: [], prompts: [] },
			supportedCapabilities: { tools: false, resources: true, prompts: false },
			transport: "stdio",
			close: async () => {},
		};
		const { tools } = wrapMcpServerAsToolDefinitions("r", h);
		const def = tools.find((t) => t.name === "mcp__r__read_resource");
		const out = await def!.execute("id", { uri: "u://x" }, undefined, undefined, ctx);
		expect(readResource).toHaveBeenCalledWith({ uri: "u://x" }, expect.anything());
		const d = out.details as { contents: unknown };
		expect(d.contents).toEqual([{ uri: "u", mimeType: "text/plain", text: "hi" }]);
	});

	it("synthetic get_prompt calls getPrompt with name and string arguments", async () => {
		const getPrompt = vi
			.fn()
			.mockResolvedValue({ messages: [{ role: "user", content: { type: "text", text: "h" } }] });
		const client = createStubClient({
			callTool: vi.fn() as Client["callTool"],
			listResources: vi.fn() as Client["listResources"],
			readResource: vi.fn() as Client["readResource"],
			listPrompts: vi.fn() as Client["listPrompts"],
			getPrompt: getPrompt as Client["getPrompt"],
		});
		const h: McpClientHandle = {
			client,
			capabilities: { tools: [], resources: [], prompts: [] },
			supportedCapabilities: { tools: false, resources: false, prompts: true },
			transport: "stdio",
			close: async () => {},
		};
		const { tools } = wrapMcpServerAsToolDefinitions("g", h);
		const def = tools.find((t) => t.name === "mcp__g__get_prompt");
		await def!.execute("id", { name: "P", arguments: { a: "b" } }, undefined, undefined, ctx);
		expect(getPrompt).toHaveBeenCalledWith({ name: "P", arguments: { a: "b" } }, expect.anything());
	});

	it("skips server tool when synthetic already consumed the prefixed name", () => {
		const callTool = vi.fn();
		const client = createStubClient({
			callTool: callTool as Client["callTool"],
			listResources: vi.fn().mockResolvedValue({ resources: [] }) as Client["listResources"],
			readResource: vi.fn() as Client["readResource"],
			listPrompts: vi.fn() as Client["listPrompts"],
			getPrompt: vi.fn() as Client["getPrompt"],
		});
		const h: McpClientHandle = {
			client,
			capabilities: {
				tools: [{ name: "list_resources", description: "from server" }],
				resources: [],
				prompts: [],
			},
			supportedCapabilities: { tools: true, resources: true, prompts: false },
			transport: "stdio",
			close: async () => {},
		};
		const { tools, skipped } = wrapMcpServerAsToolDefinitions("dup", h);
		const names = tools.map((t) => t.name);
		expect(names.filter((n) => n === "mcp__dup__list_resources").length).toBe(1);
		expect(skipped.some((s) => s.kind === "resource" && s.name === "list_resources")).toBe(true);
	});
});
