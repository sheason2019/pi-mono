import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Socket as ClientSocket, io as ioClient } from "socket.io-client";
import { afterEach, describe, expect, it } from "vitest";
import type { HubAgentAdapter } from "../../src/hub/agent/hub-agent-adapter.js";
import { PeerRegistry } from "../../src/hub/peers/peer-registry.js";
import type { HubSessionService } from "../../src/hub/session/hub-session-service.js";
import type { HubSessionSnapshot } from "../../src/hub/session/session-snapshot.js";
import { HUB_PROTOCOL_VERSION, type PeerHelloAck } from "../../src/hub/transport/protocol.js";
import { createMainOnlySocketHubServer } from "../../src/hub/transport/socket-hub-server.js";

function createMinimalSnapshot(): HubSessionSnapshot {
	return {
		header: {
			type: "session",
			id: "hub-web-ui-test-session",
			timestamp: new Date().toISOString(),
			cwd: "/tmp",
			version: 3,
		},
		sessionFile: "/tmp/session.jsonl",
		entries: [],
		context: { messages: [], thinkingLevel: "off", model: null },
		availableModels: [],
		availableThinkingLevels: ["off"],
		isRunning: false,
		pendingToolCallIds: [],
		diagnostics: [],
	};
}

function createStubSessionService(): HubSessionService {
	const snapshot = createMinimalSnapshot();
	return {
		subscribe: () => () => {},
		getHeader: () => snapshot.header,
		getSnapshot: () => snapshot,
		recordError: () => {},
	} as unknown as HubSessionService;
}

const tempDirs: string[] = [];

function createWebUiDistFixture(): string {
	const dir = mkdtempSync(join(tmpdir(), "d-pi-web-ui-dist-"));
	tempDirs.push(dir);
	mkdirSync(join(dir, "assets"), { recursive: true });
	writeFileSync(
		join(dir, "index.html"),
		`<!doctype html><html><body><d-pi-web-app id="d-pi-web-ui"></d-pi-web-app><script type="module" src="/assets/app.js"></script></body></html>`,
		"utf8",
	);
	writeFileSync(join(dir, "assets", "app.js"), "customElements.get('d-pi-web-app');\n", "utf8");
	return dir;
}

async function connectClient(baseUrl: string): Promise<ClientSocket> {
	const client: ClientSocket = ioClient(baseUrl, {
		transports: ["websocket"],
		autoConnect: true,
	});
	await new Promise<void>((resolve, reject) => {
		client.on("connect", () => resolve());
		client.on("connect_error", (err) => reject(err));
	});
	return client;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("SocketHubServer Web UI static assets", () => {
	it("serves the D-Pi Web UI at root without breaking Socket.IO", async () => {
		const server = createMainOnlySocketHubServer(
			createStubSessionService(),
			new PeerRegistry(),
			() => [],
			() => ({ subscribeLiveEvents: () => () => {}, dispose: () => {} }) as unknown as HubAgentAdapter,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			createWebUiDistFixture(),
		);
		const address = await server.start({ host: "127.0.0.1", port: 0 });
		const baseUrl = `http://127.0.0.1:${address.port}`;
		let client: ClientSocket | undefined;
		try {
			const response = await fetch(`${baseUrl}/`);
			const text = await response.text();
			expect(response.status).toBe(200);
			expect(response.headers.get("content-type")).toContain("text/html");
			expect(text).toContain("d-pi-web-ui");
			expect(text).toContain("/assets/");

			const childResponse = await fetch(`${baseUrl}/agents/child-a`);
			const childText = await childResponse.text();
			expect(childResponse.status).toBe(200);
			expect(childResponse.headers.get("content-type")).toContain("text/html");
			expect(childText).toContain("d-pi-web-ui");

			const missingAsset = await fetch(`${baseUrl}/assets/missing.js`);
			expect(missingAsset.status).toBe(404);

			client = await connectClient(baseUrl);
			await new Promise<void>((resolve, reject) => {
				client?.emit(
					"peer:hello",
					{ peerId: "web-ui-static-test", token: "test-token", protocolVersion: HUB_PROTOCOL_VERSION },
					(ack: PeerHelloAck) => {
						if (ack.ok) {
							resolve();
							return;
						}
						reject(new Error(ack.error));
					},
				);
			});
		} finally {
			client?.disconnect();
			await server.stop();
		}
	});
});
