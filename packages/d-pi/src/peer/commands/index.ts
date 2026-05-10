import { DISABLED_SESSION_COMMAND_NAMES } from "../../hub/index.js";
import type { RemoteInteractiveCapabilities } from "../tui/interactive/remote-interactive-capabilities.js";

export const DISABLED_PEER_COMMAND_NAMES = DISABLED_SESSION_COMMAND_NAMES;
export const VISIBLE_PEER_COMMANDS = [
	{ name: "model", description: "Inspect or switch the active model" },
	{ name: "settings", description: "Inspect supported peer settings" },
	{ name: "compact", description: "Ask hub to compact the current session" },
	{ name: "reload", description: "Ask hub to reload resources" },
	{ name: "group", description: "Show current hub group agents and tool executors" },
	{ name: "session", description: "Show current session snapshot details" },
	{ name: "source", description: "Show hub and peer-local source processes and status" },
	{ name: "mcp", description: "Show hub-configured MCP servers, capabilities, and status" },
	{ name: "skills", description: "Show available hub and peer skills" },
] as const;

const VALID_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

export type VisiblePeerCommand = (typeof VISIBLE_PEER_COMMANDS)[number];
export type PeerThinkingLevel = (typeof VALID_THINKING_LEVELS)[number];
export type DisabledPeerCommandName = (typeof DISABLED_PEER_COMMAND_NAMES)[number];

export type PeerCommandParseResult =
	| { kind: "set_model"; provider: string; modelId: string }
	| { kind: "show_model" }
	| { kind: "set_thinking_level"; level: PeerThinkingLevel }
	| { kind: "show_settings" }
	| { kind: "compact"; customInstructions?: string }
	| { kind: "reload" }
	| { kind: "show_group" }
	| { kind: "show_session" }
	| { kind: "show_sources" }
	| { kind: "show_mcp_servers" }
	| { kind: "show_skills" }
	| { kind: "disabled"; commandName: DisabledPeerCommandName; message: string }
	| { kind: "invalid"; commandName: string; message: string };

export function getVisiblePeerCommands(
	capabilities: Pick<RemoteInteractiveCapabilities, "supportsCompact" | "supportsReload" | "supportsModelSelection">,
): readonly VisiblePeerCommand[] {
	return VISIBLE_PEER_COMMANDS.filter((command) => {
		switch (command.name) {
			case "model":
				return capabilities.supportsModelSelection;
			case "compact":
				return capabilities.supportsCompact;
			case "reload":
				return capabilities.supportsReload;
			default:
				return true;
		}
	});
}

export function parsePeerCommand(input: string): PeerCommandParseResult | null {
	if (!input.startsWith("/")) {
		return null;
	}

	const trimmed = input.trim();
	const withoutSlash = trimmed.slice(1);
	if (withoutSlash.length === 0) {
		return {
			kind: "invalid",
			commandName: "",
			message: "Command name is required after '/'.",
		};
	}

	const firstSpaceIndex = withoutSlash.indexOf(" ");
	const commandName = (firstSpaceIndex === -1 ? withoutSlash : withoutSlash.slice(0, firstSpaceIndex)).trim();
	const rawArgs = firstSpaceIndex === -1 ? "" : withoutSlash.slice(firstSpaceIndex + 1).trim();

	if (isDisabledPeerCommandName(commandName)) {
		return {
			kind: "disabled",
			commandName,
			message: getDisabledCommandMessage(commandName),
		};
	}
	if (commandName.startsWith("skill:")) {
		return null;
	}

	switch (commandName) {
		case "model":
			return parseModelCommand(rawArgs);
		case "settings":
			return parseSettingsCommand(rawArgs);
		case "compact":
			return rawArgs.length > 0 ? { kind: "compact", customInstructions: rawArgs } : { kind: "compact" };
		case "reload":
			return rawArgs.length > 0
				? invalid(commandName, '"/reload" does not accept arguments.')
				: {
						kind: "reload",
					};
		case "group":
			return rawArgs.length > 0
				? invalid(commandName, '"/group" does not accept arguments.')
				: {
						kind: "show_group",
					};
		case "session":
			return rawArgs.length > 0
				? invalid(commandName, '"/session" does not accept arguments.')
				: {
						kind: "show_session",
					};
		case "source":
			return rawArgs.length > 0
				? invalid(commandName, '"/source" does not accept arguments.')
				: {
						kind: "show_sources",
					};
		case "mcp":
			return rawArgs.length > 0
				? invalid(commandName, '"/mcp" does not accept arguments.')
				: {
						kind: "show_mcp_servers",
					};
		case "skills":
			return rawArgs.length > 0
				? invalid(commandName, '"/skills" does not accept arguments.')
				: {
						kind: "show_skills",
					};
		default:
			return invalid(commandName, `Unsupported peer command: /${commandName}`);
	}
}

function parseModelCommand(rawArgs: string): PeerCommandParseResult {
	if (rawArgs.length === 0) {
		return { kind: "show_model" };
	}

	const slashIndex = rawArgs.indexOf("/");
	if (slashIndex <= 0 || slashIndex === rawArgs.length - 1) {
		return invalid("model", '"/model" expects "<provider>/<model-id>".');
	}

	return {
		kind: "set_model",
		provider: rawArgs.slice(0, slashIndex),
		modelId: rawArgs.slice(slashIndex + 1),
	};
}

function parseSettingsCommand(rawArgs: string): PeerCommandParseResult {
	if (rawArgs.length === 0) {
		return { kind: "show_settings" };
	}

	const [settingName, settingValue, ...rest] = rawArgs.split(/\s+/);
	if (settingName !== "thinking") {
		return invalid("settings", 'Supported form: "/settings thinking <level>".');
	}
	if (!settingValue || rest.length > 0) {
		return invalid("settings", '"/settings thinking" expects exactly one thinking level.');
	}
	if (!isThinkingLevel(settingValue)) {
		return invalid("settings", `Invalid thinking level: ${settingValue}`);
	}

	return {
		kind: "set_thinking_level",
		level: settingValue,
	};
}

function invalid(commandName: string, message: string): PeerCommandParseResult {
	return {
		kind: "invalid",
		commandName,
		message,
	};
}

function getDisabledCommandMessage(commandName: DisabledPeerCommandName): string {
	switch (commandName) {
		case "new":
			return 'D-Pi hub keeps one active session per workspace right now. "/new" is unavailable.';
		case "resume":
			return 'D-Pi hub keeps one active session per workspace right now. "/resume" is unavailable.';
		case "tree":
		case "fork":
		case "clone":
			return `Session branching is not enabled in D-Pi hub yet. "/${commandName}" is unavailable right now.`;
	}
}

function isDisabledPeerCommandName(commandName: string): commandName is DisabledPeerCommandName {
	return DISABLED_PEER_COMMAND_NAMES.includes(commandName as DisabledPeerCommandName);
}

function isThinkingLevel(value: string): value is PeerThinkingLevel {
	return VALID_THINKING_LEVELS.includes(value as PeerThinkingLevel);
}
