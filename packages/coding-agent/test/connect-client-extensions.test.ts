import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionProxy, SessionStateSnapshot } from "../src/core/agent-session-proxy.ts";
import { loadRemoteClientExtensions } from "../src/modes/connect/client-extension-sync.ts";
import { runConnectMode } from "../src/modes/connect/connect-mode.ts";
import { handleApiRequest } from "../src/modes/serve/api-handlers.ts";

const interactiveModeOptions: unknown[] = [];

vi.mock("../src/modes/interactive/interactive-mode.ts", () => ({
	InteractiveMode: class {
		constructor(_runtime: unknown, options: unknown) {
			interactiveModeOptions.push(options);
		}

		setProxy(): void {}

		showStatus(): void {}

		async shutdown(): Promise<void> {}

		async run(): Promise<void> {}
	},
}));

vi.mock("../src/modes/connect/remote-agent-session-proxy.ts", () => ({
	RemoteAgentSessionProxy: class {
		async connect(): Promise<void> {}
	},
}));

const baseSnapshot: SessionStateSnapshot = {
	model: "test/model",
	thinkingLevel: "off",
	isStreaming: false,
	isCompacting: false,
	isBashRunning: false,
	steeringMessages: [],
	followUpMessages: [],
	sessionFile: undefined,
	sessionName: undefined,
	messages: [],
	banner: undefined,
	tokenUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, usingSubscription: false },
	contextUsage: { tokens: 0, contextWindow: 1, percent: 0 },
	modelInfo: { id: "test/model", provider: "test", reasoning: false, contextWindow: 1 },
	autoCompactEnabled: false,
	cwd: "/tmp",
	availableProviderCount: 1,
	remoteSettings: {
		autoCompact: false,
		thinkingLevel: "off",
		availableThinkingLevels: ["off"],
		steeringMode: "all",
		followUpMode: "all",
		enableSkillCommands: false,
		doubleEscapeAction: "none",
		showImages: false,
		imageWidthCells: 80,
		autoResizeImages: false,
		blockImages: false,
		transport: "http",
		httpIdleTimeoutMs: 0,
		currentTheme: "dark",
		availableThemes: [],
		hideThinkingBlock: false,
		collapseChangelog: false,
		enableInstallTelemetry: false,
		treeFilterMode: "all",
		showHardwareCursor: false,
		editorPaddingX: 0,
		autocompleteMaxVisible: 8,
		quietStartup: false,
		clearOnShrink: true,
		showTerminalProgress: false,
		warnings: {},
	},
	scopedModelIds: null,
	enabledModelPatterns: undefined,
	extensionPaths: [],
};

let tempDir: string | undefined;

function makeProxy(snapshot: SessionStateSnapshot): AgentSessionProxy {
	return {
		subscribe: () => () => {},
		getSnapshot: () => snapshot,
	} as unknown as AgentSessionProxy;
}

async function serveOnce(proxy: AgentSessionProxy): Promise<{ url: string; close: () => Promise<void> }> {
	const server = createServer((req, res) => {
		void handleApiRequest(proxy, req, res);
	});
	await new Promise<void>((resolve, reject) => {
		server.listen(0, resolve);
		server.on("error", reject);
	});
	const address = server.address();
	if (!address || typeof address === "string") {
		throw new Error("Expected TCP server address");
	}
	return {
		url: `http://127.0.0.1:${address.port}`,
		close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
	};
}

describe("connect client extensions", () => {
	afterEach(() => {
		interactiveModeOptions.length = 0;
		vi.unstubAllGlobals();
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = undefined;
		}
	});

	it("connect mode does not accept local client extension factories", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string | URL | Request) => {
				expect(String(url)).toBe("http://remote/state");
				return new Response(JSON.stringify(baseSnapshot), { status: 200 });
			}),
		);

		const options = {
			url: "http://remote",
			clientExtensionFactories: [
				() => {
					throw new Error("local client extension should not be wired");
				},
			],
		};

		await runConnectMode(options);

		expect(interactiveModeOptions).toEqual([{ banner: undefined, remoteClientExtensionsUrl: "http://remote" }]);
	});

	it("serve mode exposes only extension bundles with a client export", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-client-ext-"));
		const clientPath = join(tempDir, "remote-client.ts");
		const helperPath = join(tempDir, "helper.ts");
		const serverOnlyPath = join(tempDir, "server-only.ts");
		writeFileSync(helperPath, `export const marker = "remote-client";\n`);
		writeFileSync(
			clientPath,
			`import { marker } from "./helper.ts";
export default function server() {}
export function client(pi) { pi.registerCommand(marker, { handler: async () => {} }); }
`,
		);
		writeFileSync(serverOnlyPath, `export default function serverOnly() {}`);
		const server = await serveOnce(makeProxy({ ...baseSnapshot, extensionPaths: [clientPath, serverOnlyPath] }));

		try {
			const response = await fetch(`${server.url}/client-extensions`);
			const payload = (await response.json()) as Array<{
				path: string;
				entry: string;
				files: Array<{ path: string; content: string }>;
			}>;

			expect(response.status).toBe(200);
			expect(payload).toEqual([
				{
					path: clientPath,
					entry: "remote-client.ts",
					files: expect.arrayContaining([
						{ path: "remote-client.ts", content: expect.stringContaining("export function client") },
						{ path: "helper.ts", content: expect.stringContaining("remote-client") },
					]),
				},
			]);
		} finally {
			await server.close();
		}
	});

	it("serve mode ignores synthetic inline extension paths", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-client-ext-"));
		const clientPath = join(tempDir, "remote-client.ts");
		writeFileSync(
			clientPath,
			`export default function server() {}
export function client(pi) { pi.registerCommand("remote-client", { handler: async () => {} }); }
`,
		);
		const server = await serveOnce(
			makeProxy({ ...baseSnapshot, extensionPaths: ["<d-pi-built-in-std-extension>", clientPath] }),
		);

		try {
			const response = await fetch(`${server.url}/client-extensions`);
			const payload = (await response.json()) as Array<{ path: string }>;

			expect(response.status).toBe(200);
			expect(payload.map((bundle) => bundle.path)).toEqual([clientPath]);
		} finally {
			await server.close();
		}
	});

	it("connect mode loads only server-provided client exports", async () => {
		const executed: string[] = [];
		vi.stubGlobal("__remoteClientExtensionLoaded", (name: string) => executed.push(name));
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string | URL | Request) => {
				expect(String(url)).toBe("http://remote/client-extensions");
				return new Response(
					JSON.stringify([
						{
							path: "/server/remote-extension.ts",
							entry: "remote-extension.ts",
							files: [
								{ path: "helper.ts", content: `export const marker = "client";\n` },
								{
									path: "remote-extension.ts",
									content: `import { marker } from "./helper.ts";
export default function server() { globalThis.__remoteClientExtensionLoaded("server"); }
export function client() { globalThis.__remoteClientExtensionLoaded(marker); }
`,
								},
							],
						},
					]),
					{ status: 200 },
				);
			}),
		);

		const result = await loadRemoteClientExtensions("http://remote", "/tmp/client-cwd");

		expect(result.errors).toEqual([]);
		expect(result.extensions.map((extension) => extension.path)).toEqual([
			"<remote-client:/server/remote-extension.ts>",
		]);
		expect(executed).toEqual(["client"]);
	});
});
