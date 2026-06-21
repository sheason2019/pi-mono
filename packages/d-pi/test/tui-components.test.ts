import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadExtensions } from "../../coding-agent/src/core/extensions/loader.ts";
import type { AgentTuiComponentRenderer } from "../src/agent-definition.ts";
import { defineAgent, defineSkill, defineTuiComponent } from "../src/index.ts";
import { ensureAgentTuiComponentsClientCapability } from "../src/tui-components/client-capability.ts";
import { installAgentTuiComponents } from "../src/tui-components/registry.ts";

describe("tui-components registry", () => {
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
			const capabilityPath = ensureAgentTuiComponentsClientCapability(agentDir);
			const source = readFileSync(capabilityPath, "utf-8");
			const shimPackagePath = join(agentDir, "node_modules", "@sheason", "d-pi", "package.json");
			const shimIndexPath = join(agentDir, "node_modules", "@sheason", "d-pi", "index.js");

			expect(capabilityPath).toBe(join(agentDir, ".d-pi-tui-components-capability.ts"));
			expect(source).toContain('import agentDefinition from "./agent.ts";');
			expect(source).toContain('import { installAgentTuiComponents } from "@sheason/d-pi";');
			expect(source).toContain('import "./node_modules/@sheason/d-pi/package.json";');
			expect(source).toContain('import "./node_modules/@sheason/d-pi/index.js";');
			expect(source).toContain("installAgentTuiComponents(agentDefinition");
			expect(source).toContain("pi.registerMessageRenderer(customType, render);");
			expect(existsSync(shimPackagePath)).toBe(true);
			expect(readFileSync(shimPackagePath, "utf-8")).toContain('"name": "@sheason/d-pi"');
			const shimSource = readFileSync(shimIndexPath, "utf-8");
			expect(shimSource).toContain("export function defineTool");
			expect(shimSource).toContain("export function installAgentTuiComponents");
			expect(shimSource).toContain("export const dPiMessageTuiComponent");
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

			const result = await loadExtensions([clientEntryPath], agentDir);

			expect(result.errors).toEqual([]);
			expect(result.extensions).toHaveLength(1);
			expect(result.extensions[0]?.messageRenderers.has("d-pi-message")).toBe(true);
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});
});
