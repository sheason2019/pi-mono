import { stripVTControlCharacters } from "node:util";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { SourceRuntimeStatus } from "../../src/hub/index.js";
import { RemoteSourceDetailSelectorComponent } from "../../src/peer/tui/forked/components/source-detail-selector.js";
import { RemoteSourceListSelectorComponent } from "../../src/peer/tui/forked/components/source-list-selector.js";

const SAMPLE_SOURCES: SourceRuntimeStatus[] = [
	{ name: "src-one", transport: "stdio", agentId: "main", origin: "hub", status: "running" },
	{ name: "src-two", transport: "stdio", agentId: "main", origin: "hub", status: "stopped" },
	{
		name: "src-three",
		transport: "stdio",
		agentId: "main",
		origin: "hub",
		status: "error",
		error: "exited with code 1",
	},
];

describe("remote source list selector", () => {
	it("renders configured sources with name, status, and error details", () => {
		initTheme();
		const selector = new RemoteSourceListSelectorComponent(
			SAMPLE_SOURCES,
			() => {},
			() => {},
		);
		const lines = selector.render(100).map((line) => stripVTControlCharacters(line));

		expect(lines.some((line) => line.includes("Hub and Peer Sources"))).toBe(true);
		expect(lines.some((line) => line.includes("src-one") && line.includes("running"))).toBe(true);
		expect(lines.some((line) => line.includes("src-two") && line.includes("stopped"))).toBe(true);
		expect(lines.some((line) => line.includes("src-three") && line.includes("error"))).toBe(true);
		expect(lines.some((line) => line.includes("exited with code 1"))).toBe(true);
		expect(lines.some((line) => line.includes("Enter to inspect"))).toBe(true);
		expect(lines.some((line) => line.includes("Esc to close"))).toBe(true);
	});

	it("shows a placeholder when no sources are configured", () => {
		initTheme();
		const selector = new RemoteSourceListSelectorComponent(
			[],
			() => {},
			() => {},
		);
		const lines = selector.render(100).map((line) => stripVTControlCharacters(line));

		expect(lines.some((line) => line.toLowerCase().includes("no source"))).toBe(true);
	});

	it("moves the selection with arrow keys and confirms with Enter", () => {
		initTheme();
		const onSelect = vi.fn<(source: SourceRuntimeStatus) => void>();
		const selector = new RemoteSourceListSelectorComponent(SAMPLE_SOURCES, onSelect, () => {});

		selector.handleInput("\x1b[B");
		selector.handleInput("\x1b[B");
		selector.handleInput("\r");

		expect(onSelect).toHaveBeenCalledTimes(1);
		expect(onSelect.mock.calls[0]?.[0]?.name).toBe("src-three");
	});

	it("invokes onCancel when Esc is pressed", () => {
		initTheme();
		const onCancel = vi.fn();
		const selector = new RemoteSourceListSelectorComponent(SAMPLE_SOURCES, () => {}, onCancel);

		selector.handleInput("\x1b");

		expect(onCancel).toHaveBeenCalledTimes(1);
	});

	it("renders a bordered panel like other forked selectors", () => {
		initTheme();
		const selector = new RemoteSourceListSelectorComponent(
			SAMPLE_SOURCES,
			() => {},
			() => {},
		);
		const lines = selector.render(80).map((line) => stripVTControlCharacters(line));

		expect(lines[0]).toContain("─");
		expect(lines.at(-1)).toContain("─");
	});
});

describe("remote source detail selector", () => {
	it("renders source metadata and Pause/Restart/Remove actions", () => {
		initTheme();
		const selector = new RemoteSourceDetailSelectorComponent(
			SAMPLE_SOURCES[2]!,
			() => {},
			() => {},
		);
		const lines = selector.render(100).map((line) => stripVTControlCharacters(line));

		expect(lines.some((line) => line.includes("src-three"))).toBe(true);
		expect(lines.some((line) => line.toLowerCase().includes("status"))).toBe(true);
		expect(lines.some((line) => line.includes("error"))).toBe(true);
		expect(lines.some((line) => line.includes("exited with code 1"))).toBe(true);
		expect(lines.some((line) => line.toLowerCase().includes("pause"))).toBe(true);
		expect(lines.some((line) => line.toLowerCase().includes("restart"))).toBe(true);
		expect(lines.some((line) => line.toLowerCase().includes("remove"))).toBe(true);
		expect(lines.some((line) => line.includes("Config: hub workspace .pi/sources.json"))).toBe(true);
		expect(lines.some((line) => line.includes("source config file"))).toBe(true);
		expect(lines.some((line) => line.includes("Esc to go back"))).toBe(true);
	});

	it("invokes onAction with pause/restart/remove based on selection", () => {
		initTheme();
		const onAction = vi.fn<(action: "pause" | "restart" | "remove") => void>();
		const selector = new RemoteSourceDetailSelectorComponent(SAMPLE_SOURCES[0]!, onAction, () => {});

		selector.handleInput("\r");
		selector.handleInput("\x1b[B");
		selector.handleInput("\r");
		selector.handleInput("\x1b[B");
		selector.handleInput("\r");

		expect(onAction).toHaveBeenCalledTimes(3);
		expect(onAction.mock.calls.map((call) => call[0])).toEqual(["pause", "restart", "remove"]);
	});

	it("invokes onCancel when Esc is pressed", () => {
		initTheme();
		const onCancel = vi.fn();
		const selector = new RemoteSourceDetailSelectorComponent(SAMPLE_SOURCES[0]!, () => {}, onCancel);

		selector.handleInput("\x1b");

		expect(onCancel).toHaveBeenCalledTimes(1);
	});

	it("renders a bordered panel like other forked selectors", () => {
		initTheme();
		const selector = new RemoteSourceDetailSelectorComponent(
			SAMPLE_SOURCES[0]!,
			() => {},
			() => {},
		);
		const lines = selector.render(80).map((line) => stripVTControlCharacters(line));

		expect(lines[0]).toContain("─");
		expect(lines.at(-1)).toContain("─");
	});
});
