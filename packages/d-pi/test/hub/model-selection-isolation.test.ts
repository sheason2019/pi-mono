import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HubRuntime } from "../../src/hub/runtime/hub-runtime.js";
import { HUB_PROTOCOL_VERSION } from "../../src/hub/transport/protocol.js";
import { initializeWorkspace } from "../../src/hub/workspace.js";
import { SocketPeerClient } from "../../src/peer/client/socket-client.js";
import { PeerAppState } from "../../src/peer/state/peer-app-state.js";
import { PeerUiState } from "../../src/peer/state/peer-ui-state.js";

const tempDirs: string[] = [];

function writeJson(path: string, value: unknown): void {
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function modelsConfig(provider: string, modelIds: string[]): unknown {
	return {
		providers: {
			[provider]: {
				baseUrl: `https://${provider}.example/v1`,
				apiKey: `${provider}-key`,
				api: "openai-responses",
				models: modelIds.map((id) => ({
					id,
					name: id,
					api: "openai-responses",
					input: ["text"],
					resourceId: `${provider}:${id}`,
				})),
			},
		},
	};
}

async function waitFor(condition: () => boolean): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (Date.now() < deadline) {
		if (condition()) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	expect(condition()).toBe(true);
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("hub agent model selection isolation", () => {
	it("keeps a selected hub model when peer config removal restarts an agent with no messages", async () => {
		const workspaceDir = mkdtempSync(join(tmpdir(), "pi-hub-model-peer-offline-"));
		tempDirs.push(workspaceDir);
		initializeWorkspace(workspaceDir);
		mkdirSync(join(workspaceDir, ".pi"), { recursive: true });
		writeJson(join(workspaceDir, ".pi", "models.json"), modelsConfig("hub-provider", ["hub-a", "hub-b"]));
		const hub = HubRuntime.open(workspaceDir);
		await hub.initializeAgentAdapter({});
		const adapter = hub.getRootAgentRuntime().agentAdapter;
		expect(adapter).toBeDefined();
		const address = await hub.start({ host: "127.0.0.1", port: 0 });
		const client = new SocketPeerClient({
			hubUrl: `http://127.0.0.1:${address.port}`,
			hello: {
				peerId: "model-config-peer",
				token: hub.rootTokenForDisplay ?? "",
				protocolVersion: HUB_PROTOCOL_VERSION,
				version: "test",
			},
			appState: new PeerAppState(),
			uiState: new PeerUiState(),
		});
		await client.connect();
		await client.uploadConfig({
			tools: [],
			configSnapshot: {
				version: 1,
				capturedAt: new Date(0).toISOString(),
				cwd: workspaceDir,
				cwdLayer: {
					models: modelsConfig("peer-provider", ["peer-default"]),
					settings: { defaultProvider: "peer-provider", defaultModel: "peer-default" },
				},
			},
		});

		await waitFor(() =>
			(hub.getRootAgentRuntime().agentAdapter?.services.modelRegistry.getAll() ?? []).some(
				(model) => model.provider === "peer-provider" && model.id === "peer-default",
			),
		);
		const hubModel = (hub.getRootAgentRuntime().agentAdapter?.services.modelRegistry.getAll() ?? []).find(
			(model) => model.provider === "hub-provider" && model.id === "hub-b",
		);
		expect(hubModel).toBeDefined();
		await hub.getRootAgentRuntime().agentAdapter?.setModel(hubModel!);
		expect(hub.sessionService.getSnapshot().context.model).toEqual({
			provider: "hub-provider",
			modelId: "hub-b",
		});

		await client.disconnect();
		await waitFor(
			() =>
				!(hub.getRootAgentRuntime().agentAdapter?.services.modelRegistry.getAll() ?? []).some(
					(model) => model.provider === "peer-provider" && model.id === "peer-default",
				),
		);

		expect(hub.sessionService.getSnapshot().context.model).toEqual({
			provider: "hub-provider",
			modelId: "hub-b",
		});
		await hub.stop();
	});
});
