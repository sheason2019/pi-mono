#!/usr/bin/env node
import { runDPiCli } from "./cli-runner.ts";

runDPiCli(process.argv.slice(2)).catch((err: Error) => {
	console.error(`[d-pi] Fatal error: ${err.message}`);
	process.exit(1);
});
