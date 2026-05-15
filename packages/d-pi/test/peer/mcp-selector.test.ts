import { stripVTControlCharacters } from "node:util";
import { initTheme } from "@sheason/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { McpRuntimeStatus } from "../../src/hub/index.js";
import { RemoteMcpDetailSelectorComponent } from "../../src/peer/tui/forked/components/mcp-detail-selector.js";
import { RemoteMcpListSelectorComponent } from "../../src/peer/tui/forked/components/mcp-list-selector.js";

const emptyCap = (): McpRuntimeStatus["capabilities"] => ({ tools: [], resources: [], prompts: [] });

const SAMPLE_SERVERS: McpRuntimeStatus[] = [
	{ name: "mcp-one", transport: "stdio", status: "running", capabilities: emptyCap() },
	{ name: "mcp-two", transport: "http", status: "stopped", capabilities: emptyCap() },
	{
		name: "mcp-three",
		transport: "stdio",
		status: "error",
		error: "connection failed",
		capabilities: emptyCap(),
	},
	{ name: "mcp-four", transport: "http", status: "starting", capabilities: emptyCap() },
];

describe("remote MCP list selector", () => {
	it("renders one row per server with name, transport, and status", () => {
		initTheme();
		const selector = new RemoteMcpListSelectorComponent(
			SAMPLE_SERVERS,
			undefined,
			() => {},
			() => {},
		);
		const lines = selector.render(100).map((line) => stripVTControlCharacters(line));

		expect(lines.some((line) => line.includes("mcp-one") && line.includes("stdio") && line.includes("running"))).toBe(
			true,
		);
		expect(lines.some((line) => line.includes("mcp-two") && line.includes("http") && line.includes("stopped"))).toBe(
			true,
		);
		expect(lines.some((line) => line.includes("mcp-three") && line.includes("error"))).toBe(true);
		expect(lines.some((line) => line.includes("mcp-four") && line.includes("starting"))).toBe(true);
	});

	it("renders configError as a single line at the top when set", () => {
		initTheme();
		const selector = new RemoteMcpListSelectorComponent(
			[],
			"mcp.json: invalid json",
			() => {},
			() => {},
		);
		const lines = selector.render(100).map((line) => stripVTControlCharacters(line));
		const configIdx = lines.findIndex((l) => l.includes("mcp.json: invalid json"));
		const titleIdx = lines.findIndex((l) => l.includes("Hub MCP Servers"));
		expect(configIdx).toBeGreaterThanOrEqual(0);
		expect(titleIdx).toBeGreaterThanOrEqual(0);
		expect(configIdx).toBeLessThan(titleIdx);
	});

	it("shows empty state when there are zero servers", () => {
		initTheme();
		const selector = new RemoteMcpListSelectorComponent(
			[],
			undefined,
			() => {},
			() => {},
		);
		const lines = selector.render(100).map((line) => stripVTControlCharacters(line));

		expect(
			lines.some((line) => line.includes("No MCP servers configured. Add <cwd>/.pi/mcp.json and run /reload.")),
		).toBe(true);
	});

	it("moves selection with arrow keys, Enter calls onSelectServer(server), Esc calls onCancel", () => {
		initTheme();
		const onSelect = vi.fn<(server: McpRuntimeStatus) => void>();
		const onCancel = vi.fn();
		const selector = new RemoteMcpListSelectorComponent(SAMPLE_SERVERS, undefined, onSelect, onCancel);

		selector.handleInput("\x1b[B");
		selector.handleInput("\x1b[B");
		selector.handleInput("\r");

		expect(onSelect).toHaveBeenCalledTimes(1);
		expect(onSelect.mock.calls[0]?.[0]).toBe(SAMPLE_SERVERS[2]);

		selector.handleInput("\x1b");
		expect(onCancel).toHaveBeenCalledTimes(1);
	});

	it("running server row shows capability counts as 1t / 2r / 3p style summary", () => {
		initTheme();
		const servers: McpRuntimeStatus[] = [
			{
				name: "cap",
				transport: "stdio",
				status: "running",
				capabilities: {
					tools: [{ name: "a" }],
					resources: [{ uri: "x" }, { uri: "y" }],
					prompts: [{ name: "p1" }, { name: "p2" }, { name: "p3" }],
				},
			},
		];
		const selector = new RemoteMcpListSelectorComponent(
			servers,
			undefined,
			() => {},
			() => {},
		);
		const text = stripVTControlCharacters(selector.render(120).join("\n"));
		expect(text).toMatch(/1t\s*\/\s*2r\s*\/\s*3p/);
	});

	it("disabled server row shows disabled in summary, not counts", () => {
		initTheme();
		const servers: McpRuntimeStatus[] = [
			{
				name: "off",
				transport: "stdio",
				status: "stopped",
				disabled: true,
				capabilities: { tools: [{ name: "t" }], resources: [], prompts: [] },
			},
		];
		const selector = new RemoteMcpListSelectorComponent(
			servers,
			undefined,
			() => {},
			() => {},
		);
		const text = stripVTControlCharacters(selector.render(120).join("\n"));
		expect(text).toContain("disabled");
		expect(text).not.toMatch(/\d+t\s*\/\s*\d+r\s*\/\s*\d+p/);
	});

	it("errored server shows error in row and no separate error: line", () => {
		initTheme();
		const servers: McpRuntimeStatus[] = [
			{
				name: "bad",
				transport: "http",
				status: "error",
				error: "connection failed",
				capabilities: emptyCap(),
			},
		];
		const selector = new RemoteMcpListSelectorComponent(
			servers,
			undefined,
			() => {},
			() => {},
		);
		const text = stripVTControlCharacters(selector.render(120).join("\n"));
		expect(text).toContain("[ERROR]");
		expect(text).not.toContain("connection failed");
		expect(text).not.toMatch(/error:\s*connection failed/);
	});
});

describe("remote MCP detail selector", () => {
	it("renders name, transport, and color-coded status in the header", () => {
		initTheme();
		const status: McpRuntimeStatus = {
			name: "gh",
			transport: "stdio",
			status: "running",
			capabilities: emptyCap(),
		};
		const selector = new RemoteMcpDetailSelectorComponent(
			status,
			() => {},
			() => {},
		);
		const lines = selector.render(100).map((line) => stripVTControlCharacters(line));

		expect(lines.some((line) => line.includes("gh"))).toBe(true);
		expect(lines.some((line) => line.includes("stdio"))).toBe(true);
		expect(lines.some((line) => line.includes("running"))).toBe(true);
	});

	it("omits Tools, Resources, and Prompts sections when their arrays are empty", () => {
		initTheme();
		const status: McpRuntimeStatus = {
			name: "empty-cap",
			transport: "http",
			status: "stopped",
			capabilities: emptyCap(),
		};
		const selector = new RemoteMcpDetailSelectorComponent(
			status,
			() => {},
			() => {},
		);
		const text = stripVTControlCharacters(selector.render(100).join("\n"));

		expect(text).not.toMatch(/Tools \(0\)/);
		expect(text).not.toMatch(/Resources \(0\)/);
		expect(text).not.toMatch(/Prompts \(0\)/);
	});

	it("renders all three capability sections when each has at least one entry", () => {
		initTheme();
		const status: McpRuntimeStatus = {
			name: "full",
			transport: "stdio",
			status: "running",
			capabilities: {
				tools: [{ name: "t1", description: "d1" }],
				resources: [{ uri: "u://a", name: "rn", description: "rd" }],
				prompts: [{ name: "p1", description: "pd" }],
			},
		};
		const selector = new RemoteMcpDetailSelectorComponent(
			status,
			() => {},
			() => {},
		);
		const text = stripVTControlCharacters(selector.render(120).join("\n"));

		expect(text).toContain("Tools (1)");
		expect(text).toContain("t1: d1");
		expect(text).toContain("Resources (1)");
		expect(text).toMatch(/u:\/\/a\s+\(rn\)/);
		expect(text).toContain("Prompts (1)");
		expect(text).toContain("p1: pd");
	});

	it("offers View Error for runtime errors and reveals the full error only after selection", () => {
		initTheme();
		const status: McpRuntimeStatus = {
			name: "bad",
			transport: "stdio",
			status: "error",
			error: "line one\nline two",
			capabilities: emptyCap(),
		};
		const selector = new RemoteMcpDetailSelectorComponent(
			status,
			() => {},
			() => {},
		);
		const closedText = stripVTControlCharacters(selector.render(100).join("\n"));
		expect(closedText).toContain("View Error");
		expect(closedText).not.toContain("line one");

		selector.handleInput("\r");

		const openText = stripVTControlCharacters(selector.render(100).join("\n"));
		expect(openText).toContain("MCP Error: bad");
		expect(openText).toContain("line one");
		expect(openText).toContain("line two");
	});

	it("disabled server shows (paused) in header and capability placeholder, not section headers", () => {
		initTheme();
		const status: McpRuntimeStatus = {
			name: "paused",
			transport: "stdio",
			status: "stopped",
			disabled: true,
			capabilities: {
				tools: [{ name: "t1" }],
				resources: [{ uri: "u://x" }],
				prompts: [{ name: "p1" }],
			},
		};
		const selector = new RemoteMcpDetailSelectorComponent(
			status,
			() => {},
			() => {},
		);
		const text = stripVTControlCharacters(selector.render(100).join("\n"));
		expect(text).toContain("(paused)");
		expect(text).toContain("Capabilities: (paused — capabilities not loaded)");
		expect(text).not.toMatch(/Tools\s*\(/);
		expect(text).not.toMatch(/Resources\s*\(/);
		expect(text).not.toMatch(/Prompts\s*\(/);
	});

	it("non-disabled resource with mimeType renders brackets after uri", () => {
		initTheme();
		const status: McpRuntimeStatus = {
			name: "r",
			transport: "stdio",
			status: "running",
			capabilities: {
				tools: [],
				resources: [{ uri: "file:///a", name: "n", mimeType: "text/plain", description: "d" }],
				prompts: [],
			},
		};
		const selector = new RemoteMcpDetailSelectorComponent(
			status,
			() => {},
			() => {},
		);
		const text = stripVTControlCharacters(selector.render(120).join("\n"));
		expect(text).toContain("file:///a [text/plain] (n): d");
	});

	it("moves action focus with arrows; Enter invokes onAction for pause/restart/remove", () => {
		initTheme();
		const onAction = vi.fn<(action: "pause" | "restart" | "remove") => void>();
		const status: McpRuntimeStatus = {
			name: "a",
			transport: "stdio",
			status: "running",
			capabilities: emptyCap(),
		};
		const selector = new RemoteMcpDetailSelectorComponent(status, onAction, () => {});

		selector.handleInput("\r");
		selector.handleInput("\x1b[B");
		selector.handleInput("\r");
		selector.handleInput("\x1b[B");
		selector.handleInput("\r");

		expect(onAction).toHaveBeenCalledTimes(3);
		expect(onAction.mock.calls.map((c) => c[0])).toEqual(["pause", "restart", "remove"]);
	});

	it("Esc invokes onCancelSelection", () => {
		initTheme();
		const onCancel = vi.fn();
		const status: McpRuntimeStatus = {
			name: "a",
			transport: "stdio",
			status: "running",
			capabilities: emptyCap(),
		};
		const selector = new RemoteMcpDetailSelectorComponent(status, () => {}, onCancel);

		selector.handleInput("\x1b");
		expect(onCancel).toHaveBeenCalledTimes(1);
	});
});
