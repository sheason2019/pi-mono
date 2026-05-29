/**
 * Agent Worker — runs inside a Worker thread.
 *
 * Creates a full pi agent instance (AgentSessionRuntime + AgentHttpServer)
 * following the same pattern as serve-mode.ts. Communicates with the Hub
 * via parentPort for tool calls and incoming messages.
 */
import { parentPort, workerData } from "node:worker_threads";
import type { Model } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
	AuthStorage,
	getAgentDir,
	ModelRegistry,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
	AgentHttpServer,
	type AgentSessionRuntime,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	findInitialModel,
	generateBanner,
	LocalAgentSessionProxy,
} from "@earendil-works/pi-coding-agent/d-pi-worker";
import { createDPiExtensionFactory, HubChannel } from "../extension/index.ts";
import type { AgentWorkerConfig, HubToWorkerMessage, WorkerToHubMessage } from "../types.ts";

const config = workerData as AgentWorkerConfig;
const port = parentPort!;

// The HubChannel shared across tools — used to resolve tool_call results
let hubChannel: HubChannel | undefined;

// Module-level references set during runAgentWorker()
let runtime: AgentSessionRuntime | undefined;
let httpServer: AgentHttpServer | undefined;
let proxy: LocalAgentSessionProxy | undefined;

function postToHub(message: WorkerToHubMessage): void {
	port.postMessage(message);
}

// Listen for messages from Hub
port.on("message", (message: HubToWorkerMessage) => {
	switch (message.type) {
		case "tool_result":
			hubChannel?.resolveCall(message.callId, message.result);
			break;
		case "message":
			handleIncomingMessage(message.fromAgentId, message.content);
			break;
		case "destroy":
			gracefulShutdown();
			break;
	}
});

async function runAgentWorker(): Promise<void> {
	const { agentId, port: agentPort, cwd, model: modelSpec, agentName } = config;
	const agentDir = getAgentDir();

	// 1. Create infrastructure
	const authStorage = AuthStorage.create();
	const settingsManager = SettingsManager.create(cwd, agentDir);
	const modelRegistry = ModelRegistry.create(authStorage);

	// 2. Create the d-pi extension factory
	const extensionFactory = createDPiExtensionFactory(agentId, postToHub);

	// Also create a HubChannel reference for resolving tool results
	hubChannel = new HubChannel(agentId, postToHub);

	// 3. Build the runtime factory (mirrors main.ts pattern)
	const createRuntime = async (opts: { cwd: string; agentDir: string; sessionManager: SessionManager }) => {
		// Build resourceLoaderOptions from workspace context
		const appendSystemPrompt = config.workspaceContext?.appendSystemPrompt
			? [config.workspaceContext.appendSystemPrompt]
			: undefined;
		const additionalSkillPaths = config.workspaceContext?.additionalSkillPaths ?? [];
		const additionalExtensionPaths = config.workspaceContext?.additionalExtensionPaths ?? [];

		const services = await createAgentSessionServices({
			cwd: opts.cwd,
			agentDir: opts.agentDir,
			authStorage,
			settingsManager,
			modelRegistry,
			resourceLoaderOptions: {
				extensionFactories: [{ factory: extensionFactory, name: "<d-pi-built-in-std-extension>" }],
				appendSystemPrompt,
				additionalSkillPaths,
				additionalExtensionPaths,
			},
		});

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

		const created = await createAgentSessionFromServices({
			services,
			sessionManager: opts.sessionManager,
			model: resolvedModel,
		});

		return { ...created, services, diagnostics: services.diagnostics };
	};

	// 4. Create session manager — continue recent session if available
	const sessionManager = SessionManager.continueRecent(cwd);

	// 5. Create runtime
	runtime = await createAgentSessionRuntime(createRuntime, {
		cwd,
		agentDir,
		sessionManager,
	});

	// 6. Create proxy and HTTP server (same pattern as serve-mode.ts)
	proxy = new LocalAgentSessionProxy(runtime!);
	proxy.setBanner(generateBanner(runtime!.session));

	httpServer = new AgentHttpServer(proxy);

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
				process.stderr.write(`[d-pi worker ${agentId}] Extension error (${err.extensionPath}): ${err.error}\n`);
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
	});

	// Initial bind for the first session
	await rebindSession();

	// 8. Start HTTP server
	await httpServer.start(agentPort);

	// 9. Signal ready to Hub
	postToHub({ type: "ready", agentId, port: agentPort });
	postToHub({ type: "status_update", agentId, status: "ready" });

	process.stderr.write(`[d-pi worker] Agent "${agentName}" (${agentId}) ready on port ${agentPort}\n`);

	// Keep alive
	return new Promise(() => {});
}

function handleIncomingMessage(fromAgentId: string, content: string): void {
	process.stderr.write(`[d-pi worker ${config.agentId}] Received message from ${fromAgentId}\n`);
	if (runtime) {
		runtime.session.followUp(content);
	}
}

async function gracefulShutdown(): Promise<void> {
	postToHub({ type: "status_update", agentId: config.agentId, status: "destroyed" });
	try {
		await httpServer?.stop();
	} catch {
		// Ignore errors during shutdown
	}
	proxy?.dispose();
	process.exit(0);
}

runAgentWorker().catch((err: unknown) => {
	postToHub({ type: "error", agentId: config.agentId, error: String(err) });
	process.exit(1);
});
