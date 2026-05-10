import { describe, expect, it } from "vitest";
import { ConfigLayerRegistry } from "../../src/hub/config-aggregation/config-layer-registry.js";
import type { PeerConfigSnapshot } from "../../src/hub/config-aggregation/types.js";

function snapshot(provider: string): PeerConfigSnapshot {
	return {
		version: 1,
		capturedAt: "2026-04-26T04:00:00.000Z",
		cwd: `/peer/${provider}`,
		global: { settings: { defaultProvider: provider } },
	};
}

describe("ConfigLayerRegistry", () => {
	it("keeps per-agent peer snapshots and uses the first connected peer as primary", () => {
		const registry = new ConfigLayerRegistry();

		registry.setPeerSnapshot("main", "peer-b", snapshot("b"));
		registry.setPeerSnapshot("main", "peer-a", snapshot("a"));
		registry.setPeerSnapshot("child", "peer-c", snapshot("c"));

		expect(registry.getPrimaryPeerSnapshot("main")?.global?.settings).toEqual({ defaultProvider: "b" });
		expect(registry.listPeerIds("main")).toEqual(["peer-b", "peer-a"]);
		expect(registry.getPrimaryPeerSnapshot("child")?.global?.settings).toEqual({ defaultProvider: "c" });

		registry.removePeerSnapshot("main", "peer-b");
		expect(registry.getPrimaryPeerSnapshot("main")?.global?.settings).toEqual({ defaultProvider: "a" });
	});
});
