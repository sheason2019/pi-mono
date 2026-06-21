import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionProxy } from "../../coding-agent/src/core/agent-session-proxy.ts";
import { loadExtensions } from "../../coding-agent/src/core/extensions/loader.ts";
import { loadRemoteClientExtensions } from "../../coding-agent/src/modes/connect/client-extension-sync.ts";
import { handleProtocolQuery } from "../../coding-agent/src/modes/serve/protocol-core.ts";
import type { AgentTuiComponentRenderer } from "../src/agent-definition.ts";
import { getDPiPackageEntryPath } from "../src/extension-module-alias.ts";
import { defineAgent, defineSkill, defineTuiComponent } from "../src/index.ts";
import { ensureAgentTuiComponentsClientCapability } from "../src/tui-components/client-capability.ts";
import { installAgentTuiComponents } from "../src/tui-components/registry.ts";

describe("tui-components registry", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("installs explicitly declared agent tui components", () => {
		const render = () => undefined;
		const agent = defineAgent({
			skills: defineSkill({ dir: "./skills" }),
			tools: [],
			tuiComponents: [defineTuiComponent({ customType: "d-pi-message", render })],
			contextFiles: [],
		});
		const registered: Array<{ customType: string; render: AgentTuiComponentRenderer }> = [];

		installAgentTuiComponents(agent, {
			registerTuiComponentRenderer(customType, nextRender) {
				registered.push({ customType, render: nextRender });
			},
		});

		expect(registered).toEqual([{ customType: "d-pi-message", render }]);
	});

	it("does not install anything for agents without tui components", () => {
		const agent = defineAgent({
			skills: defineSkill({ dir: "./skills" }),
			tools: [],
			contextFiles: [],
		});
		const registered: string[] = [];

		installAgentTuiComponents(agent, {
			registerTuiComponentRenderer(customType) {
				registered.push(customType);
			},
		});

		expect(registered).toEqual([]);
	});

	it("writes an internal client capability module next to agent.ts", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "d-pi-tui-components-"));
		try {
			writeFileSync(
				join(agentDir, "agent.ts"),
				`import { defineAgent, defineSkill } from "@sheason/d-pi";

export default defineAgent({
\tskills: defineSkill({ dir: "./skills" }),
\ttools: [],
\tcontextFiles: [],
});
`,
			);
			const capabilityPath = ensureAgentTuiComponentsClientCapability(agentDir);
			const source = readFileSync(capabilityPath, "utf-8");

			expect(capabilityPath).toBe(join(agentDir, ".d-pi-tui-components-capability.ts"));
			expect(source).toContain('/* @pi-client-loadable-files: ["agent.ts"] */');
			expect(source).toContain('import agentDefinition from "./agent.ts";');
			expect(source).toContain('import { installAgentTuiComponents } from "@sheason/d-pi";');
			expect(source).toContain("installAgentTuiComponents(agentDefinition");
			expect(source).toContain("pi.registerMessageRenderer(customType, render);");
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("loads generated tui component capability through the client extension entry", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "d-pi-tui-components-client-"));
		try {
			writeFileSync(
				join(agentDir, "agent.ts"),
				`import { dPiMessageTuiComponent, defineAgent, defineSkill, defineTuiComponent } from "@sheason/d-pi";

export default defineAgent({
\tskills: defineSkill({ dir: "./skills" }),
\ttools: [],
\ttuiComponents: [
\t\tdefineTuiComponent(dPiMessageTuiComponent),
\t],
\tcontextFiles: [],
});
`,
			);
			const capabilityPath = ensureAgentTuiComponentsClientCapability(agentDir);
			const clientEntryPath = join(agentDir, ".pi-client-entry.mjs");
			writeFileSync(
				clientEntryPath,
				`import { client } from "./${capabilityPath.split("/").pop()}";
export default client;
`,
			);
			const previousAliases = process.env.PI_EXTENSION_MODULE_ALIASES;
			process.env.PI_EXTENSION_MODULE_ALIASES = JSON.stringify({
				"@sheason/d-pi": getDPiPackageEntryPath(),
			});

			try {
				const result = await loadExtensions([clientEntryPath], agentDir);

				expect(result.errors).toEqual([]);
				expect(result.extensions).toHaveLength(1);
				expect(result.extensions[0]?.messageRenderers.has("d-pi-message")).toBe(true);
			} finally {
				if (previousAliases === undefined) {
					delete process.env.PI_EXTENSION_MODULE_ALIASES;
				} else {
					process.env.PI_EXTENSION_MODULE_ALIASES = previousAliases;
				}
			}
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("declares parent agent definitions as explicit client loadable files", () => {
		const workspace = mkdtempSync(join(tmpdir(), "d-pi-tui-components-workspace-"));
		try {
			const rootDir = join(workspace, "agents", "root");
			const childDir = join(workspace, "agents", "child");
			mkdirSync(rootDir, { recursive: true });
			mkdirSync(childDir, { recursive: true });
			writeFileSync(
				join(rootDir, "agent.ts"),
				`import { defineAgent, defineSkill } from "@sheason/d-pi";

export default defineAgent({
\tskills: defineSkill({ dir: "./skills" }),
\ttools: [],
\tcontextFiles: [],
});
`,
			);
			writeFileSync(
				join(childDir, "agent.ts"),
				`import { defineAgent, defineSkill } from "@sheason/d-pi";
import parentAgent from "../root/agent.ts";

export default defineAgent({
\tparent: parentAgent,
\tskills: defineSkill({ dir: "./skills" }),
\ttools: [],
\tcontextFiles: [],
});
`,
			);

			const capabilityPath = ensureAgentTuiComponentsClientCapability(childDir, { workspaceRoot: workspace });
			const source = readFileSync(capabilityPath, "utf-8");

			expect(source).toContain('/* @pi-client-loadable-files: ["agent.ts","../root/agent.ts"] */');
		} finally {
			rmSync(workspace, { recursive: true, force: true });
		}
	});

	it("loads d-pi message renderer through remote runtime loadables without local remote cwd", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "d-pi-tui-components-remote-"));
		try {
			writeFileSync(
				join(agentDir, "agent.ts"),
				`import { dPiMessageTuiComponent, defineAgent, defineSkill, defineTuiComponent } from "@sheason/d-pi";

export default defineAgent({
\tskills: defineSkill({ dir: "./skills" }),
\ttools: [],
\ttuiComponents: [
\t\tdefineTuiComponent(dPiMessageTuiComponent),
\t],
\tcontextFiles: [],
});
`,
			);
			const capabilityPath = ensureAgentTuiComponentsClientCapability(agentDir);
			const proxy = {
				getSnapshot: () => ({
					extensionPaths: [capabilityPath],
				}),
			} as unknown as AgentSessionProxy;
			const payload = (await handleProtocolQuery(proxy, "client-extensions")).body;
			vi.stubGlobal(
				"fetch",
				vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 })),
			);
			const previousAliases = process.env.PI_EXTENSION_MODULE_ALIASES;
			process.env.PI_EXTENSION_MODULE_ALIASES = JSON.stringify({
				"@sheason/d-pi": getDPiPackageEntryPath(),
			});

			try {
				const result = await loadRemoteClientExtensions("http://remote-agent", "/remote/cwd/does/not/exist");

				expect(result.errors).toEqual([]);
				expect(result.extensions).toHaveLength(1);
				expect(result.extensions[0]?.messageRenderers.has("d-pi-message")).toBe(true);
			} finally {
				if (previousAliases === undefined) {
					delete process.env.PI_EXTENSION_MODULE_ALIASES;
				} else {
					process.env.PI_EXTENSION_MODULE_ALIASES = previousAliases;
				}
			}
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});
});
