#!/usr/bin/env node
import { main } from "./index.ts";

main().catch((err: Error) => {
	console.error("[d-pi executor] Fatal: " + err.message);
	process.exit(1);
});
