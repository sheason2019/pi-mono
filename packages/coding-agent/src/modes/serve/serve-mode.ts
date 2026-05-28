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
import { parseChangelog } from "../../utils/changelog.ts";
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

	// Extensions — always show, even if empty (serve mode runs with --no-extensions)
	const extensions = rl.getExtensions().extensions;
	loadedResources.push({
		name: "Extensions",
		compactList:
			extensions.length > 0
				? extensions.map((e) => e.path.split("/").pop() ?? e.path).join(", ")
				: "disabled in serve mode (--no-extensions)",
		expandedList:
			extensions.length > 0 ? extensions.map((e) => e.path).join("\n") : "disabled in serve mode (--no-extensions)",
	});

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

	// Changelog — only show the latest version's entry
	let changelogMarkdown: string | undefined;
	const changelogEntries = parseChangelog(getChangelogPath());
	if (changelogEntries.length > 0) {
		// Only include the latest version entry (same as what a first-run user would see)
		changelogMarkdown = changelogEntries[0].content;
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

	// Set up rebindSession callback so the proxy stays in sync
	runtime.setBeforeSessionInvalidate(() => {
		// No UI to reset in serve mode
	});

	runtime.setRebindSession(async (_session) => {
		// Re-subscription happens automatically via the proxy's subscribe()
		// which delegates to the current session. The server's SSE broadcast
		// will pick up events from the new session.
	});

	await server.start(port);

	// Log to stderr so stdout stays clean
	process.stderr.write(`[serve] Listening on port ${port}\n`);
	process.stderr.write(`[serve] Connect with: pi --mode connect --url http://localhost:${port}\n`);

	// Keep process alive
	return new Promise(() => {});
}
