import { VERSION } from "../../version.js";
import { HubRuntime } from "../runtime/hub-runtime.js";
import { HUB_PROTOCOL_VERSION } from "../transport/protocol.js";
import { HubHeadlessMode } from "../tui/hub-headless-mode.js";
import { type HubLogEntry, HubLogStore } from "../tui/hub-log.js";
import type { HubServeMode, HubTuiModeDeps } from "../tui/hub-tui-mode.js";
import type { HubTuiStatusCounts, HubTuiViewModel } from "../tui/hub-tui-view.js";
import { WorkspaceNotInitializedError } from "../workspace.js";

export interface RunServeOptions {
	allowHubNoModel?: boolean;
	createHeadlessMode?: (deps: HubTuiModeDeps) => HubServeMode;
}

export function parseHubServeArgs(args: string[]): Pick<RunServeOptions, "allowHubNoModel"> {
	return { allowHubNoModel: args.includes("--allow-hub-no-model") };
}

function logPhase(
	logs: HubLogStore,
	message: string,
	details?: Record<string, string | number | boolean | null>,
): void {
	const line = details
		? `${message} (${Object.entries(details)
				.map(([k, v]) => `${k}=${v}`)
				.join(", ")})`
		: message;
	console.log(`[d-pi hub] ${line}`);
	logs.info(message, details);
}

function buildHubServeView(
	runtime: HubRuntime,
	address: { host: string; port: number },
	logs: { getEntries: () => HubLogEntry[] },
): HubTuiViewModel {
	const mainAdapter = runtime.getRootAgentRuntime().agentAdapter;
	const resourceSummary = mainAdapter?.resourceLoader.getSummary();
	const agentRecords = runtime.getAgentRecords();
	const mcpStatuses = agentRecords.flatMap((record) => runtime.getMcpServerStatusesForAgent(record.id));
	const sourceStatuses = runtime.sourceHost.getStatuses();
	return {
		status: "running",
		address: `http://${address.host}:${address.port}`,
		workspace: runtime.cwd,
		rootToken: runtime.rootTokenForDisplay,
		hubVersion: VERSION,
		protocolVersion: HUB_PROTOCOL_VERSION,
		agents: agentRecords.map((record) => {
			const rt = runtime.tryGetAgentRuntime(record.id);
			const snapshot = rt?.sessionService.getSnapshot();
			return {
				id: record.id,
				name: record.name,
				description: record.description,
				kind: record.kind,
				isRunning: snapshot?.isRunning ?? false,
				hydrationStatus: runtime.getAgentHydrationStatus(record.id),
				peerCount: rt?.peerRegistry.size() ?? 0,
				sessionFile: record.sessionFile,
				lastError: snapshot?.lastError,
				lastRunDurationMs: snapshot?.lastRunDurationMs,
			};
		}),
		resources: {
			mcpServers: mcpStatuses.length,
			mcpStatusCounts: countRuntimeStatuses(mcpStatuses),
			sources: sourceStatuses.length,
			sourceStatusCounts: countRuntimeStatuses(sourceStatuses),
			skills: resourceSummary?.skills ?? 0,
			prompts: resourceSummary?.prompts ?? 0,
			themes: resourceSummary?.themes ?? 0,
		},
		logs: logs.getEntries(),
	};
}

function countRuntimeStatuses(statuses: Array<{ status: keyof HubTuiStatusCounts }>): HubTuiStatusCounts {
	const counts: HubTuiStatusCounts = { starting: 0, running: 0, stopped: 0, error: 0 };
	for (const entry of statuses) {
		counts[entry.status] += 1;
	}
	return counts;
}

export async function runServe(cwd: string = process.cwd(), options: RunServeOptions = {}): Promise<number> {
	try {
		const overallStart = Date.now();
		const logs = HubLogStore.openWorkspace(cwd);
		logPhase(logs, "hub启动: 初始化日志", { version: VERSION, protocolVersion: HUB_PROTOCOL_VERSION });
		logPhase(logs, "Node.js运行时", { version: process.version, platform: process.platform, arch: process.arch });

		logPhase(logs, "hub启动: 初始化运行时");
		const runtimeOpenStartedAt = Date.now();
		const runtime = HubRuntime.open(cwd, { logs });
		logPhase(logs, "hub startup timing", { phase: "runtime_open", durationMs: Date.now() - runtimeOpenStartedAt });

		logPhase(logs, "hub启动: 初始化智能体适配器");
		const adapterStartStartedAt = Date.now();
		const adapter = await runtime.initializeAgentAdapter();
		const adapterDuration = Date.now() - adapterStartStartedAt;
		logPhase(logs, "hub startup timing", {
			phase: "initialize_agent_adapter",
			durationMs: adapterDuration,
		});

		logPhase(logs, "hub启动: 检查可用模型");
		const modelsStartedAt = Date.now();
		const availableModels = await adapter.getAvailableModels();
		logPhase(logs, "hub startup timing", {
			phase: "check_available_models",
			durationMs: Date.now() - modelsStartedAt,
			models: availableModels.length,
		});
		if (availableModels.length === 0 && !options.allowHubNoModel) {
			const message =
				"Hub has no available models. Configure at least one hub-side model or pass --allow-hub-no-model to start anyway.";
			console.error(message);
			logs.error(message);
			await runtime.stop();
			return 1;
		}

		logPhase(logs, "hub启动: 监听Socket");
		const socketStartStartedAt = Date.now();
		const address = await runtime.start();
		const socketDuration = Date.now() - socketStartStartedAt;
		logPhase(logs, "hub startup timing", { phase: "runtime_start", durationMs: socketDuration });
		logPhase(logs, `hub已监听 ${`http://${address.host}:${address.port}`}`, {
			host: address.host,
			port: address.port,
		});
		if (runtime.rootTokenForDisplay) {
			console.warn(`[d-pi hub] Root token: ${runtime.rootTokenForDisplay}`);
			console.warn("[d-pi hub] Root token is shown once; store it securely.");
		}
		for (const record of runtime.getAgentRecords()) {
			const status = runtime.getAgentHydrationStatus(record.id);
			logPhase(logs, `${record.id} agent ${status === "running" ? "已启动" : "等待后台加载"}`);
		}
		if (adapter.diagnostics.length > 0) {
			logPhase(logs, "root agent 诊断信息", { diagnostics: adapter.diagnostics.length });
		}

		let mode: HubServeMode | undefined;
		try {
			logPhase(logs, "hub启动: 进入服务模式");
			const modeStartedAt = Date.now();
			const factory = options.createHeadlessMode ?? ((deps) => new HubHeadlessMode(deps));
			mode = factory({
				getView: () => buildHubServeView(runtime, address, logs),
				subscribe: (listener) => {
					return runtime.subscribeAllSessionServiceEvents((_agentId) => listener());
				},
			});
			logPhase(logs, "hub startup timing", { phase: "mode_create", durationMs: Date.now() - modeStartedAt });
			logPhase(logs, "hub startup timing", { phase: "overall_startup", durationMs: Date.now() - overallStart });
			return await mode.run();
		} finally {
			console.log("[d-pi hub] 正在停止...");
			await mode?.stop();
			await runtime.stop();
		}
	} catch (error) {
		if (error instanceof WorkspaceNotInitializedError) {
			console.error(error.message);
			return 1;
		}

		throw error;
	}
}
