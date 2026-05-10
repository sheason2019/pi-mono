import { afterEach, describe, expect, it, vi } from "vitest";
import type { HubTuiViewModel } from "../../src/hub/tui/hub-tui-view.js";

const mockState = vi.hoisted(() => ({
	tuiInstances: [] as MockTui[],
	textInstances: [] as MockText[],
}));

class MockContainer {
	children: unknown[] = [];
	addChild(child: unknown): void {
		this.children.push(child);
	}
}

class MockText {
	value = "";
	constructor(value: string, _x: number, _y: number) {
		this.value = value;
		mockState.textInstances.push(this);
	}
	setText(value: string): void {
		this.value = value;
	}
}

class MockProcessTerminal {
	drainInput = vi.fn(async () => {});
}

class MockTui {
	terminal = new MockProcessTerminal();
	inputListeners: Array<(data: string) => { consume?: boolean } | undefined> = [];
	start = vi.fn();
	stop = vi.fn();
	requestRender = vi.fn();
	addChild = vi.fn();
	addInputListener(listener: (data: string) => { consume?: boolean } | undefined): () => void {
		this.inputListeners.push(listener);
		return () => {
			this.inputListeners = this.inputListeners.filter((entry) => entry !== listener);
		};
	}
}

vi.mock("@earendil-works/pi-tui", () => ({
	Container: MockContainer,
	getKeybindings: () => ({
		matches: (data: string, keybinding: string) => {
			if (keybinding === "tui.input.copy") return data === "\u0003" || data === "\x1b[99;5u";
			if (keybinding === "tui.editor.cursorUp") return data === "up";
			if (keybinding === "tui.editor.cursorDown") return data === "down";
			if (keybinding === "tui.editor.pageUp") return data === "pageup";
			if (keybinding === "tui.editor.pageDown") return data === "pagedown";
			if (keybinding === "tui.editor.cursorLineEnd") return data === "end";
			return false;
		},
	}),
	ProcessTerminal: MockProcessTerminal,
	Text: MockText,
	truncateToWidth: (text: string, width: number) => text.slice(0, width),
	TUI: class extends MockTui {
		constructor(_terminal: MockProcessTerminal, _debug: boolean) {
			super();
			mockState.tuiInstances.push(this);
		}
	},
	visibleWidth: (text: string) => text.length,
}));

function createView(): HubTuiViewModel {
	return {
		status: "running",
		address: "http://127.0.0.1:4317",
		workspace: "/tmp/workspace",
		protocolVersion: 2,
		agents: [],
		resources: {
			mcpServers: 0,
			sources: 0,
			skills: 0,
			prompts: 0,
			themes: 0,
		},
		logs: [],
	};
}

describe("HubTuiMode", () => {
	afterEach(() => {
		mockState.tuiInstances.length = 0;
		mockState.textInstances.length = 0;
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("stops the TUI and resolves when Ctrl+C is received as input", async () => {
		const { HubTuiMode } = await import("../../src/hub/tui/hub-tui-mode.js");
		const mode = new HubTuiMode({
			getView: createView,
			subscribe: () => () => {},
		});

		const runPromise = mode.run();
		const tui = mockState.tuiInstances[0];
		tui.inputListeners[0]?.("\u0003");

		await expect(runPromise).resolves.toBe(0);
		expect(tui.stop).toHaveBeenCalledTimes(1);
		expect(tui.terminal.drainInput).toHaveBeenCalled();
	});

	it("stops the TUI when Ctrl+C arrives as a Kitty keyboard sequence", async () => {
		const { HubTuiMode } = await import("../../src/hub/tui/hub-tui-mode.js");
		const mode = new HubTuiMode({
			getView: createView,
			subscribe: () => () => {},
		});

		const runPromise = mode.run();
		const tui = mockState.tuiInstances[0];
		try {
			tui.inputListeners[0]?.("\x1b[99;5u");

			const result = await Promise.race([
				runPromise,
				new Promise((resolve) => setTimeout(() => resolve("pending"), 0)),
			]);
			expect(result).toBe(0);
			expect(tui.stop).toHaveBeenCalledTimes(1);
		} finally {
			await mode.stop();
		}
	});

	it("renders periodically so runtime status changes update without pressing r", async () => {
		vi.useFakeTimers();
		const getView = vi.fn(createView);
		const { HubTuiMode } = await import("../../src/hub/tui/hub-tui-mode.js");
		const mode = new HubTuiMode({
			getView,
			subscribe: () => () => {},
			autoRefreshIntervalMs: 50,
		});

		void mode.run();
		expect(getView).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(150);

		expect(getView).toHaveBeenCalledTimes(4);
		await mode.stop();
	});

	it("opens logs with l, scrolls them, and returns to status with q", async () => {
		const { HubTuiMode } = await import("../../src/hub/tui/hub-tui-mode.js");
		const view = createView();
		view.logs = [
			{ timestamp: Date.UTC(2026, 3, 26, 2, 58, 0), level: "info", message: "very-old" },
			{ timestamp: Date.UTC(2026, 3, 26, 2, 59, 0), level: "info", message: "old" },
			{ timestamp: Date.UTC(2026, 3, 26, 3, 0, 0), level: "info", message: "middle" },
			{ timestamp: Date.UTC(2026, 3, 26, 3, 1, 0), level: "info", message: "recent" },
			{ timestamp: Date.UTC(2026, 3, 26, 3, 2, 0), level: "info", message: "new" },
		];
		const mode = new HubTuiMode({
			getView: () => view,
			subscribe: () => () => {},
			autoRefreshIntervalMs: 0,
			getTerminalSize: () => ({ columns: 120, rows: 8 }),
		});

		void mode.run();
		const tui = mockState.tuiInstances[0];
		const text = mockState.textInstances[0]!;
		expect(text.value).toContain("pi-hub 运行中");
		expect(text.value).not.toContain("new");

		tui.inputListeners[0]?.("l");

		expect(text.value).toContain("middle");
		expect(text.value).toContain("new");

		tui.inputListeners[0]?.("up");

		expect(text.value).toContain("old");
		expect(text.value).toContain("middle");
		expect(text.value).not.toContain("new");

		tui.inputListeners[0]?.("end");

		expect(text.value).toContain("new");

		tui.inputListeners[0]?.("q");

		expect(text.value).toContain("pi-hub 运行中");
		expect(text.value).not.toContain("new");
		expect(tui.stop).not.toHaveBeenCalled();
		await mode.stop();
	});
});
