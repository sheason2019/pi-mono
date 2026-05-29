#!/usr/bin/env node
import { Hub } from "./hub/hub.ts";

const args = process.argv.slice(2);
const command = args[0];

if (command === "serve") {
	const portIndex = args.indexOf("--port");
	const port = portIndex !== -1 ? parseInt(args[portIndex + 1], 10) : 9090;
	const modelIndex = args.indexOf("--model");
	const model = modelIndex !== -1 ? args[modelIndex + 1] : undefined;

	const hub = new Hub({
		port,
		cwd: process.cwd(),
		model,
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
} else {
	console.log(`d-pi - Multi-agent tree orchestrator

Usage:
  d-pi serve [--port 9090] [--model <model>]
  d-pi connect [--url http://localhost:9090] [--agent <id|name>]
`);
}
