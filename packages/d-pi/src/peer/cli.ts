import { getPeerCliHelpText, parsePeerCliArgs } from "./cli-args.js";
import { runAddSkills } from "./commands/add-skills.js";
import { sendOneShotPeerMessage } from "./commands/send-message.js";
import { APP_NAME, VERSION } from "./config.js";
import { PeerRuntime } from "./runtime/peer-runtime.js";
import { PeerInteractiveMode } from "./tui/peer-interactive-mode.js";

function printHelp(): void {
	console.log(`${APP_NAME} ${VERSION}

${getPeerCliHelpText(APP_NAME)}`);
}

export async function runPiPeerCli(args: string[] = process.argv.slice(2)): Promise<number> {
	if (args[0] === "add-skills") {
		runAddSkills();
		return 0;
	}
	const { options, help } = parsePeerCliArgs(args);
	if (help) {
		printHelp();
		return 0;
	}
	if (options.message !== undefined) {
		const response = await sendOneShotPeerMessage({
			hubUrl: options.hubUrl,
			agentId: options.agentId,
			peerId: options.peerId,
			token: options.token,
			message: options.message,
			noResponse: options.noResponse,
			version: VERSION,
		});
		if (response !== undefined) {
			process.stdout.write(`${response}\n`);
		}
		return 0;
	}
	const runtime = new PeerRuntime({
		hubUrl: options.hubUrl,
		agentId: options.agentId,
		peerId: options.peerId,
		displayName: options.displayName,
		token: options.token,
		executorEnabled: options.disableExecutor === true ? false : undefined,
		version: VERSION,
		onHandshakeLog: (message) => {
			console.error(`[d-pi peer] ${message}`);
		},
	});
	const mode = new PeerInteractiveMode(runtime);
	return mode.run();
}
