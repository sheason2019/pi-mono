import type { AgentMessage } from "@sheason/pi-agent-core";
import type {
	CreateAgentSessionServicesOptions,
	ExtensionFactory,
	SessionBeforeCompactEvent,
	SessionBeforeTreeEvent,
	SessionEntry,
	ToolDefinition,
} from "@sheason/pi-coding-agent";
import { type MessageSource, messageSourceHeaderPrefix } from "../agent/types.js";

type ResourceLoaderOptions = NonNullable<CreateAgentSessionServicesOptions["resourceLoaderOptions"]>;

type UserAgentMessage = Extract<AgentMessage, { role: "user" }>;
type SourceAwareUserMessage = UserAgentMessage & {
	messageSource?: MessageSource;
};
type TextContent = { type: "text"; text: string };

export interface CreateDPiExtensionFactoryOptions {
	tools: readonly ToolDefinition[];
}

export function isDynamicMcpToolName(name: string): boolean {
	return name.startsWith("mcp__");
}

export function appendDPiExtensionFactory(
	options: CreateAgentSessionServicesOptions["resourceLoaderOptions"],
	factory: ExtensionFactory,
): ResourceLoaderOptions {
	return {
		...(options ?? {}),
		extensionFactories: [...(options?.extensionFactories ?? []), factory],
	};
}

export function createDPiExtensionFactory(options: CreateDPiExtensionFactoryOptions): ExtensionFactory {
	const tools = [...options.tools];

	return (pi) => {
		for (const tool of tools) {
			pi.registerTool(tool);
		}

		pi.on("context", (event) => ({
			messages: event.messages.map(addMessageSourceHeader),
		}));

		pi.on("session_before_compact", (event) => {
			addMessageSourceHeadersToCompactionPreparation(event.preparation);
		});

		pi.on("session_before_tree", (event) => {
			addMessageSourceHeadersToTreePreparation(event.preparation);
		});
	};
}

export function addMessageSourceHeadersToCompactionPreparation(
	preparation: SessionBeforeCompactEvent["preparation"],
): void {
	preparation.messagesToSummarize = preparation.messagesToSummarize.map(addMessageSourceHeader);
	preparation.turnPrefixMessages = preparation.turnPrefixMessages.map(addMessageSourceHeader);
}

export function addMessageSourceHeadersToTreePreparation(preparation: SessionBeforeTreeEvent["preparation"]): void {
	preparation.entriesToSummarize.splice(
		0,
		preparation.entriesToSummarize.length,
		...preparation.entriesToSummarize.map(addMessageSourceHeaderToEntry),
	);
}

function addMessageSourceHeaderToEntry(entry: SessionEntry): SessionEntry {
	if (entry.type !== "message") {
		return entry;
	}
	const message = addMessageSourceHeader(entry.message);
	return message === entry.message ? entry : { ...entry, message };
}

export function addMessageSourceHeader(message: AgentMessage): AgentMessage {
	if (message.role !== "user") {
		return message;
	}
	const sourceAwareMessage = message as SourceAwareUserMessage;
	const source = sourceAwareMessage.messageSource;
	if (!source) {
		return message;
	}
	const { messageSource: _messageSource, ...messageWithoutSource } = sourceAwareMessage;
	const prefix = messageSourceHeaderPrefix(source);
	if (typeof sourceAwareMessage.content === "string") {
		if (sourceAwareMessage.content.startsWith(prefix) || sourceAwareMessage.content.startsWith("[message source:")) {
			return messageWithoutSource;
		}
		return { ...messageWithoutSource, content: `${prefix}${sourceAwareMessage.content}` };
	}
	const parts = [...sourceAwareMessage.content];
	const textIndex = parts.findIndex(isTextContent);
	if (textIndex === -1) {
		return {
			...messageWithoutSource,
			content: [{ type: "text", text: prefix }, ...parts],
		};
	}
	const textPart = parts[textIndex];
	if (!isTextContent(textPart)) {
		return messageWithoutSource;
	}
	if (textPart.text.startsWith(prefix) || textPart.text.startsWith("[message source:")) {
		return messageWithoutSource;
	}
	parts[textIndex] = { ...textPart, text: `${prefix}${textPart.text}` };
	return { ...messageWithoutSource, content: parts };
}

function isTextContent(content: { type: string }): content is TextContent {
	return content.type === "text" && "text" in content && typeof content.text === "string";
}
