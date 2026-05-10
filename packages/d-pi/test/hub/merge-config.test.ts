import { describe, expect, it } from "vitest";
import { mergeConfigLayers } from "../../src/hub/config-aggregation/merge-config.js";
import type { PeerConfigJsonLayers } from "../../src/hub/config-aggregation/types.js";

describe("mergeConfigLayers", () => {
	it("merges hub, child, and peer layers with later layers winning", () => {
		const hubGlobal: PeerConfigJsonLayers = {
			auth: { demo: { type: "api_key", key: "hub-global" } },
			models: { providers: { demo: { baseUrl: "hub", models: [{ id: "a" }] } } },
			settings: { defaultProvider: "hub", terminal: { showImages: false } },
			mcp: { servers: [{ name: "hub-global", transport: "stdio", command: "node" }] },
		};
		const hubWorkspace: PeerConfigJsonLayers = {
			models: { providers: { demo: { models: [{ id: "b" }] }, workspaceOnly: {} } },
			settings: { terminal: { imageWidthCells: 20 } },
			mcp: { servers: [{ name: "hub-workspace", transport: "stdio", command: "node" }] },
		};
		const childLocal: PeerConfigJsonLayers = {
			settings: { defaultProvider: "child" },
		};
		const peerGlobal: PeerConfigJsonLayers = {
			auth: { demo: { type: "api_key", key: "peer-global" } },
			settings: { defaultModel: "peer-global" },
		};
		const peerCwd: PeerConfigJsonLayers = {
			models: { providers: { demo: { baseUrl: "peer", models: [{ id: "c" }] } } },
			settings: { defaultModel: "peer-cwd" },
			mcp: { servers: [{ name: "peer-cwd", transport: "stdio", command: "node" }] },
		};

		const merged = mergeConfigLayers([hubGlobal, hubWorkspace, childLocal, peerGlobal, peerCwd]);

		expect(merged.auth.demo).toEqual({ type: "api_key", key: "peer-global" });
		expect(merged.models).toMatchObject({
			providers: {
				demo: { baseUrl: "peer", models: [{ id: "a" }, { id: "b" }, { id: "c" }] },
				workspaceOnly: {},
			},
		});
		expect(merged.settings).toMatchObject({
			defaultProvider: "child",
			defaultModel: "peer-cwd",
			terminal: { showImages: false, imageWidthCells: 20 },
		});
		expect((merged.mcp as { servers: Array<{ name: string }> }).servers.map((s) => s.name)).toEqual([
			"hub-global",
			"hub-workspace",
			"peer-cwd",
		]);
	});

	it("merges same-provider model arrays by model id instead of replacing the provider models", () => {
		const hubGlobal: PeerConfigJsonLayers = {
			models: {
				providers: {
					"ark-openai-compatible": {
						api: "openai-responses",
						baseUrl: "https://ark-global.invalid",
						models: [{ id: "kimi-k2.6", name: "Kimi K2.6" }],
					},
				},
			},
		};
		const hubWorkspace: PeerConfigJsonLayers = {
			models: {
				providers: {
					"ark-openai-compatible": {
						baseUrl: "https://ark-workspace.invalid",
						models: [{ id: "minimax-m2.7", name: "MiniMax M2.7" }],
					},
				},
			},
		};

		const merged = mergeConfigLayers([hubGlobal, hubWorkspace]);
		const provider = (
			merged.models as {
				providers: Record<string, { baseUrl?: string; models?: Array<{ id: string; name?: string }> }>;
			}
		).providers["ark-openai-compatible"];

		expect(provider.baseUrl).toBe("https://ark-workspace.invalid");
		expect(provider.models?.map((model) => model.id)).toEqual(["kimi-k2.6", "minimax-m2.7"]);
	});

	it("keeps sourced model names unprefixed and excludes peer MCP from hub-local config", () => {
		const hub: PeerConfigJsonLayers = {
			source: { kind: "hub", scope: "global" },
			auth: { demo: { type: "api_key", key: "hub" } },
			models: { providers: { demo: { api: "openai-responses", baseUrl: "hub", models: [{ id: "h" }] } } },
			settings: { defaultProvider: "demo", defaultModel: "h" },
			mcp: { servers: [{ name: "fs", transport: "stdio", command: "node" }] },
		};
		const peer: PeerConfigJsonLayers = {
			source: { kind: "peer", peerId: "work laptop", scope: "global" },
			auth: { demo: { type: "api_key", key: "peer" } },
			models: { providers: { demo: { api: "openai-responses", baseUrl: "peer", models: [{ id: "p" }] } } },
			settings: { defaultProvider: "demo", defaultModel: "p" },
			mcp: { servers: [{ name: "peerfs", transport: "stdio", command: "node" }] },
		};

		const merged = mergeConfigLayers([hub, peer]);
		const models = merged.models as { providers: Record<string, unknown> };
		const mcp = merged.mcp as { servers: Array<{ name: string }> };

		expect(Object.keys(models.providers).sort()).toEqual(["demo"]);
		expect(models.providers.demo).toMatchObject({ baseUrl: "peer", models: [{ id: "h" }, { id: "p" }] });
		expect(merged.auth.demo).toEqual({ type: "api_key", key: "peer" });
		expect(merged.settings).toMatchObject({ defaultProvider: "demo", defaultModel: "p" });
		expect(mcp.servers.map((server) => server.name)).toEqual(["fs"]);
	});
});
