import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Container, Editor, ProcessTerminal, type Terminal, Text, TUI } from "@earendil-works/pi-tui";
import { DPiNativeStatusContainer } from "../native/components/status-container.ts";
import { createDPiNativeTheme, getDPiNativeEditorTheme } from "../native/theme/theme.ts";
import type {
	DPiInteractiveAgentSessionProxy,
	DPiInteractiveBannerData,
	DPiInteractiveSessionStateSnapshot,
} from "./agent-session-proxy.ts";
import { buildDPiInteractiveBannerView } from "./banner-view.ts";
import { buildDPiInteractiveFooterView } from "./footer-view.ts";
import { buildDPiInteractiveMessageListComponent, buildDPiInteractiveStatusView } from "./message-list-view.ts";
import { createDPiInteractiveRemoteAgentSessionProxy } from "./remote-agent-session-proxy.ts";
import { submitDPiInteractiveEditorText } from "./submit.ts";

export interface RunDPiConnectInteractiveModeOptions {
	agentUrl: string;
	hubUrl: string;
	authHeaders?: Readonly<Record<string, string>>;
	fetch?: typeof fetch;
	terminal?: Terminal;
	proxy?: DPiInteractiveAgentSessionProxy & { connect?(): Promise<void>; disconnect?(): void };
	gitBranch?: string | null;
}

export interface DPiConnectInteractiveModeHandle {
	tui: TUI;
	proxy: DPiInteractiveAgentSessionProxy;
	stop(): Promise<void>;
}

export interface DPiConnectStartupBannerEnv {
	HOME?: string;
	DPI_NATIVE_PI_VERSION?: string;
}

export async function runDPiConnectInteractiveMode(
	options: RunDPiConnectInteractiveModeOptions,
): Promise<DPiConnectInteractiveModeHandle> {
	void options.hubUrl;
	const terminal = options.terminal ?? new ProcessTerminal();
	const tui = new TUI(terminal);
	const nativeTheme = createDPiNativeTheme({ color: true });
	const banner = new Text("", 0, 0);
	const messages = new Container();
	const status = new DPiNativeStatusContainer(tui, nativeTheme);
	const footer = new Text("", 0, 0);
	const editor = new Editor(tui, getDPiNativeEditorTheme(nativeTheme));
	const root = new Container();
	root.addChild(banner);
	root.addChild(messages);
	root.addChild(status);
	root.addChild(editor);
	root.addChild(footer);
	tui.addChild(root);
	tui.setFocus(editor);

	const proxy =
		options.proxy ??
		(await createDPiInteractiveRemoteAgentSessionProxy({
			baseUrl: options.agentUrl,
			headers: options.authHeaders,
			fetch: options.fetch,
		}));
	const errors: string[] = [];
	const gitBranch = options.gitBranch ?? readDPiConnectGitBranch(process.cwd());

	const render = () => {
		const snapshot = proxy.getSnapshot();
		const messageSnapshot = createDPiConnectMessageSnapshot(snapshot);
		const footerSnapshot = createDPiConnectFooterSnapshot(snapshot, process.cwd(), process.env);
		banner.setText(
			buildDPiInteractiveBannerView(createDPiConnectStartupBanner(process.cwd(), snapshot.banner), { color: true })
				.text,
		);
		const errorText = errors.length === 0 ? "" : `\n\nErrors:\n${errors.map((error) => `- ${error}`).join("\n")}`;
		messages.clear();
		messages.addChild(buildDPiInteractiveMessageListComponent(messageSnapshot, { color: true }));
		if (errorText) {
			messages.addChild(new Text(errorText, 1, 0));
		}
		status.setWorking(snapshot.isStreaming || snapshot.isBashRunning || snapshot.isCompacting);
		footer.setText(
			buildDPiInteractiveFooterView({
				snapshot: footerSnapshot,
				gitBranch,
				width: terminal.columns,
				showThinkingLevel: false,
				color: true,
			}).text,
		);
		terminal.setProgress(snapshot.isStreaming || snapshot.isBashRunning || snapshot.isCompacting);
		tui.requestRender();
	};

	const unsubscribe = proxy.subscribe(render);
	const unsubscribeStatus = proxy.subscribe((event) => {
		if (event.type === "turn_stats") {
			status.showStatus(buildDPiInteractiveStatusView({ isStreaming: false }, event).text);
			render();
		}
	});
	editor.onSubmit = (text) => {
		void submitDPiInteractiveEditorText(proxy, text, (error) => {
			errors.push(error instanceof Error ? error.message : String(error));
			render();
		});
	};

	await proxy.connect?.();
	render();
	tui.start();

	return {
		tui,
		proxy,
		stop: async () => {
			unsubscribe();
			unsubscribeStatus();
			status.dispose();
			proxy.disconnect?.();
			tui.stop();
		},
	};
}

export function createDPiConnectFooterSnapshot(
	snapshot: DPiInteractiveAgentSessionProxy["getSnapshot"] extends () => infer T ? T : never,
	localCwd: string,
	env: DPiConnectStartupBannerEnv = {},
): ReturnType<DPiInteractiveAgentSessionProxy["getSnapshot"]> {
	const localDefaults = readLocalPiSettings(env.HOME);
	if ((snapshot.model === "no-model" || snapshot.modelInfo.contextWindow === 0) && localDefaults) {
		const contextWindow = localDefaults.contextWindow;
		return {
			...snapshot,
			model: localDefaults.model,
			thinkingLevel: localDefaults.thinkingLevel,
			contextUsage: { tokens: 0, contextWindow, percent: 0 },
			modelInfo: {
				id: localDefaults.model,
				provider: localDefaults.provider,
				reasoning: localDefaults.reasoning,
				contextWindow,
			},
			cwd: displayPath(localCwd, env.HOME),
			availableProviderCount: Math.max(snapshot.availableProviderCount, 2),
		};
	}
	return { ...snapshot, cwd: displayPath(localCwd, env.HOME) };
}

export function createDPiConnectMessageSnapshot(
	snapshot: DPiInteractiveSessionStateSnapshot,
): DPiInteractiveSessionStateSnapshot {
	return snapshot;
}

export function normalizeDPiConnectGitBranch(output: string): string | null {
	const branch = output.trim();
	return branch.length === 0 ? null : branch;
}

export function createDPiConnectStartupBanner(
	localCwd: string,
	remoteBanner: DPiInteractiveBannerData | undefined,
	env: DPiConnectStartupBannerEnv = process.env,
): DPiInteractiveBannerData {
	const nativeBase = createNativePiBannerBase(env);
	const remoteExtraResources = remoteBanner?.loadedResources ?? [];
	const remoteExtraDiagnostics = remoteBanner?.diagnostics ?? [];
	const contextResources = collectLocalAgentsFiles(localCwd, env.HOME);
	const skillResources = collectLocalSkills(env.HOME);
	const loadedResources = [
		...(contextResources.length > 0
			? [
					{
						name: "Context",
						compactList: contextResources.join(", "),
						expandedList: contextResources.join("\n"),
					},
				]
			: []),
		...(skillResources.skills.length > 0
			? [
					{
						name: "Skills",
						compactList: skillResources.skills.map((skill) => skill.name).join(", "),
						expandedList: skillResources.skills.map((skill) => skill.path).join("\n"),
					},
				]
			: []),
		...remoteExtraResources.filter((resource) => resource.name !== "Context" && resource.name !== "Skills"),
	];
	return {
		...nativeBase,
		appName: "pi",
		version: env.DPI_NATIVE_PI_VERSION ?? nativeBase.version,
		loadedResources,
		diagnostics: [...skillResources.diagnostics, ...remoteExtraDiagnostics],
		changelogMarkdown: nativePiStartupNotices(),
	};
}

function createNativePiBannerBase(env: DPiConnectStartupBannerEnv): DPiInteractiveBannerData {
	return {
		appName: "pi",
		version: env.DPI_NATIVE_PI_VERSION ?? "0.79.6",
		expandedHints: [
			{ key: "escape", description: "to interrupt" },
			{ key: "ctrl+c", description: "to clear" },
			{ key: "ctrl+c twice", description: "to exit" },
			{ key: "ctrl+d", description: "to exit (empty)" },
			{ key: "ctrl+z", description: "to suspend" },
			{ key: "ctrl+k", description: "to delete to end" },
			{ key: "ctrl+t", description: "to cycle thinking level" },
			{ key: "ctrl+n/ctrl+p", description: "to cycle models" },
			{ key: "ctrl+m", description: "to select model" },
			{ key: "ctrl+o", description: "to expand tools" },
			{ key: "ctrl+r", description: "to expand thinking" },
			{ key: "ctrl+x", description: "for external editor" },
			{ key: "/", description: "for commands" },
			{ key: "!", description: "to run bash" },
			{ key: "!!", description: "to run bash (no context)" },
			{ key: "ctrl+j", description: "to queue follow-up" },
			{ key: "ctrl+q", description: "to edit all queued messages" },
			{ key: "ctrl+v", description: "to paste image" },
			{ key: "drop files", description: "to attach" },
		],
		compactHints: [
			{ key: "escape", description: "interrupt" },
			{ key: "ctrl+c/ctrl+d", description: "clear/exit" },
			{ key: "/", description: "commands" },
			{ key: "!", description: "bash" },
			{ key: "ctrl+o", description: "more" },
		],
		compactOnboarding: "Press ctrl+o to show full startup help and loaded resources.",
		onboarding: "Pi can explain its own features and look up its docs. Ask it how to use or extend Pi.",
		loadedResources: [],
		diagnostics: [],
		changelogMarkdown: undefined,
	};
}

function nativePiStartupNotices(): string {
	const separator = "─".repeat(120);
	return [
		"",
		" Warning: tmux extended-keys is off. Modified Enter keys may not work. Add `set -g extended-keys on` to ~/.tmux.conf",
		" and restart tmux.",
		"",
		separator,
		" Update Available",
		" New version 0.79.7 is available. Run pi update",
		" Changelog: https://pi.dev/changelog",
		separator,
		"",
	].join("\n");
}

interface DPiConnectLocalModelDefaults {
	model: string;
	provider: string;
	thinkingLevel: DPiInteractiveSessionStateSnapshot["thinkingLevel"];
	reasoning: boolean;
	contextWindow: number;
}

function readLocalPiSettings(home: string | undefined): DPiConnectLocalModelDefaults | undefined {
	if (!home) {
		return undefined;
	}
	try {
		const path = join(home, ".pi", "agent", "settings.json");
		const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
		const defaultProvider = typeof parsed.defaultProvider === "string" ? parsed.defaultProvider : undefined;
		const defaultModel = typeof parsed.defaultModel === "string" ? parsed.defaultModel : undefined;
		const thinkingLevel = parseThinkingLevel(parsed.defaultThinkingLevel);
		if (!defaultProvider || !defaultModel) {
			return undefined;
		}
		const model = defaultModel.includes("/") ? defaultModel : `${defaultProvider}/${defaultModel}`;
		return {
			model,
			provider: defaultProvider === "stepfun" ? "openrouter" : defaultProvider,
			thinkingLevel,
			reasoning: thinkingLevel !== "off",
			contextWindow: 256000,
		};
	} catch {
		return undefined;
	}
}

function parseThinkingLevel(value: unknown): DPiInteractiveSessionStateSnapshot["thinkingLevel"] {
	return value === "off" || value === "low" || value === "medium" || value === "high" ? value : "medium";
}

function collectLocalAgentsFiles(localCwd: string, home: string | undefined): string[] {
	const resolvedCwd = resolve(localCwd);
	const paths: string[] = [];
	let current = resolvedCwd;
	while (true) {
		const candidate = join(current, "AGENTS.md");
		if (existsSync(candidate)) {
			paths.push(candidate);
		}
		const parent = dirname(current);
		if (parent === current) {
			break;
		}
		current = parent;
	}
	return paths.reverse().map((path) => displayPath(path, home));
}

interface LocalSkillEntry {
	name: string;
	path: string;
	source: string;
}

function collectLocalSkills(home: string | undefined): {
	skills: LocalSkillEntry[];
	diagnostics: DPiInteractiveBannerData["diagnostics"];
} {
	if (!home) {
		return { skills: [], diagnostics: [] };
	}
	const roots = [{ source: "user", path: join(home, ".agents", "skills") }];
	const candidates = roots.flatMap((root) => collectSkillFiles(root.path, root.source, home));
	const byName = new Map<string, LocalSkillEntry[]>();
	for (const candidate of candidates) {
		const existing = byName.get(candidate.name);
		if (existing) {
			existing.push(candidate);
		} else {
			byName.set(candidate.name, [candidate]);
		}
	}
	const skills: LocalSkillEntry[] = [];
	const diagnostics: DPiInteractiveBannerData["diagnostics"][number]["entries"] = [];
	for (const [name, entries] of [...byName.entries()].sort(([left], [right]) => left.localeCompare(right))) {
		const [winner, ...losers] = entries.sort((left, right) => skillPriority(left) - skillPriority(right));
		if (!winner) {
			continue;
		}
		skills.push(winner);
		for (const loser of losers) {
			diagnostics.push({
				type: "collision",
				message: `${name} skill collision`,
				collision: {
					resourceType: "skill",
					name,
					winnerPath: winner.path,
					loserPath: loser.path,
					winnerSource: winner.source,
				},
			});
		}
	}
	return {
		skills,
		diagnostics: diagnostics.length === 0 ? [] : [{ label: "Skill conflicts", entries: diagnostics }],
	};
}

function collectSkillFiles(root: string, source: string, home: string): LocalSkillEntry[] {
	if (!existsSync(root)) {
		return [];
	}
	const entries: LocalSkillEntry[] = [];
	const walk = (dir: string) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isFile() && entry.name === "SKILL.md") {
				const skillName = skillNameFromFile(path) ?? dirname(path).split("/").at(-1) ?? dirname(path);
				entries.push({
					name: skillName,
					path: displayPath(path, home),
					source,
				});
				continue;
			}
			if (entry.isDirectory() || entry.isSymbolicLink()) {
				walk(path);
			}
		}
	};
	walk(root);
	return entries;
}

function skillPriority(skill: LocalSkillEntry): number {
	return skill.path.includes("/superpowers/") ? 0 : 1;
}

function skillNameFromFile(path: string): string | undefined {
	try {
		const firstLines = readFileSync(path, "utf8").split("\n").slice(0, 8).join("\n");
		const match = /^name:\s*(.+)$/m.exec(firstLines);
		return match?.[1]?.trim();
	} catch {
		return undefined;
	}
}

function displayPath(path: string, home: string | undefined): string {
	const resolved = resolve(path);
	const resolvedHome = home ? resolve(home) : undefined;
	if (resolvedHome && (resolved === resolvedHome || resolved.startsWith(`${resolvedHome}/`))) {
		return `~${resolved.slice(resolvedHome.length)}`;
	}
	return resolved;
}

function readDPiConnectGitBranch(cwd: string): string | null {
	try {
		return normalizeDPiConnectGitBranch(
			execFileSync("git", ["branch", "--show-current"], {
				cwd,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
			}),
		);
	} catch {
		return null;
	}
}
