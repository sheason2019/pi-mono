import { PeerInteractiveMode } from "../peer/tui/peer-interactive-mode.js";
import { VERSION } from "../version.js";
import { GuestAcpRuntime } from "./acp-guest-runtime.js";
import { getGuestCliHelpText, parseGuestCliArgs } from "./cli-args.js";

function printHelp(): void {
	console.log(`d-pi guest ${VERSION}

${getGuestCliHelpText("d-pi guest")}`);
}

export async function runPiGuestCli(args: string[] = process.argv.slice(2)): Promise<number> {
	const parsed = parseGuestCliArgs(args);
	if (parsed.help) {
		printHelp();
		return 0;
	}
	const runtime = GuestAcpRuntime.fromCommand({ ...parsed.options, version: VERSION });
	const mode = new PeerInteractiveMode(runtime, {
		capabilities: {
			supportsCompact: false,
			supportsReload: false,
			supportsModelSelection: false,
			supportsAgentSwitching: false,
			supportsSettings: false,
			supportsSessionDetails: false,
			supportsSources: false,
			supportsMcp: false,
			supportsSkills: false,
		},
	});
	return mode.run();
}
