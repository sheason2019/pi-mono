/**
 * Agent Worker — runs inside a Worker thread.
 *
 * Creates a full pi agent instance (AgentSessionRuntime + AgentHttpServer)
 * following the same pattern as serve-mode.ts. Communicates with the Hub
 * via parentPort for tool calls and incoming messages.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import type { Model } from "@earendil-works/pi-ai";
import type { AgentSession } from "@sheason/pi-coding-agent";
import { AuthStorage, getAgentDir, ModelRegistry, SessionManager, SettingsManager } from "@sheason/pi-coding-agent";
import {
	AgentIpcServer,
	type AgentSessionRuntime,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	findInitialModel,
	generateBanner,
	LocalAgentSessionProxy,
} from "@sheason/pi-coding-agent/d-pi-worker";
import { DPI_META_PROMPT } from "../dpi-meta.ts";
import {
	createAgentMetadataExtension,
	createDispatchExtension, // from dispatch-extension via index barrel
	createMultiAgentExtension,
	// dispatch imported directly from dispatch-extension
	type HubChannel,
} from "../extension/index.ts";
import { formatAgentIdentitySection, readAgentConfig } from "../hub/agent-identity.ts";
import type { AgentWorkerConfig, HubToWorkerMessage, WorkerToHubMessage } from "../types.ts";
import { loadWorkspaceContext } from "../workspace/workspace.ts";

const dPiClientExtensionPath = new URL(
	`../extension/client-extension${import.meta.url.endsWith(".ts") ? ".ts" : ".js"}`,
	import.meta.url,
).pathname;
const config = workerData as AgentWorkerConfig;
const port = parentPort!;

// Module-level references set during runAgentWorker()
let hubChannel: HubChannel | undefined;
let runtime: AgentSessionRuntime | undefined;
let ipcServer: AgentIpcServer | undefined;
let proxy: LocalAgentSessionProxy | undefined;

function postToHub(message: WorkerToHubMessage): void {
	port.postMessage(message);
}

// Listen for messages from Hub
port.on("message", (message: HubToWorkerMessage) => {
	switch (message.type) {
		case "tool_result":
			process.stderr.write(`[d-pi worker ${config.agentName}] Received tool_result for callId=${message.callId}\n`);
			hubChannel?.resolveCall(message.callId, message.result);
			break;
		case "message":
			hubChannel?.deliverMessage(message.content, message.sourceName, message.mode);
			break;
		case "destroy":
			gracefulShutdown();
			break;
		// The following cases are handled by AgentIpcServer via the
		// transport adapter, not here. They are listed for clarity.
		case "http_request":
		case "http_query":
		case "sse_subscribe":
		case "sse_unsubscribe":
			break;
	}
});

/**
 * Create a SessionManager using isolated sessionDir and optional sessionId for recovery.
 * - If sessionDir is provided, sessions are stored under the d-pi workspace instead of ~/.pi
 * - If sessionId is provided, attempts to open that specific session; falls back to most recent
 */
function createSessionManager(cwd: string, sessionId?: string, sessionDir?: string): SessionManager {
	if (sessionDir) {
		mkdirSync(sessionDir, { recursive: true });

		if (sessionId) {
			// Session file naming: {timestamp}_{sessionId}.jsonl
			try {
				const files = readdirSync(sessionDir).filter((f) => f.endsWith(".jsonl") && f.includes(sessionId));
				if (files.length > 0) {
					const path = join(sessionDir, files[files.length - 1]!);
					process.stderr.write(`[d-pi worker] Restoring session ${sessionId} from ${path}\n`);
					return SessionManager.open(path, sessionDir, cwd);
				}
			} catch {
				// Directory may not exist yet
			}
			process.stderr.write(`[d-pi worker] Session ${sessionId} not found in ${sessionDir}, continuing recent\n`);
		}

		return SessionManager.continueRecent(cwd, sessionDir);
	}

	return SessionManager.continueRecent(cwd);
}

/** Persist the current session ID back to agent.json */
function persistSessionId(agentCwd: string, sessionId: string): void {
	const configPath = join(agentCwd, "agent.json");
	try {
		const agentConfig = JSON.parse(readFileSync(configPath, "utf-8"));
		agentConfig.sessionId = sessionId;
		writeFileSync(configPath, `${JSON.stringify(agentConfig, null, "\t")}\n`);
		process.stderr.write(`[d-pi worker] Persisted sessionId=${sessionId} to agent.json\n`);
	} catch (err) {
		process.stderr.write(`[d-pi worker] Failed to persist sessionId: ${err}\n`);
	}
}

async function runAgentWorker(): Promise<void> {
	// `agentName` is the worker's identity — there is no separate id.
	// See "name is identity" in the changelog for the rationale.
	const { agentName, cwd, model: modelSpec } = config;
	const agentDir = getAgentDir();

	process.stderr.write(`[d-pi worker ${agentName}] Starting agent "${agentName}"...\n`);

	// 1. Create infrastructure
	const authStorage = AuthStorage.create();
	const settingsManager = SettingsManager.create(cwd, agentDir);
	const modelRegistry = ModelRegistry.create(authStorage);

	process.stderr.write(`[d-pi worker ${agentName}] Infrastructure created\n`);

	// 2. Create the d-pi multi-agent + dispatch surfaces (and the HubChannel).
	// We register them as two separate named extensions (plus the metadata one)
	// so that diagnostics, tracing, and future optionality can target each concern
	// independently. This is the decomposition of the old monolithic std extension.
	const { factory: multiAgentFactory, channel } = createMultiAgentExtension({
		mode: "worker",
		agentName,
		postToHub,
	});
	const dispatchFactory = createDispatchExtension(channel, cwd);
	hubChannel = channel;

	// 3. Build the runtime factory (mirrors main.ts pattern)
	const createRuntime = async (opts: { cwd: string; agentDir: string; sessionManager: SessionManager }) => {
		// Build resourceLoaderOptions from workspace context.
		// APPEND_SYSTEM.md workspace content, the agent's own
		// agent.json (rendered as "## Agent identity"), and d-pi
		// meta are concatenated into the same
		// ResourceLoader.appendSystemPrompt array — the same path
		// used by ResourceLoader for every other source-level
		// system-prompt block. d-pi meta is in-source (dpi-meta.ts)
		// rather than an external .md file, so it ships with the
		// package and is regenerated per build via
		// scripts/inject-build-meta.mjs.
		//
		// Order is workspace append → per-agent identity → d-pi
		// runtime meta. The d-pi meta goes LAST so it lands just
		// before the tool list / build stamp at the very end of
		// the system prompt — a stable position across agents that
		// doesn't get pushed around as identity content grows.
		//
		// Bug fix (previously): the appendSystemPrompt array and the
		// agentsFilesOverride closure both captured a snapshot of
		// agent.json + APPEND_SYSTEM.md at session-start, so
		// session.reload() re-ran resourceLoader.reload() but the
		// d-pi-injected content stayed frozen at startup. Editing
		// agent.json (description, roles, model name, tool allow/deny)
		// or APPEND_SYSTEM.md and calling `reload` would NOT refresh
		// the system prompt.
		//
		// Fix: pass `appendSystemPromptOverride` and
		// `agentsFilesOverride` as closures that re-read
		// loadWorkspaceContext + agent.json on every call. The
		// ResourceLoader invokes these overrides inside its own
		// reload(), so each `reload` re-computes the d-pi-injected
		// sections from the live on-disk state.
		const workspaceRoot = config.workspaceContext?.workspaceRoot;
		const additionalSkillPaths = config.workspaceContext?.additionalSkillPaths ?? [];
		const additionalExtensionPaths = [
			dPiClientExtensionPath,
			...(config.workspaceContext?.additionalExtensionPaths ?? []),
		];

		// Re-read the workspace context and this agent's identity
		// from disk. Called on every reload (and once at startup)
		// so that edits to APPEND_SYSTEM.md / team-template
		// AGENTS.md / agent.json (description, roles, model name,
		// tool allow/deny list) take effect without a hub restart.
		// Returns `undefined` when there is no workspace context
		// (e.g. ad-hoc session without a workspace root); the
		// override closures handle that case by falling back to
		// whatever the resourceLoader itself discovered.
		const readFreshDPiContext = () => {
			const freshAgentConfig = readAgentConfig(cwd);
			const roles = freshAgentConfig?.roles;
			const freshWorkspaceContext = workspaceRoot
				? loadWorkspaceContext(workspaceRoot, { agentName, roles })
				: undefined;
			return { freshAgentConfig, freshWorkspaceContext };
		};

		process.stderr.write(`[d-pi worker ${agentName}] Creating session services...\n`);

		const services = await createAgentSessionServices({
			cwd: opts.cwd,
			agentDir: opts.agentDir,
			authStorage,
			settingsManager,
			modelRegistry,
			resourceLoaderOptions: {
				extensionFactories: [
					{
						// d-pi multi-agent / orchestration surface.
						// Provides: create/destroy_agent, send_message, team,
						// all source tools, the dual-registered /agents and /sources commands,
						// d-pi custom message rendering, and the input / incoming-message routing
						// that feeds connect-mode and source messages into the agent's session.
						factory: multiAgentFactory,
						name: "<d-pi-multi-agent>",
					},
					{
						// Remote executor tools (remote_bash, remote_read, remote_edit, ...).
						// These let a hub-side agent invoke the corresponding native tools on
						// a connected d-pi client (the user's local machine) via the IPC channel.
						// If no client is bound, the tools surface a clear actionable error.
						// This is kept as a separate named extension from the multi-agent surface
						// so the two concerns can be understood, traced, and optionally gated
						// independently.
						factory: dispatchFactory,
						name: "<d-pi-dispatch>",
					},
					{
						// d-pi-built-in-metadata-extension: registers the
						// `reload` tool plus the agent metadata controls
						// (set_model, set_thinking_level). This is the single
						// extension that lets agents (via LLM tools) control
						// their own runtime model and thinking intensity, and
						// also hosts reload so that one extension factory
						// covers the "self-configuration + refresh" surface.
						//
						// The session is not available when the factory first
						// runs (it is constructed later by
						// createAgentSessionFromServices), so the reload tool's
						// deps use lazy getters that resolve `runtime?.session`
						// at execute() time. The set_model / set_thinking_level
						// tools obtain their setters from the ExtensionAPI (pi)
						// at factory time (they are stable) and use
						// ctx.modelRegistry (from the execute ctx) to resolve
						// string specs to Model objects.
						factory: createAgentMetadataExtension({
							getReloadFn: () => {
								const session = runtime?.session;
								return session ? () => session.reload() : undefined;
							},
							getResourceLoader: () => runtime?.session?.resourceLoader,
							// Also re-read ~/.pi/agent/models.json on reload so
							// newly added providers / rotated keys become
							// available in the same call, without a hub
							// restart. The model registry is owned by the
							// agent session, so we resolve it lazily at
							// execute() time the same way we do for the
							// session / resource loader.
							getModelRegistry: () => runtime?.session?.modelRegistry,
							// Provide the worker's authoritative agent directory (the one
							// containing this agent's agent.json). The metadata tools use
							// this (via getAgentCwd) in preference to ExtensionContext.cwd
							// when persisting model changes, so that writes always target
							// the correct persisted config even if ctx.cwd semantics differ.
							getAgentCwd: () => cwd,
						}),
						name: "<d-pi-built-in-metadata-extension>",
					},
				],
				appendSystemPromptOverride: (base) => {
					// `base` is what ResourceLoader itself discovered
					// (e.g. ~/.pi/agent/APPEND_SYSTEM.md via
					// discoverAppendSystemPromptFile). Keep it at the
					// end so it stays in the same position relative
					// to the d-pi-injected sections as before this fix.
					const { freshAgentConfig, freshWorkspaceContext } = readFreshDPiContext();
					return [
						freshWorkspaceContext?.appendSystemPrompt,
						freshAgentConfig ? formatAgentIdentitySection(freshAgentConfig) : undefined,
						DPI_META_PROMPT,
						...base,
					].filter((s): s is string => Boolean(s));
				},
				agentsFilesOverride: (base) => {
					// Re-read the workspace-level AGENTS.md / team-template
					// AGENTS.md on every call so role / architecture edits
					// surface without a hub restart. `base` is what
					// ResourceLoader discovered itself (project-level
					// AGENTS.md / CLAUDE.md via loadProjectContextFiles);
					// keep it after the d-pi-injected files so user-level
					// files win on conflicts.
					const { freshWorkspaceContext } = readFreshDPiContext();
					return {
						agentsFiles: [...(freshWorkspaceContext?.additionalAgentsFiles ?? []), ...base.agentsFiles],
					};
				},
				additionalSkillPaths,
				additionalExtensionPaths,
			},
		});

		process.stderr.write(`[d-pi worker ${agentName}] Session services created, resolving model...\n`);

		// Resolve model
		let resolvedModel: Model<any> | undefined;
		if (modelSpec) {
			if (modelSpec.includes("/")) {
				const parts = modelSpec.split("/");
				resolvedModel = modelRegistry.find(parts[0]!, parts[1]!);
			} else {
				// Search by model ID across all providers
				resolvedModel = modelRegistry.getAll().find((m: Model<any>) => m.id === modelSpec);
			}
		}

		if (!resolvedModel) {
			const result = await findInitialModel({
				scopedModels: [],
				isContinuing: false,
				defaultProvider: settingsManager.getDefaultProvider(),
				defaultModelId: settingsManager.getDefaultModel(),
				defaultThinkingLevel: settingsManager.getDefaultThinkingLevel(),
				modelRegistry,
			});
			resolvedModel = result.model;
		}

		process.stderr.write(`[d-pi worker ${agentName}] Model resolved: ${resolvedModel?.id ?? "unknown"}\n`);

		const created = await createAgentSessionFromServices({
			services,
			sessionManager: opts.sessionManager,
			model: resolvedModel,
			tools: config.includeTools,
			excludeTools: ["bash", "read", "edit", "write", "grep", "find", "ls", ...(config.excludeTools ?? [])],
		});

		process.stderr.write(`[d-pi worker ${agentName}] Session created from services\n`);

		return { ...created, services, diagnostics: services.diagnostics };
	};

	// 4. Create session manager — use isolated sessionDir and restore by sessionId
	const sessionManager = createSessionManager(cwd, config.sessionId, config.sessionDir);

	// 5. Create runtime
	runtime = await createAgentSessionRuntime(createRuntime, {
		cwd,
		agentDir,
		sessionManager,
	});

	// 5b. Persist session ID to agent.json so restarts resume the correct session
	const currentSessionId = runtime.session.sessionManager.getSessionId();
	if (currentSessionId !== config.sessionId) {
		persistSessionId(config.cwd, currentSessionId);
	}

	// 6. Create proxy and HTTP server (same pattern as serve-mode.ts)
	proxy = new LocalAgentSessionProxy(runtime!);
	proxy.setBanner(generateBanner(runtime!.session));

	// All user prompts are routed through hubChannel.deliverMessage() so the extension
	// creates a CustomMessage instead of a UserMessageComponent (which has OSC133 markers
	// that produce unwanted editor divider lines in the TUI).
	//
	// mode is set to "next" explicitly: TUI /prompt and HTTP /prompt are
	// user-driven new-turn requests (equivalent to the TUI Enter key), so they
	// should map to {triggerTurn: true} at the extension layer. Without this,
	// deliverMessage would fall through to the default "next" path which the
	// extension then maps to {triggerTurn: true} anyway — but the explicit
	// declaration documents the intent at the call site.
	proxy.prompt = async (_text: string, _options?: { images?: Array<{ url: string; mediaType?: string }> }) => {
		hubChannel?.deliverMessage(_text, undefined, "next");
	};

	// (AgentHttpServer removed — IPC server is created later)

	// 7. Bind extensions — no UI context (same as serve-mode.ts)
	const rebindSession = async (): Promise<void> => {
		const session = runtime!.session;
		await session.bindExtensions({
			commandContextActions: {
				waitForIdle: () => session.agent.waitForIdle(),
				newSession: async (options) => runtime!.newSession(options),
				fork: async (entryId, options) => {
					const result = await runtime!.fork(entryId, options);
					return { cancelled: result.cancelled };
				},
				navigateTree: async (targetId, options) => {
					const result = await session.navigateTree(targetId, options);
					return { cancelled: result.cancelled };
				},
				switchSession: async (sessionPath, options) => {
					return runtime!.switchSession(sessionPath, options);
				},
				reload: async () => {
					await session.reload();
				},
			},
			abortHandler: () => {
				// No UI to reset in worker mode
			},
			onError: (err) => {
				process.stderr.write(`[d-pi worker ${agentName}] Extension error (${err.extensionPath}): ${err.error}\n`);
			},
		});
	};

	runtime!.setBeforeSessionInvalidate(() => {
		// No UI to reset
	});

	runtime!.setRebindSession(async (session: AgentSession, reason: "new" | "resume" | "fork") => {
		proxy!.resubscribe(reason);
		await rebindSession();
		proxy!.setBanner(generateBanner(session));
		// Persist session ID whenever session changes (new/fork/resume)
		persistSessionId(config.cwd, session.sessionManager.getSessionId());
	});

	// Initial bind for the first session
	await rebindSession();

	// 8. Start IPC server (replaces AgentHttpServer)
	// The IPC server listens for http_request / http_query / sse_subscribe
	// messages from the hub and responds via IPC. No HTTP port needed.
	ipcServer = new AgentIpcServer(
		proxy!,
		{
			postMessage: (msg) => port.postMessage(msg),
			onMessage: (handler) => port.on("message", handler),
		},
		{
			onHttpResponse: (requestId, status, body) => {
				postToHub({ type: "http_response", agentName, requestId, status, body });
			},
			onSseEvent: (subscriberId, event, data) => {
				postToHub({ type: "sse_event", agentName, subscriberId, event, data });
			},
		},
	);
	ipcServer.start();

	// 8b. Subscribe to session events to report streaming status to Hub
	proxy.subscribe((event) => {
		if (event.type === "turn_start") {
			postToHub({ type: "status_update", agentName, status: "busy" });
		} else if (event.type === "turn_end" || event.type === "agent_end") {
			postToHub({ type: "status_update", agentName, status: "ready" });
		} else if (event.type === "compaction_start") {
			postToHub({ type: "status_update", agentName, status: "busy" });
		} else if (event.type === "compaction_end") {
			postToHub({ type: "status_update", agentName, status: "ready" });
		}
	});

	// 9. Signal ready to Hub
	postToHub({ type: "ready", agentName });
	postToHub({ type: "status_update", agentName, status: "ready" });

	process.stderr.write(`[d-pi worker] Agent "${agentName}" ready (IPC mode, no HTTP port)\n`);

	// Keep alive
	return new Promise(() => {});
}

async function gracefulShutdown(): Promise<void> {
	postToHub({ type: "status_update", agentName: config.agentName, status: "destroyed" });
	try {
		ipcServer?.stop();
	} catch {
		// Ignore errors during shutdown
	}
	proxy?.dispose();
	process.exit(0);
}

runAgentWorker().catch((err: unknown) => {
	postToHub({ type: "error", agentName: config.agentName, error: String(err) });
	process.exit(1);
});
