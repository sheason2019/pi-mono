#!/usr/bin/env node
import { Hub } from "./hub/hub.ts";
import { initWorkspace, isWorkspaceRoot, loadWorkspaceContext, validateWorkspace } from "./workspace/workspace.ts";

const args = process.argv.slice(2);
const command = args[0];

if (command === "init") {
	try {
		initWorkspace(process.cwd());
		console.log("[d-pi] Workspace initialized in current directory");
		console.log("[d-pi]   .dpi/config.json        — workspace configuration");
		console.log("[d-pi]   AGENTS.md               — shared context for all agents");
		console.log("[d-pi]   APPEND_SYSTEM.md        — shared system prompt for all agents");
		console.log("[d-pi]   agents/root/            — root agent working directory");
		console.log("[d-pi]   agents/root/AGENTS.md   — root agent specific context");
		console.log("[d-pi]   agents/root/.pi/APPEND_SYSTEM.md — root agent system prompt");
		console.log("[d-pi] Run 'd-pi serve' to start the hub.");
	} catch (err) {
		console.error(`[d-pi] ${err instanceof Error ? err.message : err}`);
		process.exit(1);
	}
} else if (command === "serve") {
	const workspaceRoot = process.cwd();
	if (!isWorkspaceRoot(workspaceRoot)) {
		console.error("[d-pi] Not a d-pi workspace. Run 'd-pi init' first.");
		process.exit(1);
	}

	const workspaceConfig = validateWorkspace(workspaceRoot);
	const workspaceContext = loadWorkspaceContext(workspaceRoot);

	const portIndex = args.indexOf("--port");
	const port = portIndex !== -1 ? parseInt(args[portIndex + 1], 10) : 9090;
	const modelIndex = args.indexOf("--model");
	const model = modelIndex !== -1 ? args[modelIndex + 1] : undefined;

	const hub = new Hub({
		port,
		cwd: workspaceRoot,
		model: model ?? undefined,
		workspaceRoot,
		workspaceContext,
		workspaceConfig,
	});

	hub.start().catch((err) => {
		console.error(`[d-pi] Fatal error: ${err.message}`);
		process.exit(1);
	});
} else if (command === "connect") {
	const urlIndex = args.indexOf("--url");
	const url = urlIndex !== -1 ? args[urlIndex + 1] : "http://localhost:9090";
	const agentIndex = args.indexOf("--agent");
	const agent = agentIndex !== -1 ? args[agentIndex + 1] : undefined;

	import("./connect/connect-mode.ts").then(({ runDPiConnectMode }) => {
		runDPiConnectMode({ url, agent }).catch((err) => {
			console.error(`[d-pi] Fatal error: ${err.message}`);
			process.exit(1);
		});
	});
} else if (command === "_connect-child") {
	// Internal subcommand: run coding-agent's connect mode with /agents extension injected.
	// Spawned by the parent `d-pi connect` process for agent switching.
	const agentUrl = args[1];
	const hubUrl = args[2];

	Promise.all([import("@earendil-works/pi-coding-agent/d-pi-worker"), import("./extension/client-extension.ts")]).then(
		([{ runConnectMode }, { createDPiClientExtensionFactory }]) => {
			const currentAgentId = process.env.DPI_CURRENT_AGENT_ID;
			const clientExtensionFactory = createDPiClientExtensionFactory(hubUrl, currentAgentId);
			runConnectMode({
				url: agentUrl,
				clientExtensionFactories: [clientExtensionFactory],
			}).catch((err: Error) => {
				console.error(`[d-pi connect] Fatal error: ${err.message}`);
				process.exit(1);
			});
		},
	);
} else {
	console.log(`d-pi - Multi-agent tree orchestrator

Usage:
  d-pi init                         Initialize a workspace in the current directory
  d-pi serve [--port 9090] [--model <model>]  Start the hub (must be in a workspace)
  d-pi connect [--url http://localhost:9090] [--agent <id|name>]
`);
}
