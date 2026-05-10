#!/usr/bin/env node

const AUTOMERGE_INIT_SYNC_DEPRECATION = "using deprecated parameters for `initSync()`; pass a single object instead";

function suppressKnownStartupWarnings(): () => void {
	const originalWarn = console.warn;
	console.warn = (...args: unknown[]) => {
		if (args[0] === AUTOMERGE_INIT_SYNC_DEPRECATION) {
			return;
		}
		originalWarn(...args);
	};
	return () => {
		console.warn = originalWarn;
	};
}

export async function runDPiCli(args: string[] = process.argv.slice(2)): Promise<number> {
	const restoreWarn = suppressKnownStartupWarnings();
	let runner: typeof import("./bundled-runner.js");
	try {
		runner = await import("./bundled-runner.js");
	} finally {
		restoreWarn();
	}
	return runner.runBundledDPiCli(args);
}

void runDPiCli(process.argv.slice(2))
	.then((code) => {
		process.exitCode = code;
	})
	.catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
