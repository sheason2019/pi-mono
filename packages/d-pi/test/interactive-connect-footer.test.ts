import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DPiInteractiveSessionStateSnapshot } from "../src/tui/interactive/agent-session-proxy.ts";
import {
	createDPiConnectFooterSnapshot,
	createDPiConnectMessageSnapshot,
	createDPiConnectStartupBanner,
	normalizeDPiConnectGitBranch,
} from "../src/tui/interactive/run-connect-interactive-mode.ts";

function snapshot(): DPiInteractiveSessionStateSnapshot {
	return {
		model: "stepfun/step-3.7-flash",
		thinkingLevel: "high",
		isStreaming: false,
		isCompacting: false,
		isBashRunning: false,
		steeringMessages: [],
		followUpMessages: [],
		sessionFile: undefined,
		sessionName: undefined,
		messages: [],
		banner: undefined,
		tokenUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, usingSubscription: false },
		contextUsage: { tokens: 0, contextWindow: 256000, percent: 0 },
		modelInfo: { id: "stepfun/step-3.7-flash", provider: "openrouter", reasoning: true, contextWindow: 256000 },
		autoCompactEnabled: true,
		cwd: "/remote/agent/root",
		availableProviderCount: 2,
		remoteSettings: {
			autoCompact: true,
			thinkingLevel: "high",
			availableThinkingLevels: ["off", "low", "medium", "high"],
			steeringMode: "all",
			followUpMode: "all",
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
		scopedModelIds: null,
		enabledModelPatterns: undefined,
		extensionPaths: [],
	};
}

describe("d-pi connect footer snapshot", () => {
	it("uses the local connect cwd for footer parity instead of the remote agent cwd", () => {
		const footerSnapshot = createDPiConnectFooterSnapshot(snapshot(), "/local/workspace");

		expect(footerSnapshot.cwd).toBe("/local/workspace");
		expect(snapshot().cwd).toBe("/remote/agent/root");
	});

	it("does not use local pi settings as a footer fallback when the remote snapshot has no model", () => {
		const home = mkdtempSync(join(tmpdir(), "d-pi-settings-home-"));
		mkdirSync(join(home, ".pi", "agent"), { recursive: true });
		writeFileSync(
			join(home, ".pi", "agent", "settings.json"),
			JSON.stringify({ defaultProvider: "stepfun", defaultModel: "step-3.7-flash", defaultThinkingLevel: "high" }),
		);
		const remote = {
			...snapshot(),
			model: "no-model",
			contextUsage: { tokens: null, contextWindow: 0, percent: null },
			modelInfo: { id: "", provider: "", reasoning: false, contextWindow: 0 },
		};

		const footerSnapshot = createDPiConnectFooterSnapshot(remote, join(home, "workspace"), { HOME: home });

		expect(footerSnapshot.cwd).toBe("~/workspace");
		expect(footerSnapshot.model).toBe("no-model");
		expect(footerSnapshot.thinkingLevel).toBe(remote.thinkingLevel);
		expect(footerSnapshot.contextUsage).toEqual({ tokens: null, contextWindow: 0, percent: null });
		expect(footerSnapshot.modelInfo).toEqual({ id: "", provider: "", reasoning: false, contextWindow: 0 });
	});

	it("preserves restored session messages when connecting to an existing agent", () => {
		const current = createDPiConnectMessageSnapshot({
			...snapshot(),
			messages: [
				{ role: "user", content: "old", timestamp: 100 },
				{ role: "user", content: "new", timestamp: 200 },
			],
		});

		expect(current.messages.map((message) => (message.role === "user" ? message.content : ""))).toEqual([
			"old",
			"new",
		]);
	});

	it("normalizes missing git branch output to null for native footer parity", () => {
		expect(normalizeDPiConnectGitBranch("feature/parity\n")).toBe("feature/parity");
		expect(normalizeDPiConnectGitBranch("")).toBeNull();
	});

	it("creates a local pi-compatible startup banner from connect cwd resources", () => {
		const home = mkdtempSync(join(tmpdir(), "d-pi-home-"));
		const repo = join(home, "workspace", "repo");
		const packageDir = join(repo, "packages", "d-pi");
		mkdirSync(packageDir, { recursive: true });
		writeFileSync(join(repo, "AGENTS.md"), "repo context");
		const skillsRoot = join(home, ".agents", "skills", "tmux");
		mkdirSync(skillsRoot, { recursive: true });
		writeFileSync(join(skillsRoot, "SKILL.md"), "tmux");

		const banner = createDPiConnectStartupBanner(packageDir, undefined, { HOME: home });

		expect(banner.appName).toBe("pi");
		expect(banner.changelogMarkdown).toContain("Warning: tmux extended-keys is off");
		expect(banner.changelogMarkdown).toContain("Update Available");
		expect(banner.loadedResources).toEqual([
			{
				name: "Context",
				compactList: "~/workspace/repo/AGENTS.md",
				expandedList: "~/workspace/repo/AGENTS.md",
			},
			{
				name: "Skills",
				compactList: "tmux",
				expandedList: "~/.agents/skills/tmux/SKILL.md",
			},
		]);
	});
});
