import { describe, expect, it } from "vitest";
import type { DPiInteractiveSessionStateSnapshot } from "../src/tui/interactive/agent-session-proxy.ts";
import { buildDPiNativeFooterView } from "../src/tui/native/components/footer.ts";
import { createDPiNativeTheme, getDPiNativeEditorTheme } from "../src/tui/native/theme/theme.ts";

function snapshot(): DPiInteractiveSessionStateSnapshot {
	return {
		model: "stepfun/step-3.7-flash",
		isStreaming: false,
		isCompacting: false,
		isBashRunning: false,
		steeringMessages: [],
		followUpMessages: [],
		sessionFile: undefined,
		sessionName: "launch",
		messages: [],
		banner: undefined,
		tokenUsage: {
			input: 134,
			output: 132,
			cacheRead: 1200,
			cacheWrite: 0,
			cost: 0,
			usingSubscription: false,
			latestCacheHitRate: 48.9,
		},
		contextUsage: { tokens: 0, contextWindow: 256000, percent: 0 },
		modelInfo: { id: "stepfun/step-3.7-flash", provider: "stepfun", reasoning: true, contextWindow: 256000 },
		autoCompactEnabled: true,
		cwd: "~/workspace",
		availableProviderCount: 2,
		remoteSettings: {
			enableSkillCommands: true,
			doubleEscapeAction: "tree",
			showImages: true,
			imageWidthCells: 60,
			autoResizeImages: true,
			blockImages: false,
			transport: "auto",
			httpIdleTimeoutMs: 600000,
			currentTheme: "default",
			availableThemes: ["default"],
			hideThinkingBlock: false,
			collapseChangelog: false,
			enableInstallTelemetry: false,
			treeFilterMode: "all",
			showHardwareCursor: false,
			editorPaddingX: 0,
			autocompleteMaxVisible: 10,
			quietStartup: false,
			clearOnShrink: true,
			showTerminalProgress: true,
			warnings: {},
		},
		extensionPaths: [],
	};
}

describe("d-pi native footer and editor theme", () => {
	// Parity marker: footer-status:native-footer-editor
	it("renders footer from snapshot with upstream dimming and right alignment semantics", () => {
		const theme = createDPiNativeTheme({ color: true, colorMode: "truecolor" });
		const footer = buildDPiNativeFooterView({
			snapshot: snapshot(),
			gitBranch: "main",
			width: 100,
			theme,
		});

		expect(footer.lines[0]).toBe("\x1b[38;2;102;102;102m~/workspace (main) • launch\x1b[39m");
		expect(footer.lines[1]).toContain("\x1b[38;2;102;102;102m↑134 ↓132 R1.2k CH48.9% 0.0%/256k (auto)\x1b[39m");
		expect(footer.lines[1]).toContain("(stepfun) stepfun/step-3.7-flash");
	});

	it("uses native editor theme tokens", () => {
		const theme = createDPiNativeTheme({ color: true, colorMode: "truecolor" });
		const editorTheme = getDPiNativeEditorTheme(theme);

		expect(editorTheme.borderColor("─")).toBe("\x1b[38;2;80;80;80m─\x1b[39m");
		expect(editorTheme.selectList.selectedText("model")).toBe("\x1b[38;2;138;190;183mmodel\x1b[39m");
	});
});
