import { describe, expect, it } from "vitest";
import { AcpGuestProjection } from "../../src/guest/acp-guest-projection.js";
import { PeerAppState } from "../../src/peer/state/peer-app-state.js";

describe("AcpGuestProjection", () => {
	it("projects ACP text and tool updates into the TUI app state", () => {
		const appState = new PeerAppState();
		const projection = new AcpGuestProjection({
			appState,
			agentId: "claude-guest",
			cwd: "/tmp/workspace",
			sessionId: "acp-session",
		});

		projection.appendUserPrompt("hello");
		projection.applySessionUpdate({
			sessionId: "acp-session",
			update: {
				sessionUpdate: "agent_message_chunk",
				content: { type: "text", text: "hi " },
			},
		});
		projection.applySessionUpdate({
			sessionId: "acp-session",
			update: {
				sessionUpdate: "agent_message_chunk",
				content: { type: "text", text: "there" },
			},
		});
		projection.applySessionUpdate({
			sessionId: "acp-session",
			update: {
				sessionUpdate: "tool_call",
				toolCallId: "tool-1",
				title: "Read file",
				status: "pending",
				rawInput: { path: "README.md" },
			},
		});
		projection.applySessionUpdate({
			sessionId: "acp-session",
			update: {
				sessionUpdate: "tool_call_update",
				toolCallId: "tool-1",
				status: "completed",
				content: [{ type: "content", content: { type: "text", text: "done" } }],
			},
		});
		projection.completeTurn("end_turn");

		const snapshot = appState.getSnapshot();
		expect(snapshot.selectedAgent?.status.isRunning).toBe(false);
		expect(snapshot.selectedAgent?.context.pendingToolCallIds).toEqual([]);
		expect(snapshot.selectedAgent?.items).toEqual([
			{ type: "message", message: expect.objectContaining({ role: "user", content: "hello" }) },
			{
				type: "message",
				message: expect.objectContaining({
					role: "assistant",
					content: expect.arrayContaining([
						{ type: "text", text: "hi there" },
						expect.objectContaining({ type: "toolCall", id: "tool-1", name: "Read file" }),
					]),
				}),
			},
			{
				type: "message",
				message: expect.objectContaining({
					role: "toolResult",
					toolCallId: "tool-1",
					toolName: "Read file",
					content: [{ type: "text", text: "done" }],
					isError: false,
				}),
			},
		]);
		expect(snapshot.live.toolExecutions).toEqual([]);
	});

	it("finalizes failed tools as error tool results", () => {
		const appState = new PeerAppState();
		const projection = new AcpGuestProjection({
			appState,
			agentId: "claude-guest",
			cwd: "/tmp/workspace",
		});

		projection.appendUserPrompt("hello");
		projection.applySessionUpdate({
			sessionId: "acp-session",
			update: {
				sessionUpdate: "tool_call",
				toolCallId: "tool-1",
				title: "Run command",
				status: "in_progress",
			},
		});
		projection.applySessionUpdate({
			sessionId: "acp-session",
			update: {
				sessionUpdate: "tool_call_update",
				toolCallId: "tool-1",
				status: "failed",
				content: [{ type: "content", content: { type: "text", text: "permission denied" } }],
			},
		});

		const snapshot = appState.getSnapshot();
		expect(snapshot.selectedAgent?.context.pendingToolCallIds).toEqual([]);
		expect(snapshot.live.toolExecutions).toEqual([]);
		expect(snapshot.selectedAgent?.items).toContainEqual({
			type: "message",
			message: expect.objectContaining({
				role: "toolResult",
				toolCallId: "tool-1",
				content: [{ type: "text", text: "permission denied" }],
				isError: true,
			}),
		});
	});

	it("starts a new assistant message after a finalized tool result", () => {
		const appState = new PeerAppState();
		const projection = new AcpGuestProjection({
			appState,
			agentId: "claude-guest",
			cwd: "/tmp/workspace",
		});

		projection.appendUserPrompt("hello");
		projection.applySessionUpdate({
			sessionId: "acp-session",
			update: {
				sessionUpdate: "agent_message_chunk",
				content: { type: "text", text: "before" },
			},
		});
		projection.applySessionUpdate({
			sessionId: "acp-session",
			update: {
				sessionUpdate: "tool_call",
				toolCallId: "tool-1",
				title: "Read file",
				status: "completed",
				content: [{ type: "content", content: { type: "text", text: "done" } }],
			},
		});
		projection.applySessionUpdate({
			sessionId: "acp-session",
			update: {
				sessionUpdate: "agent_message_chunk",
				content: { type: "text", text: "after" },
			},
		});

		expect(appState.getSnapshot().selectedAgent?.items).toEqual([
			expect.objectContaining({ message: expect.objectContaining({ role: "user" }) }),
			expect.objectContaining({ message: expect.objectContaining({ role: "assistant" }) }),
			expect.objectContaining({ message: expect.objectContaining({ role: "toolResult" }) }),
			expect.objectContaining({ message: expect.objectContaining({ role: "assistant" }) }),
		]);
	});

	it("keeps distinct ACP message ids as separate assistant messages", () => {
		const appState = new PeerAppState();
		const projection = new AcpGuestProjection({
			appState,
			agentId: "claude-guest",
			cwd: "/tmp/workspace",
		});

		projection.appendUserPrompt("hello");
		projection.applySessionUpdate({
			sessionId: "acp-session",
			update: {
				sessionUpdate: "agent_message_chunk",
				messageId: "message-a",
				content: { type: "text", text: "first" },
			},
		});
		projection.applySessionUpdate({
			sessionId: "acp-session",
			update: {
				sessionUpdate: "agent_message_chunk",
				messageId: "message-b",
				content: { type: "text", text: "second" },
			},
		});

		const assistantItems = appState
			.getSnapshot()
			.selectedAgent?.items.filter((item) => item.type === "message" && item.message.role === "assistant");
		expect(assistantItems).toHaveLength(2);
		expect(assistantItems?.[0]).toEqual({
			type: "message",
			message: expect.objectContaining({ content: [{ type: "text", text: "first" }] }),
		});
		expect(assistantItems?.[1]).toEqual({
			type: "message",
			message: expect.objectContaining({ content: [{ type: "text", text: "second" }] }),
		});
	});

	it("projects inbound hub agent messages as user-visible prompts", () => {
		const appState = new PeerAppState();
		const projection = new AcpGuestProjection({
			appState,
			agentId: "claude-guest",
			cwd: "/tmp/workspace",
		});

		const prompt = projection.appendInboundAgentMessage({
			fromAgentId: "child-a",
			toAgentId: "claude-guest",
			message: "review this",
			sentAt: "2026-05-14T08:00:00.000Z",
		});

		expect(prompt).toContain("from: child-a");
		expect(appState.getSnapshot().selectedAgent?.items[0]).toEqual({
			type: "message",
			message: expect.objectContaining({
				role: "user",
				content: prompt,
			}),
		});
	});
});
