const DEFAULT_HUB_URL = "http://127.0.0.1:4317";

export interface GuestAcpCliOptions {
	hubUrl: string;
	agentId: string;
	token?: string;
	displayName?: string;
	acpCommand: string;
	acpArgs: string[];
}

export type GuestCliParseResult =
	| { help: true; command?: "acp"; options?: never }
	| { help: false; command: "acp"; options: GuestAcpCliOptions };

function readOptionValue(flagName: string, next: string | undefined): string {
	if (next === undefined) {
		throw new Error(`Missing value for ${flagName}.`);
	}
	if (next.trim().length === 0) {
		throw new Error(`Invalid value for ${flagName}: value cannot be empty.`);
	}
	if (next.startsWith("-")) {
		throw new Error(`Invalid value for ${flagName}: expected an argument, found "${next}".`);
	}
	return next;
}

export function parseGuestCliArgs(args: string[]): GuestCliParseResult {
	const [command, ...rest] = args;
	if (command === undefined || command === "--help" || command === "-h" || command === "help") {
		return { help: true };
	}
	if (command !== "acp") {
		throw new Error(`Unknown guest command: ${command}`);
	}
	if (rest[0] === "--help" || rest[0] === "-h") {
		return { help: true, command: "acp" };
	}
	const delimiterIndex = rest.indexOf("--");
	if (delimiterIndex < 0) {
		throw new Error('guest acp requires "--" before the external ACP command.');
	}
	const optionArgs = rest.slice(0, delimiterIndex);
	const acpCommandArgs = rest.slice(delimiterIndex + 1);
	const options: Omit<GuestAcpCliOptions, "agentId" | "acpCommand" | "acpArgs"> & { agentId?: string } = {
		hubUrl: DEFAULT_HUB_URL,
	};
	for (let i = 0; i < optionArgs.length; i += 1) {
		const arg = optionArgs[i];
		switch (arg) {
			case "--hub":
				options.hubUrl = readOptionValue("--hub", optionArgs[i + 1]);
				i += 1;
				break;
			case "--agent":
				options.agentId = readOptionValue("--agent", optionArgs[i + 1]);
				i += 1;
				break;
			case "--token":
				options.token = readOptionValue("--token", optionArgs[i + 1]);
				i += 1;
				break;
			case "--name":
				options.displayName = readOptionValue("--name", optionArgs[i + 1]);
				i += 1;
				break;
			default:
				throw new Error(`Unknown guest acp argument: ${arg}`);
		}
	}
	if (options.agentId === undefined) {
		throw new Error("guest acp requires --agent <guest-agent-id>.");
	}
	if (options.token === undefined) {
		const envToken = process.env.D_PI_TOKEN?.trim();
		if (envToken) {
			options.token = envToken;
		}
	}
	const [acpCommand, ...acpArgs] = acpCommandArgs;
	if (!acpCommand || acpCommand.trim().length === 0) {
		throw new Error("guest acp requires an external ACP command after --.");
	}
	return {
		help: false,
		command: "acp",
		options: {
			...options,
			agentId: options.agentId,
			acpCommand,
			acpArgs,
		},
	};
}

export function getGuestCliHelpText(appName: string): string {
	return `Usage:
  ${appName} acp [--hub <url>] --agent <guest-agent-id> [--token <token>] [--name <display-name>] -- <acp-command> [args...]

Options:
  --hub     Hub base URL (default: ${DEFAULT_HUB_URL})
  --agent   Existing guest agent id to bind
  --token   Hub access token (or set D_PI_TOKEN)
  --name    Display name shown in hub peer lists

Examples:
  ${appName} acp --agent claude-guest -- claude acp
`;
}
