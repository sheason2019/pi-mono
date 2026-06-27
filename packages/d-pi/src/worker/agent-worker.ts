/**
 * Agent Worker — runs inside a Worker thread.
 *
 * Creates a full pi agent instance (AgentSessionRuntime + DPiAgentIpcServer).
 * Communicates with the Hub via parentPort for tool calls and incoming messages.
 */
import { join } from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import type { AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import type { AgentTool } from "@earendil-works/pi-agent-core/node";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { TSchema } from "typebox";
import type {
	AgentCommandDefinition,
	AgentMiddlewareDefinition,
	AgentToolDefinition,
	ToolDefinition,
} from "../agent-definition.ts";
import { defineCommand } from "../agent-definition.ts";
import { type LoadedAgentDefinition, readLoadedAgentDefinitionFromTs } from "../agent-loader.ts";
import { DPiContextManager } from "../context/context-manager.ts";
import type { ResourceLoader } from "../context/resource-loader.ts";
import { DPI_META_PROMPT } from "../dpi-meta.ts";
import { buildNativeToolSet } from "../executor/native-tools.ts";
import { agentDefinitionToConfig, formatAgentIdentitySection } from "../hub/agent-identity.ts";
import { HubChannel as HubChannelClass } from "../multi-agent/hub-channel.ts";
import type { HubChannel } from "../multi-agent/index.ts";
import { DPiAgentRuntime } from "../runtime/agent-runtime.ts";
import { DPiModelManager } from "../runtime/model-manager.ts";
import type { ModelRegistry } from "../runtime/model-registry.ts";
import { DPiSessionStore } from "../runtime/session-store.ts";
import { projectDPiTranscript } from "../runtime/transcript/projector.ts";
import type { DPiPromptImage } from "../runtime/types.ts";
import { createHubActionsClientFromHubChannel } from "../surface/hub-actions-adapter.ts";
import {
	createCreateAgentTool,
	createDestroyAgentTool,
	createDispatchBashTool,
	createDispatchReadTool,
	createReloadTool,
	createReloadWorkspaceTool,
	createSendMessageTool,
	createTeamTool,
	type DPiLocalToolExecutor,
	type DPiRemoteExecutor,
	type DPiRemoteToolResult,
	type DPiToolDetails,
	setBuiltinContext,
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
	type DPiWorkerModelRegistry,
	type DPiWorkerSession,
	type DPiWorkerSessionManager,
	generateDPiBanner,
	resolveDPiInitialModel,
} from "./worker-adapter.ts";

const config = workerData as AgentWorkerConfig;
const port = parentPort!;

// Module-level references set during runAgentWorker()
let hubChannel: HubChannel | undefined;
let runtime: DPiAgentSessionRuntime | undefined;
let agentRuntime: DPiAgentRuntime | undefined;
let remoteFirstRuntimeModel: Model<Api> | undefined;
let ipcServer: DPiAgentIpcServer | undefined;
let proxy: DPiLocalAgentSessionProxy | undefined;
let agentDefinition: LoadedAgentDefinition | undefined;
let agentConfig: ReturnType<typeof agentDefinitionToConfig> | undefined;
let agentToolNames: string[] = [];
let modelRegistry: DPiWorkerModelRegistry | undefined;

function postToHub(message: WorkerToHubMessage): void {
	port.postMessage(message);
}

async function reloadAgentResources(): Promise<void> {
	if (!runtime?.session || !modelRegistry || !agentRuntime || !hubChannel || !proxy) {
		throw new Error("Reload not available: d-pi session is not initialized yet.");
	}

	const newAgentDefinition = await readLoadedAgentDefinitionFromTs(config.cwd);
	if (!newAgentDefinition) {
		throw new Error("Reload failed: could not load agent definition from agent.ts");
	}

	agentDefinition = newAgentDefinition;
	agentConfig = agentDefinitionToConfig(newAgentDefinition);
	agentToolNames = newAgentDefinition.tools.map((tool) => tool.name);

	modelRegistry.clearWorkspaceModels?.();
	modelRegistry.updateAgentDefinition(newAgentDefinition);

	const resolvedModel = await resolveDPiInitialModel({
		modelRegistry,
		agentDefinition: newAgentDefinition,
		workspaceRoot: config.workspaceContext?.workspaceRoot,
	});
	if (!resolvedModel) {
		throw new Error(`Agent "${config.agentName}" must define a loadable model in agent.ts`);
	}
	remoteFirstRuntimeModel = resolvedModel;
	const thinkingLevel =
		newAgentDefinition.model && typeof newAgentDefinition.model !== "string" && "id" in newAgentDefinition.model
			? newAgentDefinition.model.thinkingLevel
			: undefined;
	await agentRuntime.updateModel(resolvedModel, thinkingLevel);

	const capabilities = setupAgentLocalTools({
		getAgentTools: () => newAgentDefinition.tools,
		getAgentCommands: () => [
			defineCommand({
				name: "agents",
				description: "Switch to a different agent in the team",
				execute: async () => {},
			}),
			...newAgentDefinition.commands,
		],
		getAgentMiddlewares: () => newAgentDefinition.middlewares,
		channel: hubChannel,
		cwd: config.cwd,
		getReloadFn: () => (agentRuntime ? triggerAgentReload : undefined),
		getResourceLoader: () => runtime?.session?.resourceLoader,
		getModelRegistry: () => runtime?.session?.modelRegistry,
		getDisableDefaultTools: () => newAgentDefinition.disableDefaultTools,
	});
	runtime.session.registerCapabilities(capabilities);
	agentToolNames = capabilities.tools.map((t) => t.name);

	await agentRuntime.reloadContext(newAgentDefinition);
	await agentRuntime.updateTools(runtime.session.getToolDefinitions() as AgentTool[], agentToolNames);

	proxy.updateAgentDefinition(newAgentDefinition);

	if (newAgentDefinition.sources && newAgentDefinition.sources.length > 0) {
		postToHub({ type: "subscribe_sources", agentName: config.agentName, sources: [...newAgentDefinition.sources] });
	}

	await runtime.session.reload();
	proxy.setBanner(generateDPiBanner(runtime.session));
}

async function triggerAgentReload(): Promise<void> {
	await reloadAgentResources();
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

interface AgentLocalToolsSetupOptions {
	getAgentTools: () => AgentToolDefinition[];
	getAgentCommands: () => AgentCommandDefinition[];
	getAgentMiddlewares: () => AgentMiddlewareDefinition[];
	channel: HubChannel;
	cwd: string;
	getReloadFn: () => ((reason?: string) => Promise<void>) | undefined;
	getResourceLoader: () => ResourceLoader | undefined;
	getModelRegistry: () => ModelRegistry | undefined;
	getDisableDefaultTools: () => boolean;
}

function getDefaultBuiltinTools(): AgentToolDefinition[] {
	return [
		createDispatchBashTool(),
		createDispatchReadTool(),
		createSendMessageTool(),
		createCreateAgentTool(),
		createDestroyAgentTool(),
		createTeamTool(),
		createReloadTool(),
		createReloadWorkspaceTool(),
	];
}

function setupAgentLocalTools(options: AgentLocalToolsSetupOptions): {
	tools: ToolDefinition[];
	commands: AgentCommandDefinition[];
	middlewares: AgentMiddlewareDefinition[];
} {
	setupBuiltinContext(options);
	const agentTools = options.getAgentTools();
	const disableDefaultTools = options.getDisableDefaultTools();
	const toolMap = new Map<string, AgentToolDefinition>();
	if (!disableDefaultTools) {
		const defaultTools = getDefaultBuiltinTools();
		for (const tool of defaultTools) {
			toolMap.set(tool.name, tool);
		}
	}
	for (const tool of agentTools) {
		toolMap.set(tool.name, tool);
	}
	return {
		tools: [...toolMap.values()] as ToolDefinition[],
		commands: options.getAgentCommands(),
		middlewares: options.getAgentMiddlewares(),
	};
}

function setupBuiltinContext(options: AgentLocalToolsSetupOptions): void {
	const nativeTools = new Map(
		buildNativeToolSet(options.cwd).map((tool) => [tool.name, tool as NativeToolDefinition]),
	);
	const localExecutors: Record<string, DPiLocalToolExecutor> = {};
	for (const [name, tool] of nativeTools) {
		localExecutors[name] = (toolCallId, params, signal, onUpdate) =>
			tool.execute(toolCallId, params as never, signal, onUpdate as never);
	}
	const hubClient = createHubActionsClientFromHubChannel(options.channel);
	setBuiltinContext({
		hubClient,
		agentName: options.channel.agentName,
		localExecutors,
		remoteExecutor: createWorkerRemoteExecutor(options.channel),
		getReloadFn: options.getReloadFn,
		getReloadDetails: () => createReloadSnapshot(options).details,
	});
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

function createReloadSnapshot(options: AgentLocalToolsSetupOptions): {
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
			void routeIncomingHubMessage(message);
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

async function routeIncomingHubMessage(message: Extract<HubToWorkerMessage, { type: "message" }>): Promise<void> {
	if (!agentRuntime) {
		process.stderr.write(`[d-pi worker ${config.agentName}] Dropping incoming message before runtime is ready\n`);
		return;
	}
	try {
		await agentRuntime.prompt(message.content, { mode: message.mode === "steer" ? "steer" : "next" });
	} catch (err) {
		const error = err instanceof Error ? err.message : String(err);
		process.stderr.write(`[d-pi worker ${config.agentName}] Failed to route incoming message: ${error}\n`);
	}
}

async function runAgentWorker(): Promise<void> {
	// `agentName` is the worker's identity — there is no separate id.
	// See "name is identity" in the changelog for the rationale.
	const { agentName, cwd } = config;

	process.stderr.write(`[d-pi worker ${agentName}] Starting agent "${agentName}"...\n`);

	agentDefinition = await readLoadedAgentDefinitionFromTs(cwd);
	agentConfig = agentDefinition ? agentDefinitionToConfig(agentDefinition) : undefined;
	agentToolNames = agentDefinition?.tools.map((tool) => tool.name) ?? [];

	// 1. Create infrastructure
	const { agentDir, modelRegistry: workerModelRegistry } = createDPiWorkerInfrastructure(cwd, {
		agentDefinition,
	});
	modelRegistry = workerModelRegistry;

	process.stderr.write(`[d-pi worker ${agentName}] Infrastructure created\n`);

	// 2. Create the HubChannel for multi-agent communication.
	// Worker-side /agents command is a stub (real implementation
	// lives in the client/connect TUI). It is registered below via registerCapabilities.
	const channel = new HubChannelClass(agentName, postToHub);
	hubChannel = channel;

	// 3. Build the runtime factory (mirrors main.ts pattern)
	const createRuntime = async (opts: { cwd: string; agentDir: string; sessionManager: DPiWorkerSessionManager }) => {
		// Build resourceLoaderOptions from workspace context.
		// Workspace context/*.md, the agent's own AGENTS.md identity,
		// and d-pi meta are concatenated into the same
		// ResourceLoader.appendSystemPrompt array — the same path
		// used by ResourceLoader for every other source-level
		// system-prompt block. d-pi meta is in-source (dpi-meta.ts)
		// rather than an external .md file, so it ships with the
		// package and is regenerated per build via
		// scripts/inject-build-meta.mjs.
		//
		// Order is workspace context → per-agent identity → d-pi
		// runtime meta. The d-pi meta goes LAST so it lands just
		// before the tool list / build stamp at the very end of
		// the system prompt — a stable position across agents that
		// doesn't get pushed around as identity content grows.
		//
		// Bug fix (previously): the appendSystemPrompt array and the
		// agentsFilesOverride closure both captured a snapshot of
		// agent.ts identity at session-start, so session.reload()
		// re-ran resourceLoader.reload() but the d-pi-injected
		// content stayed frozen at startup. Editing agent.ts
		// (description, model) and calling `reload` would NOT
		// refresh the system prompt.
		//
		// Fix: pass `appendSystemPromptOverride` and
		// `agentsFilesOverride` as closures that re-read
		// loadWorkspaceContext + agent.ts on every call. The
		// ResourceLoader invokes these overrides inside its own
		// reload(), so each `reload` re-computes the d-pi-injected
		// sections from the live on-disk state.
		const workspaceRoot = config.workspaceContext?.workspaceRoot;
		const additionalSkillPaths = config.workspaceContext?.additionalSkillPaths ?? [];
		// Keep the executable agent definition as the single source of truth.
		// ResourceLoader overrides are synchronous, so this closure projects the
		// definition loaded above instead of reparsing agent.ts from source.
		const readFreshDPiContext = () => {
			const freshWorkspaceContext = workspaceRoot ? loadWorkspaceContext(workspaceRoot) : undefined;
			return { freshAgentConfig: agentConfig, freshWorkspaceContext };
		};

		process.stderr.write(`[d-pi worker ${agentName}] Creating session services...\n`);

		const services = await createDPiAgentSessionServices({
			cwd: opts.cwd,
			agentDir: opts.agentDir,
			modelRegistry: modelRegistry!,
			resourceLoaderOptions: {
				appendSystemPromptOverride: (base) => {
					// `base` is what ResourceLoader itself discovered
					// (e.g. agent-level context/*.md). Keep it at the
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
					// Re-read the workspace-level AGENTS.md on every call so
					// architecture edits surface without a hub restart. `base`
					// is what ResourceLoader discovered itself (project-level
					// AGENTS.md / CLAUDE.md via loadProjectContextFiles);
					// keep it after the d-pi-injected files so user-level
					// files win on conflicts.
					const { freshWorkspaceContext } = readFreshDPiContext();
					return {
						agentsFiles: [...(freshWorkspaceContext?.additionalAgentsFiles ?? []), ...base.agentsFiles],
					};
				},
				additionalSkillPaths,
			},
		});

		process.stderr.write(`[d-pi worker ${agentName}] Session services created, resolving model...\n`);

		const resolvedModel = await resolveDPiInitialModel({
			modelRegistry: modelRegistry!,
			agentDefinition,
			workspaceRoot: config.workspaceContext?.workspaceRoot,
		});
		remoteFirstRuntimeModel = resolvedModel;
		if (!remoteFirstRuntimeModel) {
			throw new Error(`Agent "${agentName}" must define a loadable model in agent.ts`);
		}

		process.stderr.write(`[d-pi worker ${agentName}] Model resolved: ${resolvedModel?.id ?? "unknown"}\n`);

		const created = await createDPiAgentSessionFromServices({
			services,
			sessionManager: opts.sessionManager,
			model: resolvedModel,
			tools: agentToolNames,
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

	// 6. Create proxy
	proxy = new DPiLocalAgentSessionProxy(runtime!, {
		steeringQueuePath: join(agentDir, "steering.jsonl"),
		agentDefinition: agentDefinition,
	});
	proxy.setBanner(generateDPiBanner(runtime!.session));

	// 7. Bind session tools, event handlers, and message dispatch
	const rebindSession = (): void => {
		const session = runtime!.session;
		const capabilities = setupAgentLocalTools({
			getAgentTools: () => agentDefinition?.tools ?? [],
			getAgentCommands: () => [
				defineCommand({
					name: "agents",
					description: "Switch to a different agent in the team",
					execute: async () => {},
				}),
				...(agentDefinition?.commands ?? []),
			],
			getAgentMiddlewares: () => agentDefinition?.middlewares ?? [],
			channel,
			cwd,
			getReloadFn: () => (agentRuntime ? triggerAgentReload : undefined),
			getResourceLoader: () => runtime?.session?.resourceLoader,
			getModelRegistry: () => runtime?.session?.modelRegistry,
			getDisableDefaultTools: () => agentDefinition?.disableDefaultTools ?? false,
		});
		session.registerCapabilities(capabilities);
		agentToolNames = capabilities.tools.map((t) => t.name);
	};

	runtime!.setBeforeSessionInvalidate(() => {
		// No UI to reset
	});

	runtime!.setRebindSession((session: DPiWorkerSession, reason: "new" | "resume" | "fork") => {
		proxy!.resubscribe(reason);
		rebindSession();
		proxy!.setBanner(generateDPiBanner(session));
	});

	rebindSession();

	if (remoteFirstRuntimeModel) {
		const sessionStore = new DPiSessionStore({
			cwd,
			sessionsRoot: config.sessionDir ?? join(cwd, "session"),
		});
		const sessionHandle = (await sessionStore.openRecent({ cwd })) ?? (await sessionStore.create({ cwd }));
		const initialSessionContext = await sessionHandle.session.buildContext();
		const initialTranscript = projectDPiTranscript(await sessionHandle.session.getBranch());
		const initialCurrentPageMessages = initialTranscript.messages;
		const initialMessages =
			initialCurrentPageMessages.length > 0 ? initialCurrentPageMessages : initialSessionContext.messages;
		const modelThinkingLevel =
			agentDefinition?.model && typeof agentDefinition.model !== "string" && "id" in agentDefinition.model
				? agentDefinition.model.thinkingLevel
				: undefined;
		agentRuntime = new DPiAgentRuntime({
			agentName,
			cwd,
			session: sessionHandle.session,
			sessionInfo: sessionHandle.info,
			initialMessages,
			modelManager: new DPiModelManager({ model: remoteFirstRuntimeModel }),
			contextManager: new DPiContextManager({
				workspaceRoot: config.workspaceContext?.workspaceRoot ?? cwd,
				agentName,
				agentDir: cwd,
				cwd,
				agentDefinition,
			}),
			thinkingLevel: modelThinkingLevel,
			tools: runtime!.session.getToolDefinitions(),
			activeToolNames: agentToolNames,
			getApiKeyAndHeaders: modelRegistry!.getApiKeyAndHeaders
				? async (model) => await modelRegistry!.getApiKeyAndHeaders?.(model)
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
		runtime!.getRuntimeSnapshot = () => agentRuntime!.getSnapshot();
		proxy.applyRuntimeEvent({
			type: "snapshot_update",
			snapshot: agentRuntime.getSnapshot(),
		});
		if (initialMessages.length > 0) {
			proxy.applyRuntimeEvent({
				type: "session_replaced",
				agentName,
				session: sessionHandle.info,
				...(initialTranscript.items.length > 0 ? { transcriptItems: initialTranscript.items } : {}),
				messages: initialMessages,
			});
		}
	}

	proxy.setMessageDispatcher({
		prompt: async (_text: string, _options?: { images?: Array<{ url: string; mediaType?: string }> }) => {
			if (!agentRuntime) {
				throw new Error(`Agent "${agentName}" has no model configured`);
			}
			await agentRuntime.prompt(_text, { mode: "next", images: toPromptImages(_options?.images) });
		},
		steer: async (_text: string, images?: Array<{ url: string; mediaType?: string }>) => {
			if (!agentRuntime) {
				throw new Error(`Agent "${agentName}" has no model configured`);
			}
			await agentRuntime.prompt(_text, { mode: "steer", images: toPromptImages(images) });
		},
		followUp: async (_text: string, images?: Array<{ url: string; mediaType?: string }>) => {
			if (!agentRuntime) {
				throw new Error(`Agent "${agentName}" has no model configured`);
			}
			await agentRuntime.prompt(_text, { mode: "followUp", images: toPromptImages(images) });
		},
		compact: async (customInstructions?: string) => {
			if (!agentRuntime) {
				throw new Error(`Agent "${agentName}" has no model configured`);
			}
			return await agentRuntime.compact(customInstructions);
		},
		abort: async () => {
			await agentRuntime?.abort();
		},
	});

	proxy.setReloadHandler(triggerAgentReload);

	// 8. Start IPC server
	// The IPC server listens for http_request / http_query / sse_subscribe
	// messages from the hub and responds via IPC.
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
		if (event.type === "agent_end") {
			postToHub({ type: "status_update", agentName, status: "ready" });
		} else if (event.type === "compaction_start") {
			postToHub({ type: "status_update", agentName, status: "busy" });
		} else if (event.type === "compaction_end") {
			postToHub({ type: "status_update", agentName, status: "ready" });
		}
	});

	// 9. Signal ready to Hub
	if (agentDefinition?.sources && agentDefinition.sources.length > 0) {
		postToHub({ type: "subscribe_sources", agentName, sources: [...agentDefinition.sources] });
	}
	postToHub({ type: "ready", agentName });
	postToHub({ type: "status_update", agentName, status: "ready" });

	process.stderr.write(`[d-pi worker] Agent "${agentName}" ready (IPC mode)\n`);

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
