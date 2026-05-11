import { VERSION } from "../../version.js";
import { HubRuntime } from "../runtime/hub-runtime.js";
import { HUB_PROTOCOL_VERSION } from "../transport/protocol.js";
import { HubHeadlessMode } from "../tui/hub-headless-mode.js";
import { type HubLogEntry, HubLogStore } from "../tui/hub-log.js";
import { type HubServeMode, HubTuiMode, type HubTuiModeDeps } from "../tui/hub-tui-mode.js";
import type { HubTuiStatusCounts, HubTuiViewModel } from "../tui/hub-tui-view.js";
import { WorkspaceNotInitializedError } from "../workspace.js";

export interface RunServeOptions {
	allowHubNoModel?: boolean;
	panel?: boolean;
	createMode?: (deps: HubTuiModeDeps) => HubServeMode;
	createHeadlessMode?: (deps: HubTuiModeDeps) => HubServeMode;
}

export function parseHubServeArgs(args: string[]): Pick<RunServeOptions, "allowHubNoModel" | "panel"> {
	return { allowHubNoModel: args.includes("--allow-hub-no-model"), panel: args.includes("--panel") };
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
		const logs = HubLogStore.openWorkspace(cwd);
		logs.info(`hub ${VERSION} 启动中 (protocol v${HUB_PROTOCOL_VERSION})`);
		logs.info(`Node.js ${process.version} on ${process.platform}/${process.arch}`);
		const runtimeOpenStartedAt = Date.now();
		const runtime = HubRuntime.open(cwd, { logs });
		logs.info("hub startup timing", { phase: "runtime_open", durationMs: Date.now() - runtimeOpenStartedAt });
		let mode: HubServeMode | undefined;
		const adapterStartStartedAt = Date.now();
		const adapter = await runtime.initializeAgentAdapter();
		logs.info("hub startup timing", {
			phase: "initialize_agent_adapter",
			durationMs: Date.now() - adapterStartStartedAt,
		});
		const availableModels = await adapter.getAvailableModels();
		if (availableModels.length === 0 && !options.allowHubNoModel) {
			const message =
				"Hub has no available models. Configure at least one hub-side model or pass --allow-hub-no-model to start anyway.";
			console.error(message);
			logs.error(message);
			await runtime.stop();
			return 1;
		}
		const socketStartStartedAt = Date.now();
		const address = await runtime.start();
		logs.info("hub startup timing", { phase: "runtime_start", durationMs: Date.now() - socketStartStartedAt });
		logs.info(`hub ${VERSION} 已监听 http://${address.host}:${address.port}`);
		if (runtime.rootTokenForDisplay) {
			logs.warning(`Root token: ${runtime.rootTokenForDisplay}`);
			logs.warning("Root token is shown once; store it securely.");
		}
		for (const record of runtime.getAgentRecords()) {
			const status = runtime.getAgentHydrationStatus(record.id);
			logs.info(`${record.id} agent ${status === "running" ? "已启动" : "等待后台加载"}`);
		}
		if (adapter.diagnostics.length > 0) {
			logs.warning(`root agent 诊断信息 ${adapter.diagnostics.length} 条`);
		}
		try {
			const createMode = options.panel
				? (options.createMode ?? ((deps) => new HubTuiMode(deps)))
				: (options.createHeadlessMode ?? ((deps) => new HubHeadlessMode(deps)));
			mode = createMode({
				getView: () => buildHubServeView(runtime, address, logs),
				subscribe: (listener) => {
					return runtime.subscribeAllSessionServiceEvents((_agentId) => listener());
				},
			});
			return await mode.run();
		} finally {
			logs.info("hub 正在停止");
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
