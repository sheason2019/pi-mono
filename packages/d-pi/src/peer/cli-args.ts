/** Kept in sync with `DEFAULT_HUB_URL` in `index.ts` (kept here to avoid a barrel import cycle). */
const DEFAULT_HUB_URL = "http://127.0.0.1:4317";

export interface PeerCliOptions {
	hubUrl: string;
	agentId?: string;
	peerId?: string;
	displayName?: string;
	token?: string;
	disableExecutor?: boolean;
	message?: string;
	noResponse?: boolean;
}

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

/**
 * Used by the `d-pi peer` entrypoint; stable for unit tests.
 */
export function parsePeerCliArgs(args: string[]): { options: PeerCliOptions; help: boolean } {
	const options: PeerCliOptions = {
		hubUrl: DEFAULT_HUB_URL,
	};
	let help = false;

	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		switch (arg) {
			case "--help":
			case "-h":
				help = true;
				break;
			case "--hub": {
				const v = readOptionValue("--hub", args[i + 1]);
				options.hubUrl = v;
				i += 1;
				break;
			}
			case "--agent": {
				const v = readOptionValue("--agent", args[i + 1]);
				options.agentId = v;
				i += 1;
				break;
			}
			case "--peer-id": {
				const v = readOptionValue("--peer-id", args[i + 1]);
				options.peerId = v;
				i += 1;
				break;
			}
			case "--name": {
				const v = readOptionValue("--name", args[i + 1]);
				options.displayName = v;
				i += 1;
				break;
			}
			case "--token": {
				const v = readOptionValue("--token", args[i + 1]);
				options.token = v;
				i += 1;
				break;
			}
			case "--disable-executor":
				options.disableExecutor = true;
				break;
			case "-p":
			case "--message": {
				const v = readOptionValue(arg, args[i + 1]);
				options.message = v;
				i += 1;
				break;
			}
			case "--no-response":
				options.noResponse = true;
				break;
			default:
				throw new Error(`Unknown argument: ${arg}`);
		}
	}

	if (options.noResponse === true && options.message === undefined) {
		throw new Error("--no-response requires -p or --message.");
	}

	if (options.token === undefined) {
		const envToken = process.env.D_PI_TOKEN?.trim();
		if (envToken) {
			options.token = envToken;
		}
	}

	return { options, help };
}

/**
 * Help body (usage + options) for `d-pi peer --help`, parameterized by the program name
 * (avoids an import cycle with the package entry that defines `APP_NAME`).
 */
export function getPeerCliHelpText(appName: string): string {
	return `Usage:
  ${appName} [--hub <url>] [--agent <agent-id>] [--peer-id <id>] [--name <display-name>] [--token <token>] [--disable-executor]
  ${appName} [--hub <url>] [--agent <agent-id>] [--token <token>] -p <message> [--no-response]
  ${appName} add-skills

Options:
  --hub                Hub base URL (default: ${DEFAULT_HUB_URL})
  --agent              Target hub agent id; omit to bind the default (typically "root"). Use --agent to choose root/child.
  --peer-id            Stable peer id to register with the hub; --peer-id only sets this peer's identity.
  --name               Display name shown in hub peer lists
  --token              Hub access token (or set D_PI_TOKEN)
  --disable-executor   Connect without exposing local peer tools or peer MCP tools to the remote agent
  -p, --message        Send a one-shot message to the target hub agent and print the assistant response
  --no-response        Send the one-shot message without waiting for or printing an assistant response

Examples:
  ${appName} --hub ${DEFAULT_HUB_URL}
  ${appName} --agent writer --hub ${DEFAULT_HUB_URL}
  ${appName} --hub ${DEFAULT_HUB_URL} -p "hello"

Resource configuration:
  Install built-in guidance skills:
    ${appName} add-skills

  Sources: .pi/sources.json
    [{"name":"timer","command":"node","args":[".pi/timer-source.js"]}]
    Source stdout JSON-RPC: {"jsonrpc":"2.0","method":"queue/write","params":{"content":"hello"}}

  MCP: .pi/mcp.json
    {"mcpServers":{"filesystem":{"command":"npx","args":["-y","@modelcontextprotocol/server-filesystem","."]}}}

  Skills: .pi/skills/<skill-name>/SKILL.md
`;
}
