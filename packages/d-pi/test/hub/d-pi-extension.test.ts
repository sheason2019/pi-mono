import type { AgentMessage } from "@sheason/pi-agent-core";
import type {
	ExtensionFactory,
	SessionBeforeCompactEvent,
	SessionBeforeTreeEvent,
	SessionEntry,
} from "@sheason/pi-coding-agent";
import { describe, expect, it } from "vitest";
import type { MessageSource } from "../../src/hub/agent/types.js";
import {
	addMessageSourceHeader,
	addMessageSourceHeadersToCompactionPreparation,
	addMessageSourceHeadersToTreePreparation,
	createDPiExtensionFactory,
} from "../../src/hub/extensions/d-pi-extension.js";

type SourceAwareMessage = AgentMessage & { messageSource?: MessageSource };

const peerSource: MessageSource = {
	kind: "peer",
	name: "peer-a",
	sentAt: "2026-05-10T11:00:00.000Z",
	contextHeaders: [{ label: "auth context", value: "guest" }],
};

function sourceMessage(text = "hello"): SourceAwareMessage {
	return {
		role: "user",
		content: [{ type: "text", text }],
		timestamp: 1,
		messageSource: peerSource,
	};
}

function messageText(message: AgentMessage): string {
	if (!("content" in message)) {
		return "";
	}
	const content = message.content;
	if (typeof content === "string") {
		return content;
	}
	if (!Array.isArray(content)) {
		return "";
	}
	return content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

describe("D-Pi extension", () => {
	it("adds messageSource headers like upstream LLM conversion without mutating persisted messages", () => {
		const original = sourceMessage("from peer");
		const converted = addMessageSourceHeader(original) as SourceAwareMessage;

		expect(messageText(converted)).toContain("[message source: peer/peer-a]");
		expect(messageText(converted)).toContain("[message sent at: 2026-05-10T11:00:00.000Z]");
		expect(messageText(converted)).toContain("[auth context: guest]");
		expect(messageText(converted)).toContain("from peer");
		expect(converted.messageSource).toBeUndefined();
		expect(messageText(original)).toBe("from peer");
		expect(original.messageSource).toEqual(peerSource);
	});

	it("applies messageSource headers to compaction preparation only", () => {
		const original = sourceMessage("summarize me");
		const preparation = {
			messagesToSummarize: [original],
			turnPrefixMessages: [original],
		} as unknown as SessionBeforeCompactEvent["preparation"];

		addMessageSourceHeadersToCompactionPreparation(preparation);

		expect(messageText(preparation.messagesToSummarize[0]!)).toContain("[message source: peer/peer-a]");
		expect(messageText(preparation.turnPrefixMessages[0]!)).toContain("[message source: peer/peer-a]");
		expect(messageText(original)).toBe("summarize me");
		expect(original.messageSource).toEqual(peerSource);
	});

	it("applies messageSource headers to branch-summary entries without mutating session entries", () => {
		const original = sourceMessage("branch message");
		const entry = {
			type: "message",
			id: "entry-1",
			timestamp: 1,
			message: original,
		} as unknown as SessionEntry;
		const preparation = {
			entriesToSummarize: [entry],
		} as unknown as SessionBeforeTreeEvent["preparation"];

		addMessageSourceHeadersToTreePreparation(preparation);

		const nextEntry = preparation.entriesToSummarize[0];
		expect(nextEntry).not.toBe(entry);
		expect(nextEntry?.type).toBe("message");
		if (nextEntry?.type === "message") {
			expect(messageText(nextEntry.message)).toContain("[message source: peer/peer-a]");
		}
		expect(messageText(original)).toBe("branch message");
		expect(original.messageSource).toEqual(peerSource);
	});

	it("does not auto-discover D-Pi built-in skills by default", async () => {
		const events: string[] = [];
		const factory = createDPiExtensionFactory({ tools: [] });
		const pi = {
			registerTool: () => {},
			on: (event: string) => {
				events.push(event);
			},
		} as unknown as Parameters<ExtensionFactory>[0];

		await factory(pi);

		expect(events).toContain("context");
		expect(events).toContain("session_before_compact");
		expect(events).toContain("session_before_tree");
		expect(events).not.toContain("resources_discover");
	});
});
