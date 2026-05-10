import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAggregatedAgentSessionServices } from "../../src/hub/config-aggregation/agent-config-services.js";
import type { PeerConfigJsonLayers } from "../../src/hub/config-aggregation/types.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("createAggregatedAgentSessionServices", () => {
	it("uses merged auth/settings/models in memory without writing auth to disk", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "agent-config-services-cwd-"));
		const agentDir = mkdtempSync(join(tmpdir(), "agent-config-services-agent-"));
		tempDirs.push(cwd, agentDir);
		mkdirSync(join(cwd, ".pi-hub"), { recursive: true });
		const layers: PeerConfigJsonLayers[] = [
			{
				auth: { demo: { type: "api_key", key: "hub" } },
				settings: { defaultProvider: "hub" },
				models: {
					providers: {
						demo: {
							api: "openai-responses",
							baseUrl: "https://hub.invalid",
							apiKey: "hub",
							models: [{ id: "hub-model" }],
						},
					},
				},
			},
			{
				auth: { demo: { type: "api_key", key: "peer" } },
				settings: { defaultProvider: "peer" },
				models: {
					providers: {
						demo: {
							api: "openai-responses",
							baseUrl: "https://peer.invalid",
							apiKey: "peer",
							models: [{ id: "peer-model" }],
						},
					},
				},
				contextFiles: [{ path: "/peer/AGENTS.md", content: "peer context" }],
			},
		];

		const { services, mergedModelsFile } = await createAggregatedAgentSessionServices({ cwd, agentDir, layers });

		expect(services.authStorage.get("demo")).toEqual({ type: "api_key", key: "peer" });
		expect(services.settingsManager.getDefaultProvider()).toBe("peer");
		expect(services.resourceLoader.getAgentsFiles().agentsFiles).toEqual(
			expect.arrayContaining([expect.objectContaining({ path: "/peer/AGENTS.md", content: "peer context" })]),
		);
		expect(services.modelRegistry.getAvailable().some((model) => model.id === "peer-model")).toBe(true);
		expect(mergedModelsFile).toContain(".pi-hub");
		expect(existsSync(join(agentDir, "auth.json"))).toBe(false);
	});

	it("materializes duplicate peer skill names without dropping versions", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "agent-config-skills-cwd-"));
		const agentDir = mkdtempSync(join(tmpdir(), "agent-config-skills-agent-"));
		tempDirs.push(cwd, agentDir);
		mkdirSync(join(cwd, ".pi-hub"), { recursive: true });

		const { services } = await createAggregatedAgentSessionServices({
			cwd,
			agentDir,
			layers: [
				{
					source: { kind: "peer", peerId: "work laptop", scope: "global" },
					skills: [
						{
							name: "summarize",
							description: "Summarize content",
							filePath: "/peer/skills/summarize/SKILL.md",
							content: "---\nname: summarize\ndescription: Summarize content\n---\n\nSummarize content.",
						},
					],
				},
				{
					source: { kind: "peer", peerId: "other laptop", scope: "global" },
					skills: [
						{
							name: "summarize",
							description: "Summarize from other peer",
							filePath: "/other/skills/summarize/SKILL.md",
							content: "---\nname: summarize\ndescription: Summarize from other peer\n---\n\nSummarize content.",
						},
					],
				},
			],
		});

		const result = services.resourceLoader.getSkills();
		const skills = result.skills.filter((skill) => skill.name === "summarize");
		expect(skills).toHaveLength(2);
		expect(skills.map((skill) => skill.description)).toEqual(["Summarize content", "Summarize from other peer"]);
		expect(skills.map((skill) => skill.name)).toEqual(["summarize", "summarize"]);
		expect(skills.map((skill) => skill.name).join(" ")).not.toMatch(/(?:hub|peer)_/);
		expect(
			result.diagnostics.filter(
				(diagnostic) => diagnostic.type === "collision" && JSON.stringify(diagnostic).includes("summarize"),
			),
		).toHaveLength(0);
	});
});
