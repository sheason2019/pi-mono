import { setBedrockProviderModule } from "@sheason/pi-ai";
import { bedrockProviderModule } from "@sheason/pi-ai/bedrock-provider";
import { runPiGuestCli } from "./guest/cli.js";
import { runPiHubCli } from "./hub/cli.js";
import { HUB_PROTOCOL_VERSION } from "./hub/transport/protocol.js";
import { getDPiHelpText, resolveDPiCommand } from "./index.js";
import { runPiPeerCli } from "./peer/cli.js";
import { VERSION } from "./version.js";

setBedrockProviderModule(bedrockProviderModule);

type EnvRestore = () => void;

function applyCommandEnv(env: Record<string, string> | undefined): EnvRestore {
	if (!env) {
		return () => {};
	}
	const previous = new Map<string, string | undefined>();
	for (const [key, value] of Object.entries(env)) {
		previous.set(key, process.env[key]);
		process.env[key] = value;
	}
	return () => {
		for (const [key, value] of previous) {
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
	};
}

export async function runBundledDPiCli(args: string[] = process.argv.slice(2)): Promise<number> {
	const [command] = args;
	if (command === undefined || command === "help" || command === "--help" || command === "-h") {
		console.log(getDPiHelpText("d-pi"));
		return 0;
	}
	if (command === "version" || command === "--version" || command === "-v") {
		console.log(`d-pi ${VERSION} (hub protocol v${HUB_PROTOCOL_VERSION})`);
		return 0;
	}

	const resolved = resolveDPiCommand(args);
	if (!resolved) {
		console.error(`Unknown command: ${command}`);
		console.error(getDPiHelpText("d-pi"));
		return 1;
	}

	const restore = applyCommandEnv(resolved.env);
	try {
		if (resolved.subcommand === "hub") {
			return await runPiHubCli(resolved.args);
		}
		if (resolved.subcommand === "guest") {
			return await runPiGuestCli(resolved.args);
		}
		return await runPiPeerCli(resolved.args);
	} finally {
		restore();
	}
}
