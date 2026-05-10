import { describe, expect, it } from "vitest";
import type { PeerConfigSnapshot } from "../../src/hub/config-aggregation/types.js";
import { sanitizePeerConfigSnapshotForLog } from "../../src/hub/config-aggregation/types.js";
import { PeerRegistry } from "../../src/hub/peers/peer-registry.js";
import type { PeerConfigPayload, PeerHelloPayload, RegisteredPeer } from "../../src/hub/peers/peer-types.js";

describe("peer config snapshot protocol boundary", () => {
	it("allows peer config to carry auth config but never exposes it through RegisteredPeer", () => {
		const snapshot: PeerConfigSnapshot = {
			version: 1,
			capturedAt: "2026-04-26T04:00:00.000Z",
			cwd: "/peer/work",
			global: {
				auth: {
					"demo-provider": { type: "api_key", key: "secret" },
				},
			},
		};
		const hello: PeerHelloPayload = {
			peerId: "peer-a",
			token: "test-token",
			protocolVersion: 2,
		};
		const config: PeerConfigPayload = { configSnapshot: snapshot };
		const registry = new PeerRegistry();

		registry.register("socket-a", hello, "root");
		const { peer } = registry.updateConfigBySocketId("socket-a", config);

		expect(config.configSnapshot?.global?.auth?.["demo-provider"]?.type).toBe("api_key");
		expect((peer as RegisteredPeer & { configSnapshot?: unknown }).configSnapshot).toBeUndefined();
		expect(JSON.stringify(peer)).not.toContain("secret");
		expect(JSON.stringify(sanitizePeerConfigSnapshotForLog(snapshot))).not.toContain("secret");
	});
});
