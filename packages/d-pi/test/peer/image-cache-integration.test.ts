import { createHash } from "node:crypto";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { HubAgentAdapter } from "../../src/hub/agent/hub-agent-adapter.js";
import { PeerRegistry } from "../../src/hub/peers/peer-registry.js";
import type { HubSessionService } from "../../src/hub/session/hub-session-service.js";
import type { HubSessionEvent } from "../../src/hub/session/session-events.js";
import type { HubSessionSnapshot } from "../../src/hub/session/session-snapshot.js";
import { HUB_PROTOCOL_VERSION } from "../../src/hub/transport/protocol.js";
import { createMainOnlySocketHubServer } from "../../src/hub/transport/socket-hub-server.js";
import { SocketPeerClient } from "../../src/peer/client/socket-client.js";
import { PeerAppState } from "../../src/peer/state/peer-app-state.js";
import { PeerUiState } from "../../src/peer/state/peer-ui-state.js";

function createMinimalSnapshot(overrides: Partial<HubSessionSnapshot> = {}): HubSessionSnapshot {
	return {
		header: {
			type: "session",
			id: "hub-e2e-session",
			timestamp: new Date().toISOString(),
			cwd: "/tmp",
			version: 3,
		},
		sessionFile: "/tmp/session.json",
		entries: [],
		context: { messages: [], thinkingLevel: "off", model: null },
		availableModels: [],
		availableThinkingLevels: ["off"],
		isRunning: false,
		pendingToolCallIds: [],
		diagnostics: [],
		...overrides,
	};
}

type HubSessionServiceWithNotify = HubSessionService & { notify: (event: HubSessionEvent) => void };

function createNotifyableSessionService(
	snapshot: HubSessionSnapshot = createMinimalSnapshot(),
): HubSessionServiceWithNotify {
	const subscribers: ((event: HubSessionEvent) => void)[] = [];
	return {
		subscribe: (cb: (event: HubSessionEvent) => void) => {
			subscribers.push(cb);
			return () => {
				const i = subscribers.indexOf(cb);
				if (i >= 0) {
					subscribers.splice(i, 1);
				}
			};
		},
		getHeader: () => snapshot.header,
		getSnapshot: () => snapshot,
		recordError: () => {},
		notify: (event: HubSessionEvent) => {
			for (const s of subscribers) {
				s(event);
			}
		},
	} as unknown as HubSessionServiceWithNotify;
}

function imageIdForPngData(data: string): string {
	return createHash("sha256").update("image/png").update("\0").update(data).digest("hex");
}

function imageToolResult(data: string): AgentToolResult<unknown> {
	return {
		content: [
			{ type: "text", text: "Read image file [image/png]" },
			{ type: "image", data, mimeType: "image/png" },
		],
		details: undefined,
	};
}

function firstImageBlockInToolResult(message: { role: string; content?: unknown } | undefined) {
	if (message?.role !== "toolResult" || !Array.isArray(message.content)) {
		return undefined;
	}
	return message.content.find(
		(c: { type: string }): c is { type: "image"; data?: string; imageId?: string; mimeType?: string } =>
			c.type === "image",
	);
}

describe("image cache hub + peer integration", () => {
	it("fetches one REST image resource for duplicate refs; second sync does not refetch bytes", async () => {
		const imageData = Buffer.from("e2e image bytes").toString("base64");
		const expectedId = imageIdForPngData(imageData);
		const toolResultMessage = {
			role: "toolResult" as const,
			toolCallId: "read:e2e",
			toolName: "read",
			content: imageToolResult(imageData).content,
			isError: false,
			timestamp: Date.now(),
		};
		const snapshot = createMinimalSnapshot({
			entries: [
				{
					type: "message",
					id: "entry-same-image",
					parentId: null,
					timestamp: new Date().toISOString(),
					message: toolResultMessage,
				},
			],
			context: { messages: [toolResultMessage], thinkingLevel: "off", model: null },
		});

		const session = createNotifyableSessionService(snapshot);
		const server = createMainOnlySocketHubServer(
			session,
			new PeerRegistry(),
			() => [],
			() => ({}) as HubAgentAdapter,
		);
		const address = await server.start({ host: "127.0.0.1", port: 0 });

		const appState = new PeerAppState();
		const applyPayload = vi.spyOn(appState, "applyImagePayload");
		const uiState = new PeerUiState();
		const client = new SocketPeerClient({
			hubUrl: `http://127.0.0.1:${address.port}`,
			hello: {
				peerId: "e2e-image-cache",
				token: "test-token",
				protocolVersion: HUB_PROTOCOL_VERSION,
				version: "test",
			},
			appState,
			uiState,
		});

		try {
			await client.connect();
			await client.uploadConfig({ tools: [] });

			await vi.waitFor(() => {
				expect(appState.getSnapshot().selectedAgent).toBeDefined();
			});
			const selectedAgent = appState.getSnapshot().selectedAgent;
			expect(selectedAgent).toBeDefined();
			if (!selectedAgent) {
				throw new Error("expected selected agent");
			}

			await vi.waitFor(() => {
				expect(applyPayload).toHaveBeenCalledTimes(1);
			});
			const hydratedAgent = appState.getImageCache().hydrate(selectedAgent) as typeof selectedAgent;
			const contextItem = hydratedAgent.items.find((item) => item.type === "message");
			const contextMessage = contextItem?.type === "message" ? contextItem.message : undefined;
			const contextImg = firstImageBlockInToolResult(contextMessage);

			expect(applyPayload).toHaveBeenCalledWith(
				expect.objectContaining({
					imageId: expectedId,
					mimeType: "image/png",
					data: imageData,
				}),
			);

			expect(contextImg).toMatchObject({
				type: "image",
				imageId: expectedId,
				mimeType: "image/png",
				data: imageData,
			});
			expect(contextImg?.data?.length).toBeGreaterThan(0);

			const event: HubSessionEvent = {
				type: "snapshot_updated",
				seq: 1,
				timestamp: new Date().toISOString(),
			};
			session.notify(event);
			await vi.waitFor(
				() => {
					expect(applyPayload).toHaveBeenCalledTimes(1);
				},
				{ timeout: 3_000 },
			);
			const after = appState.getSnapshot().selectedAgent;
			expect(after?.items).toEqual(selectedAgent.items);
		} finally {
			await client.disconnect();
			await server.stop();
		}
	});
});
