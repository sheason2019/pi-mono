import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	createAggregatedAgentSessionServices,
	D_PI_PEER_RESOURCES_SKILL_NAME,
} from "../../src/hub/config-aggregation/agent-config-services.js";
import type { PeerConfigJsonLayers } from "../../src/hub/config-aggregation/types.js";
import { remoteMcpResourceToken } from "../../src/hub/mcp/remote-mcp-tools.js";

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
				source: { kind: "peer", peerId: "peer-a", scope: "cwd" },
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
		expect(services.resourceLoader.getAgentsFiles().agentsFiles).not.toEqual(
			expect.arrayContaining([expect.objectContaining({ path: "/peer/AGENTS.md" })]),
		);
		const metaSkill = services.resourceLoader
			.getSkills()
			.skills.find((skill) => skill.name === D_PI_PEER_RESOURCES_SKILL_NAME);
		expect(metaSkill).toBeDefined();
		expect(readFileSync(metaSkill!.filePath, "utf8")).toContain("peer context");
		expect(services.modelRegistry.getAvailable().some((model) => model.id === "peer-model")).toBe(true);
		expect(mergedModelsFile).toContain(".pi-hub");
		expect(existsSync(join(agentDir, "auth.json"))).toBe(false);
	});

	it("materializes duplicate peer skill names behind a stable meta skill", async () => {
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
		expect(skills).toHaveLength(0);
		const metaSkill = result.skills.find((skill) => skill.name === D_PI_PEER_RESOURCES_SKILL_NAME);
		expect(metaSkill).toBeDefined();
		expect(metaSkill!.filePath).toBe(join(cwd, ".pi-hub", "peer-resources", "d-pi-peer-resources", "SKILL.md"));
		const metaSkillContent = readFileSync(metaSkill!.filePath, "utf8");
		expect(metaSkillContent).toContain("work laptop");
		expect(metaSkillContent).toContain("Summarize content");
		expect(metaSkillContent).toContain("other laptop");
		expect(metaSkillContent).toContain("Summarize from other peer");
		expect(
			result.diagnostics.filter(
				(diagnostic) => diagnostic.type === "collision" && JSON.stringify(diagnostic).includes("summarize"),
			),
		).toHaveLength(0);
	});

	it("adds peer MCP capabilities to the stable meta skill index", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "agent-config-peer-mcp-index-cwd-"));
		const agentDir = mkdtempSync(join(tmpdir(), "agent-config-peer-mcp-index-agent-"));
		tempDirs.push(cwd, agentDir);
		mkdirSync(join(cwd, ".pi-hub"), { recursive: true });

		const { services } = await createAggregatedAgentSessionServices({
			cwd,
			agentDir,
			layers: [],
			peerMcpSnapshots: [
				{
					peerId: "peer-a",
					servers: [
						{
							name: "fs",
							resourceId: "fs-id",
							transport: "stdio",
							status: "running",
							capabilities: {
								tools: [{ name: "read_file", description: "Read a file" }],
								resources: [],
								prompts: [],
							},
						},
					],
				},
			],
		});

		const metaSkill = services.resourceLoader
			.getSkills()
			.skills.find((skill) => skill.name === D_PI_PEER_RESOURCES_SKILL_NAME);
		const content = readFileSync(metaSkill!.filePath, "utf8");
		expect(content).toContain("Call `peer_mcp`");
		expect(content).toContain("peer-a");
		expect(content).toContain("fs-id");
		expect(content).toContain(`mcp__${remoteMcpResourceToken("peer-a", "fs-id")}__read_file`);
		expect(content).toContain("Read a file");
	});

	it("keeps the prompt-visible peer skill index stable across peer skill changes", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "agent-config-stable-meta-skill-cwd-"));
		const agentDir = mkdtempSync(join(tmpdir(), "agent-config-stable-meta-skill-agent-"));
		tempDirs.push(cwd, agentDir);
		mkdirSync(join(cwd, ".pi-hub"), { recursive: true });
		const baseLayer = {
			source: { kind: "peer" as const, peerId: "peer-a", scope: "cwd" as const },
		};

		const first = await createAggregatedAgentSessionServices({
			cwd,
			agentDir,
			layers: [
				{
					...baseLayer,
					skills: [
						{
							name: "first",
							description: "First skill",
							filePath: "/peer/skills/first/SKILL.md",
							content: "---\nname: first\ndescription: First skill\n---\n\nFirst.",
						},
					],
				},
			],
		});
		const second = await createAggregatedAgentSessionServices({
			cwd,
			agentDir,
			layers: [
				{
					...baseLayer,
					skills: [
						{
							name: "second",
							description: "Second skill",
							filePath: "/peer/skills/second/SKILL.md",
							content: "---\nname: second\ndescription: Second skill\n---\n\nSecond.",
						},
					],
				},
			],
		});

		const visibleSkillShape = (services: typeof first.services) =>
			services.resourceLoader.getSkills().skills.map((skill) => ({
				name: skill.name,
				description: skill.description,
				filePath: skill.filePath,
			}));
		expect(visibleSkillShape(second.services)).toEqual(visibleSkillShape(first.services));
		const metaSkill = second.services.resourceLoader
			.getSkills()
			.skills.find((skill) => skill.name === D_PI_PEER_RESOURCES_SKILL_NAME);
		expect(readFileSync(metaSkill!.filePath, "utf8")).toContain("Second skill");
	});
});
