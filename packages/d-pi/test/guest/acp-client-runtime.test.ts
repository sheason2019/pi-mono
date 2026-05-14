import { PassThrough, Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";
import { AcpClientRuntime } from "../../src/guest/acp-client-runtime.js";
import { createAcpProcessEnv, formatGuestAgentMessagePrompt } from "../../src/guest/acp-guest-runtime.js";

function createPairedStreams(): { client: acp.Stream; agent: acp.Stream } {
	const clientToAgent = new PassThrough();
	const agentToClient = new PassThrough();
	return {
		client: acp.ndJsonStream(WritableStreamFrom(clientToAgent), ReadableStreamFrom(agentToClient)),
		agent: acp.ndJsonStream(WritableStreamFrom(agentToClient), ReadableStreamFrom(clientToAgent)),
	};
}

function WritableStreamFrom(stream: PassThrough): WritableStream<Uint8Array> {
	return Writable.toWeb(stream) as WritableStream<Uint8Array>;
}

function ReadableStreamFrom(stream: PassThrough): ReadableStream<Uint8Array> {
	return Readable.toWeb(stream) as ReadableStream<Uint8Array>;
}

describe("AcpClientRuntime", () => {
	it("does not pass the D-Pi hub token to the external ACP process environment", () => {
		expect(
			createAcpProcessEnv({
				D_PI_TOKEN: "dpi_secret",
				PATH: "/bin",
			}),
		).toEqual({ PATH: "/bin" });
	});

	it("formats inbound hub agent messages as ordinary ACP prompts with metadata", () => {
		expect(
			formatGuestAgentMessagePrompt({
				fromAgentId: "child-a",
				toAgentId: "claude-guest",
				message: "please review this",
				sentAt: "2026-05-14T07:00:00.000Z",
			}),
		).toBe(
			[
				"[D-Pi agent message]",
				"from: child-a",
				"to: claude-guest",
				"sent_at: 2026-05-14T07:00:00.000Z",
				"",
				"please review this",
			].join("\n"),
		);
	});

	it("runs a prompt through a stdio ACP agent with minimal client capabilities and auto-allowed permissions", async () => {
		const streams = createPairedStreams();
		let initializeRequest: acp.InitializeRequest | undefined;
		let permissionAllowed = false;
		new acp.AgentSideConnection(
			(connection) => ({
				async initialize(params) {
					initializeRequest = params;
					return {
						protocolVersion: acp.PROTOCOL_VERSION,
						agentCapabilities: { loadSession: false },
					};
				},
				async newSession() {
					return { sessionId: "acp-session" };
				},
				async authenticate() {
					return {};
				},
				async prompt(params) {
					const response = await connection.requestPermission({
						sessionId: params.sessionId,
						toolCall: {
							toolCallId: "call-1",
							title: "Edit file",
							kind: "edit",
							status: "pending",
						},
						options: [
							{ optionId: "reject", name: "Reject", kind: "reject_once" },
							{ optionId: "allow", name: "Allow", kind: "allow_once" },
						],
					});
					permissionAllowed = response.outcome.outcome === "selected" && response.outcome.optionId === "allow";
					await connection.sessionUpdate({
						sessionId: params.sessionId,
						update: {
							sessionUpdate: "agent_message_chunk",
							content: { type: "text", text: "hello from acp" },
						},
					});
					return { stopReason: "end_turn" };
				},
				async cancel() {},
			}),
			streams.agent,
		);
		const updates: acp.SessionNotification[] = [];
		const runtime = new AcpClientRuntime({
			stream: streams.client,
			cwd: "/tmp/project",
			onSessionUpdate: (update) => {
				updates.push(update);
			},
		});

		await runtime.start();
		const result = await runtime.prompt("hello");

		expect(result.stopReason).toBe("end_turn");
		expect(permissionAllowed).toBe(true);
		expect(initializeRequest?.clientCapabilities).toMatchObject({
			fs: { readTextFile: false, writeTextFile: false },
			terminal: false,
		});
		expect(updates).toEqual([
			expect.objectContaining({
				sessionId: "acp-session",
				update: expect.objectContaining({
					sessionUpdate: "agent_message_chunk",
					content: { type: "text", text: "hello from acp" },
				}),
			}),
		]);
		await runtime.stop();
	});
});
