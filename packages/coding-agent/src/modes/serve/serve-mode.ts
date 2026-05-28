import { APP_NAME, getChangelogPath, VERSION } from "../../config.ts";
import type { AgentSession } from "../../core/agent-session.ts";
import type {
	BannerData,
	BannerKeyHint,
	LoadedResourceSection,
	ResourceDiagnosticEntry,
} from "../../core/agent-session-proxy.ts";
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.ts";
import { type AppKeybinding, KeybindingsManager } from "../../core/keybindings.ts";
import { LocalAgentSessionProxy } from "../../core/local-agent-session-proxy.ts";
import { getNewEntries, parseChangelog } from "../../utils/changelog.ts";
import { formatKeyText } from "../interactive/components/keybinding-hints.ts";
import { AgentHttpServer } from "./http-server.ts";

export interface ServeModeOptions {
	port?: number;
}

const DEFAULT_PORT = 8080;

/** Get the display text for a keybinding (theme-independent). */
function keyText(kb: KeybindingsManager, keybinding: string): string {
	const keys = kb.getKeys(keybinding as AppKeybinding);
	if (keys.length === 0) return "";
	return formatKeyText(keys.join("/"));
}

/** Generate structured banner data for serve/connect. */
function generateBanner(session: AgentSession): BannerData {
	// Use the app's KeybindingsManager which includes app-specific bindings
	const kb = KeybindingsManager.create();

	const expandedHints: BannerKeyHint[] = [
		{ key: keyText(kb, "app.interrupt"), description: "to interrupt" },
		{ key: keyText(kb, "app.clear"), description: "to clear" },
		{ key: `${keyText(kb, "app.clear")} twice`, description: "to exit" },
		{ key: keyText(kb, "app.exit"), description: "to exit (empty)" },
		{ key: keyText(kb, "app.suspend"), description: "to suspend" },
		{ key: keyText(kb, "tui.editor.deleteToLineEnd"), description: "to delete to end" },
		{ key: keyText(kb, "app.thinking.cycle"), description: "to cycle thinking level" },
		{
			key: `${keyText(kb, "app.model.cycleForward")}/${keyText(kb, "app.model.cycleBackward")}`,
			description: "to cycle models",
		},
		{ key: keyText(kb, "app.model.select"), description: "to select model" },
		{ key: keyText(kb, "app.tools.expand"), description: "to expand tools" },
		{ key: keyText(kb, "app.thinking.toggle"), description: "to expand thinking" },
		{ key: keyText(kb, "app.editor.external"), description: "for external editor" },
		{ key: "/", description: "for commands" },
		{ key: "!", description: "to run bash" },
		{ key: "!!", description: "to run bash (no context)" },
		{ key: keyText(kb, "app.message.followUp"), description: "to queue follow-up" },
		{ key: keyText(kb, "app.message.dequeue"), description: "to edit all queued messages" },
		{ key: keyText(kb, "app.clipboard.pasteImage"), description: "to paste image" },
		{ key: "drop files", description: "to attach" },
	];
	const compactHints: BannerKeyHint[] = [
		{ key: keyText(kb, "app.interrupt"), description: "interrupt" },
		{ key: `${keyText(kb, "app.clear")}/${keyText(kb, "app.exit")}`, description: "clear/exit" },
		{ key: "/", description: "commands" },
		{ key: "!", description: "bash" },
		{ key: keyText(kb, "app.tools.expand"), description: "more" },
	];
	const compactOnboarding = `Press ${keyText(kb, "app.tools.expand")} to show full startup help and loaded resources.`;
	const onboarding = `Pi can explain its own features and look up its docs. Ask it how to use or extend Pi.`;

	// Gather loaded resources from the session
	const loadedResources: LoadedResourceSection[] = [];
	const rl = session.resourceLoader;

	// Context files
	const contextFiles = rl.getAgentsFiles().agentsFiles;
	if (contextFiles.length > 0) {
		loadedResources.push({
			name: "Context",
			compactList: contextFiles.map((f) => f.path).join(", "),
			expandedList: contextFiles.map((f) => f.path).join("\n"),
		});
	}

	// Skills
	const skills = rl.getSkills().skills;
	if (skills.length > 0) {
		loadedResources.push({
			name: "Skills",
			compactList: skills
				.map((s) => s.name)
				.sort()
				.join(", "),
			expandedList: skills.map((s) => s.filePath).join("\n"),
		});
	}

	// Prompts (templates)
	const templates = session.promptTemplates;
	if (templates.length > 0) {
		loadedResources.push({
			name: "Prompts",
			compactList: templates
				.map((t) => `/${t.name}`)
				.sort()
				.join(", "),
			expandedList: templates.map((t) => t.filePath).join("\n"),
		});
	}

	// Extensions — tool registration and events work, UI calls degrade to no-ops
	const extensions = rl.getExtensions().extensions;
	if (extensions.length > 0) {
		loadedResources.push({
			name: "Extensions",
			compactList: extensions.map((e) => e.path.split("/").pop() ?? e.path).join(", "),
			expandedList: extensions.map((e) => e.path).join("\n"),
		});
	}

	// Themes (custom only)
	const themes = rl.getThemes().themes.filter((t) => t.sourcePath);
	if (themes.length > 0) {
		loadedResources.push({
			name: "Themes",
			compactList: themes
				.map((t) => t.name ?? "")
				.filter(Boolean)
				.sort()
				.join(", "),
			expandedList: themes.map((t) => t.sourcePath!).join("\n"),
		});
	}

	// Diagnostics
	const diagnostics: Array<{ label: string; entries: ResourceDiagnosticEntry[] }> = [];

	const skillDiagnostics = rl.getSkills().diagnostics;
	if (skillDiagnostics.length > 0) {
		diagnostics.push({ label: "Skill conflicts", entries: skillDiagnostics as ResourceDiagnosticEntry[] });
	}

	const promptDiagnostics = rl.getPrompts().diagnostics;
	if (promptDiagnostics.length > 0) {
		diagnostics.push({ label: "Prompt conflicts", entries: promptDiagnostics as ResourceDiagnosticEntry[] });
	}

	const extensionErrors = rl.getExtensions().errors;
	if (extensionErrors.length > 0) {
		diagnostics.push({
			label: "Extension issues",
			entries: extensionErrors.map((e) => ({
				type: "error" as const,
				message: e.error,
				path: e.path,
			})),
		});
	}

	// Changelog — only show new entries since last seen version (same logic as local mode)
	let changelogMarkdown: string | undefined;
	const lastVersion = session.settingsManager.getLastChangelogVersion();
	const changelogEntries = parseChangelog(getChangelogPath());
	if (lastVersion && changelogEntries.length > 0) {
		const newEntries = getNewEntries(changelogEntries, lastVersion);
		if (newEntries.length > 0) {
			changelogMarkdown = newEntries.map((e) => e.content).join("\n\n");
		}
	}

	return {
		appName: APP_NAME,
		version: VERSION,
		expandedHints,
		compactHints,
		compactOnboarding,
		onboarding,
		loadedResources,
		diagnostics,
		changelogMarkdown,
	};
}

export async function runServeMode(runtime: AgentSessionRuntime, options: ServeModeOptions = {}): Promise<void> {
	const port = options.port ?? DEFAULT_PORT;
	const proxy = new LocalAgentSessionProxy(runtime);

	// Generate and set banner data for connect clients
	proxy.setBanner(generateBanner(runtime.session));

	const server = new AgentHttpServer(proxy);

	// Bind extensions — no UI context (hasUI() === false), tool registration
	// and event subscriptions work normally. UI calls degrade to no-ops.
	const rebindSession = async (): Promise<void> => {
		const session = runtime.session;
		await session.bindExtensions({
			commandContextActions: {
				waitForIdle: () => session.agent.waitForIdle(),
				newSession: async (newSessionOptions) => runtime.newSession(newSessionOptions),
				fork: async (entryId, forkOptions) => {
					const result = await runtime.fork(entryId, forkOptions);
					return { cancelled: result.cancelled };
				},
				navigateTree: async (targetId, navigateOptions) => {
					const result = await session.navigateTree(targetId, {
						summarize: navigateOptions?.summarize,
						customInstructions: navigateOptions?.customInstructions,
						replaceInstructions: navigateOptions?.replaceInstructions,
						label: navigateOptions?.label,
					});
					return { cancelled: result.cancelled };
				},
				switchSession: async (sessionPath, switchOptions) => {
					return runtime.switchSession(sessionPath, switchOptions);
				},
				reload: async () => {
					await session.reload();
				},
			},
			abortHandler: () => {
				// No UI to reset in serve mode
			},
			onError: (err) => {
				process.stderr.write(`[serve] Extension error (${err.extensionPath}): ${err.error}\n`);
			},
		});
	};

	// Set up beforeSessionInvalidate callback
	runtime.setBeforeSessionInvalidate(() => {
		// No UI to reset in serve mode
	});

	// Set up rebindSession — must call bindExtensions for each new session
	// so extension event handlers (session_start, etc.) fire correctly.
	// Also re-subscribe proxy listeners so SSE events keep flowing.
	runtime.setRebindSession(async (session, reason) => {
		proxy.resubscribe(reason);
		await rebindSession();
		// Update banner after session replacement
		proxy.setBanner(generateBanner(session));
	});

	// Initial bind for the first session
	await rebindSession();

	await server.start(port);

	// Log to stderr so stdout stays clean
	process.stderr.write(`[serve] Listening on port ${port}\n`);
	process.stderr.write(`[serve] Connect with: pi --mode connect --url http://localhost:${port}\n`);

	// Keep process alive
	return new Promise(() => {});
}
