#!/usr/bin/env node
// Signal handlers are installed at module top-level in ./index.ts so that
// the executor's SSE I/O does not delay exit on SIGTERM/SIGINT, regardless
// of whether this entry point or `d-pi _executor-child` is used to launch
// the process.
import { main } from "./index.ts";

main().catch((err: Error) => {
	console.error(`[d-pi executor] Fatal: ${err.message}`);
	process.exit(1);
});
