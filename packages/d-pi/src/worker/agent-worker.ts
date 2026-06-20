/**
 * Agent Worker — runs inside a Worker thread.
 *
 * Creates a full pi agent instance (AgentSessionRuntime + AgentHttpServer)
 * following the same pattern as serve-mode.ts. Communicates with the Hub
 * via parentPort for tool calls and incoming messages.
 */
import { join } from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import type { AgentToolResult, AgentToolUpdateCallback, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { TSchema } from "typebox";
import type { AgentToolDefinition } from "../agent-definition.ts";
import { readLoadedAgentDefinitionFromTs } from "../agent-loader.ts";
import { type AgentBuiltinToolKind, getAgentBuiltinToolKind } from "../agent-tool-helpers.ts";
import { DPiContextManager } from "../context/context-manager.ts";
import { DPI_META_PROMPT } from "../dpi-meta.ts";
import { buildNativeToolSet } from "../executor/native-tools.ts";
import type { ExtensionFactory, ModelRegistry, ResourceLoader, ToolDefinition } from "../extension/contracts.ts";
import { createHubActionsClientFromHubChannel } from "../extension/hub-actions-adapter.ts";
import { createMultiAgentExtension, type HubChannel } from "../extension/index.ts";
import { agentDefinitionToConfig, formatAgentIdentitySection } from "../hub/agent-identity.ts";
import { DPiAgentRuntime } from "../runtime/agent-runtime.ts";
import { DPiModelManager } from "../runtime/model-manager.ts";
import { DPiSessionStore } from "../runtime/session-store.ts";
import type { DPiPromptImage } from "../runtime/types.ts";
import {
	createDPiCreateAgentTool,
	createDPiDeleteSourceTool,
	createDPiDestroyAgentTool,
	createDPiDispatchTools,
	createDPiGetSourceTool,
	createDPiReloadTool,
	createDPiSendMessageTool,
	createDPiSetSourceTool,
	createDPiTeamTool,
	type DPiDispatchLocalExecutors,
	type DPiDispatchParameterSchemas,
	type DPiRemoteExecutor,
	type DPiRemoteToolResult,
	type DPiToolDetails,
} from "../surface/index.ts";
import type { AgentWorkerConfig, HubToWorkerMessage, WorkerToHubMessage } from "../types.ts";
import { loadWorkspaceContext } from "../workspace/workspace.ts";
import {
	createDPiAgentSessionFromServices,
	createDPiAgentSessionRuntime,
	createDPiAgentSessionServices,
	createDPiSessionManager,
	createDPiWorkerInfrastructure,
	DPiAgentIpcServer,
	type DPiAgentSessionRuntime,
	DPiLocalAgentSessionProxy,
	type DPiWorkerSession,
	type DPiWorkerSessionManager,
	generateDPiBanner,
	resolveDPiInitialModel,
	runtimeModelSpecFromResolvedModel,
} from "./coding-agent-worker-adapter.ts";

const dPiClientExtensionPath = new URL(
	`../extension/client-extension${import.meta.url.endsWith(".ts") ? ".ts" : ".js"}`,
	import.meta.url,
).pathname;
const config = workerData as AgentWorkerConfig;
const port = parentPort!;

// Module-level references set during runAgentWorker()
let hubChannel: HubChannel | undefined;
let runtime: DPiAgentSessionRuntime | undefined;
let agentRuntime: DPiAgentRuntime | undefined;
let remoteFirstRuntimeModelSpec: string | undefined;
let remoteFirstRuntimeModel: Model<Api> | undefined;
let remoteFirstRuntimeThinkingLevel: ThinkingLevel | undefined;
let ipcServer: DPiAgentIpcServer | undefined;
let proxy: DPiLocalAgentSessionProxy | undefined;

function postToHub(message: WorkerToHubMessage): void {
	port.postMessage(message);
}

function toPromptImages(images: Array<{ url: string; mediaType?: string }> | undefined): DPiPromptImage[] | undefined {
	if (!images || images.length === 0) {
		return undefined;
	}
	return images.map((image) => ({
		mediaType: image.mediaType ?? "application/octet-stream",
		url: image.url,
	}));
}

interface AgentLocalToolsExtensionOptions {
	agentTools: AgentToolDefinition[];
	channel: HubChannel;
	cwd: string;
	getReloadFn: () => (() => Promise<void>) | undefined;
	getResourceLoader: () => ResourceLoader | undefined;
	getModelRegistry: () => ModelRegistry | undefined;
}

function createAgentLocalToolsExtension(options: AgentLocalToolsExtensionOptions): ExtensionFactory {
	return (pi) => {
		const builtins = createWorkerBuiltinToolMap(options);
		for (const tool of options.agentTools) {
			const builtinKind = getAgentBuiltinToolKind(tool);
			const resolvedTool = builtinKind ? builtins.get(builtinKind) : tool;
			if (!resolvedTool) {
				throw new Error(`Configured d-pi built-in tool "${tool.name}" is not available in this worker.`);
			}
			pi.registerTool(resolvedTool);
		}
	};
}

function createWorkerBuiltinToolMap(
	options: AgentLocalToolsExtensionOptions,
): Map<AgentBuiltinToolKind, ToolDefinition> {
	const hubClient = createHubActionsClientFromHubChannel(options.channel);
	return new Map<AgentBuiltinToolKind, ToolDefinition>([
		["send_message", createDPiSendMessageTool(hubClient, { agentName: options.channel.agentName })],
		["create_agent", createDPiCreateAgentTool(hubClient)],
		["destroy_agent", createDPiDestroyAgentTool(hubClient)],
		["team", createDPiTeamTool(hubClient)],
		["set_source", createDPiSetSourceTool(hubClient)],
		["get_source", createDPiGetSourceTool(hubClient)],
		["delete_source", createDPiDeleteSourceTool(hubClient)],
		...createWorkerDispatchTools(options.channel, options.cwd).map(
			(tool) => [tool.name as AgentBuiltinToolKind, tool as ToolDefinition] as const,
		),
		[
			"reload",
			createDPiReloadTool({
				runtimeHooks: {
					reloadContext: async () => {
						const reloadFn = options.getReloadFn();
						if (!reloadFn) {
							throw new Error("Reload not available: d-pi session is not initialized yet.");
						}
						await reloadFn();
					},
				},
				getSnapshot: () => createReloadSnapshot(options),
			}),
		],
	]);
}

function createWorkerDispatchTools(channel: HubChannel, cwd: string): ToolDefinition[] {
	const localExecutors = {} as DPiDispatchLocalExecutors;
	const parameterSchemas = {} as DPiDispatchParameterSchemas;
	const nativeTools = new Map(buildNativeToolSet(cwd).map((tool) => [tool.name, tool as NativeToolDefinition]));

	for (const nativeName of DISPATCH_NATIVE_TOOL_NAMES) {
		const nativeDef = nativeTools.get(nativeName);
		if (!nativeDef) {
			throw new Error(`Missing d-pi native tool: ${nativeName}`);
		}
		parameterSchemas[nativeName] = nativeDef.parameters;
		localExecutors[nativeName] = (toolCallId, params, signal, onUpdate) =>
			nativeDef.execute(toolCallId, params, signal, onUpdate);
	}

	return createDPiDispatchTools({
		localExecutors,
		parameterSchemas,
		remoteExecutor: createWorkerRemoteExecutor(channel),
		sourceAgentName: channel.agentName,
	}) as ToolDefinition[];
}

function createWorkerRemoteExecutor(channel: HubChannel): DPiRemoteExecutor {
	return {
		async executeRemoteTool(request): Promise<DPiRemoteToolResult> {
			const result = await channel.callDispatch(request.toolName, request.params, request.connectId);
			const dispatchResult = result as Partial<DPiRemoteToolResult>;
			return {
				requestId: request.requestId,
				ok: dispatchResult.ok === true,
				result: dispatchResult.result,
				error: dispatchResult.error,
			};
		},
	};
}

function createReloadSnapshot(options: AgentLocalToolsExtensionOptions): {
	snapshot: DPiToolDetails;
	details: DPiToolDetails;
} {
	const resourceLoader = options.getResourceLoader();
	if (!resourceLoader) {
		throw new Error("Reload completed, but the resource loader is no longer available.");
	}
	const skills = resourceLoader.getSkills().skills;
	const systemPrompt = resourceLoader.getSystemPrompt();
	const appendSystemPrompt = resourceLoader.getAppendSystemPrompt();
	const contextFiles = resourceLoader.getAgentsFiles().agentsFiles;

	const snapshot: DPiToolDetails = {
		skills: skills.length,
		skillNames: skills.map((skill) => skill.name),
		systemPromptLen: systemPrompt?.length ?? 0,
		appendSystemPromptCount: appendSystemPrompt.length,
		contextFiles: contextFiles.length,
		contextFilePaths: contextFiles.map((file) => file.path),
	};
	const details: DPiToolDetails = {
		skills: skills.length,
		systemPromptLen: systemPrompt?.length ?? 0,
		contextFiles: contextFiles.length,
	};

	const modelRegistry = options.getModelRegistry();
	if (!modelRegistry) {
		return { snapshot, details };
	}

	try {
		modelRegistry.refresh();
		const modelsCount = modelRegistry.getAll().length;
		snapshot.models = modelsCount;
		details.models = modelsCount;
	} catch (err) {
		const modelsError = err instanceof Error ? err.message : String(err);
		snapshot.modelsError = modelsError;
		details.modelsError = modelsError;
	}
	return { snapshot, details };
}

const DISPATCH_NATIVE_TOOL_NAMES = ["bash", "read", "ls", "grep", "find", "write", "edit"] as const;

interface NativeToolDefinition {
	parameters: TSchema;
	execute(
		toolCallId: string,
		params: Record<string, unknown>,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<unknown>,
	): Promise<AgentToolResult<unknown>>;
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

async function runAgentWorker(): Promise<void> {
	// `agentName` is the worker's identity — there is no separate id.
	// See "name is identity" in the changelog for the rationale.
	const { agentName, cwd, model: modelSpec } = config;

	process.stderr.write(`[d-pi worker ${agentName}] Starting agent "${agentName}"...\n`);

	const agentDefinition = await readLoadedAgentDefinitionFromTs(cwd);
	const agentConfig = agentDefinition ? agentDefinitionToConfig(agentDefinition) : undefined;

	// 1. Create infrastructure
	const { agentDir, authStorage, settingsManager, modelRegistry } = createDPiWorkerInfrastructure(cwd, {
		agentDefinition,
	});

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
	hubChannel = channel;

	// 3. Build the runtime factory (mirrors main.ts pattern)
	const createRuntime = async (opts: { cwd: string; agentDir: string; sessionManager: DPiWorkerSessionManager }) => {
		// Build resourceLoaderOptions from workspace context.
		// APPEND_SYSTEM.md workspace content, the agent's own
		// agent.ts identity (rendered as "## Agent identity"), and d-pi
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
		// agent.ts identity + APPEND_SYSTEM.md at session-start, so
		// session.reload() re-ran resourceLoader.reload() but the
		// d-pi-injected content stayed frozen at startup. Editing
		// agent.ts (description, roles, model name, tool allow/deny)
		// or APPEND_SYSTEM.md and calling `reload` would NOT refresh
		// the system prompt.
		//
		// Fix: pass `appendSystemPromptOverride` and
		// `agentsFilesOverride` as closures that re-read
		// loadWorkspaceContext + agent.ts on every call. The
		// ResourceLoader invokes these overrides inside its own
		// reload(), so each `reload` re-computes the d-pi-injected
		// sections from the live on-disk state.
		const workspaceRoot = config.workspaceContext?.workspaceRoot;
		const additionalSkillPaths = config.workspaceContext?.additionalSkillPaths ?? [];
		const additionalExtensionPaths = [
			dPiClientExtensionPath,
			...(config.workspaceContext?.additionalExtensionPaths ?? []),
		];
		// Keep the executable agent definition as the single source of truth.
		// ResourceLoader overrides are synchronous, so this closure projects the
		// definition loaded above instead of reparsing agent.ts from source.
		const readFreshDPiContext = () => {
			const roles = agentConfig?.roles;
			const freshWorkspaceContext = workspaceRoot
				? loadWorkspaceContext(workspaceRoot, { agentName, roles })
				: undefined;
			return { freshAgentConfig: agentConfig, freshWorkspaceContext };
		};

		process.stderr.write(`[d-pi worker ${agentName}] Creating session services...\n`);

		const services = await createDPiAgentSessionServices({
			cwd: opts.cwd,
			agentDir: opts.agentDir,
			authStorage,
			settingsManager,
			modelRegistry,
			resourceLoaderOptions: {
				extensionFactories: [
					{
						// d-pi multi-agent / orchestration surface.
						// Provides non-tool UI/session support: the dual-registered
						// /agents and /sources commands, d-pi custom message rendering,
						// and the input / incoming-message routing
						// that feeds connect-mode and source messages into the agent's session.
						factory: multiAgentFactory,
						name: "<d-pi-multi-agent>",
					},
					{
						// Agent-local executable tools are the only LLM tool source.
						// Built-in helpers in agent.ts are hydrated here with worker
						// dependencies; custom defineTool() implementations are registered
						// as-is.
						factory: createAgentLocalToolsExtension({
							agentTools: agentDefinition?.tools ?? [],
							channel,
							cwd,
							getReloadFn: () => {
								const session = runtime?.session;
								return session ? () => session.reload() : undefined;
							},
							getResourceLoader: () => runtime?.session?.resourceLoader,
							getModelRegistry: () => runtime?.session?.modelRegistry,
						}),
						name: "<d-pi-agent-local-tools>",
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

		const resolvedModel = await resolveDPiInitialModel({
			modelSpec,
			modelRegistry,
			settingsManager,
			agentDefinition,
		});
		remoteFirstRuntimeModelSpec = runtimeModelSpecFromResolvedModel(resolvedModel);
		remoteFirstRuntimeModel = resolvedModel;
		remoteFirstRuntimeThinkingLevel = settingsManager.getDefaultThinkingLevel();

		process.stderr.write(`[d-pi worker ${agentName}] Model resolved: ${resolvedModel?.id ?? "unknown"}\n`);

		const created = await createDPiAgentSessionFromServices({
			services,
			sessionManager: opts.sessionManager,
			model: resolvedModel,
			tools: config.includeTools,
			excludeTools: ["bash", "read", "edit", "write", "grep", "find", "ls", ...(config.excludeTools ?? [])],
		});

		process.stderr.write(`[d-pi worker ${agentName}] Session created from services\n`);

		return { ...created, services, diagnostics: services.diagnostics };
	};

	// 4. Create session manager — use isolated sessionDir and restore the latest session from that directory
	const sessionManager = createDPiSessionManager(cwd, config.sessionDir);

	// 5. Create runtime
	runtime = await createDPiAgentSessionRuntime(createRuntime, {
		cwd,
		agentDir,
		sessionManager,
	});

	// 6. Create proxy and HTTP server (same pattern as serve-mode.ts)
	proxy = new DPiLocalAgentSessionProxy(runtime!);
	proxy.setBanner(generateDPiBanner(runtime!.session));

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

	runtime!.setRebindSession(async (session: DPiWorkerSession, reason: "new" | "resume" | "fork") => {
		proxy!.resubscribe(reason);
		await rebindSession();
		proxy!.setBanner(generateDPiBanner(session));
	});

	// Bind before creating DPiAgentRuntime so AgentHarness receives the real extension tools.
	await rebindSession();

	if (remoteFirstRuntimeModelSpec) {
		const sessionStore = new DPiSessionStore({
			cwd,
			sessionsRoot: config.sessionDir ?? join(cwd, "session"),
		});
		const sessionHandle = (await sessionStore.openRecent({ cwd })) ?? (await sessionStore.create({ cwd }));
		const initialSessionContext = await sessionHandle.session.buildContext();
		agentRuntime = new DPiAgentRuntime({
			agentName,
			cwd,
			session: sessionHandle.session,
			sessionInfo: sessionHandle.info,
			initialMessages: initialSessionContext.messages,
			modelManager: new DPiModelManager({ defaultModel: remoteFirstRuntimeModel ?? remoteFirstRuntimeModelSpec }),
			contextManager: new DPiContextManager({
				workspaceRoot: config.workspaceContext?.workspaceRoot ?? cwd,
				agentName,
				agentDir: cwd,
				cwd,
				agentDefinition,
			}),
			thinkingLevel: remoteFirstRuntimeThinkingLevel,
			tools: runtime!.session.getToolDefinitions(),
			activeToolNames: config.includeTools,
			getApiKeyAndHeaders: modelRegistry.getApiKeyAndHeaders
				? async (model) => await modelRegistry.getApiKeyAndHeaders?.(model)
				: undefined,
		});
		agentRuntime.subscribe((event) => {
			proxy?.applyRuntimeEvent(event);
			if (event.type === "agent_start") {
				postToHub({ type: "status_update", agentName, status: "busy" });
			} else if (event.type === "agent_end") {
				postToHub({ type: "status_update", agentName, status: "ready" });
			}
		});
		if (initialSessionContext.messages.length > 0) {
			proxy.applyRuntimeEvent({
				type: "session_replaced",
				agentName,
				session: sessionHandle.info,
				messages: initialSessionContext.messages,
			});
		}
	}

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
	proxy.setMessageDispatcher({
		prompt: async (_text: string, _options?: { images?: Array<{ url: string; mediaType?: string }> }) => {
			hubChannel?.deliverMessage(_text, undefined, "next");
			if (!agentRuntime) {
				throw new Error(`Agent "${agentName}" has no model configured`);
			}
			await agentRuntime.prompt(_text, { mode: "next", images: toPromptImages(_options?.images) });
		},
		steer: async (_text: string, images?: Array<{ url: string; mediaType?: string }>) => {
			hubChannel?.deliverMessage(_text, undefined, "steer");
			if (!agentRuntime) {
				throw new Error(`Agent "${agentName}" has no model configured`);
			}
			await agentRuntime.prompt(_text, { mode: "steer", images: toPromptImages(images) });
		},
		followUp: async (_text: string, images?: Array<{ url: string; mediaType?: string }>) => {
			hubChannel?.deliverMessage(_text, undefined, "next");
			if (!agentRuntime) {
				throw new Error(`Agent "${agentName}" has no model configured`);
			}
			await agentRuntime.prompt(_text, { mode: "followUp", images: toPromptImages(images) });
		},
	});

	// (AgentHttpServer removed — IPC server is created later)

	// 8. Start IPC server (replaces AgentHttpServer)
	// The IPC server listens for http_request / http_query / sse_subscribe
	// messages from the hub and responds via IPC. No HTTP port needed.
	ipcServer = new DPiAgentIpcServer(
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
