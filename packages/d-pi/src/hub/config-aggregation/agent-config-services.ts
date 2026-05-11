import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	type AgentSessionServices,
	AuthStorage,
	type CreateAgentSessionServicesOptions,
	createAgentSessionServices,
	createSyntheticSourceInfo,
	ModelRegistry,
	SettingsManager,
	type Skill,
} from "@earendil-works/pi-coding-agent";
import { getWorkspaceDir } from "../config.js";
import { remoteMcpResourceToken } from "../mcp/remote-mcp-tools.js";
import type { McpRuntimeStatus } from "../mcp/types.js";
import { mergeConfigLayers } from "./merge-config.js";
import type { PeerConfigJsonLayers } from "./types.js";

export const D_PI_PEER_RESOURCES_SKILL_NAME = "d-pi-peer-resources";

export interface PeerMcpIndexSnapshot {
	peerId: string;
	servers: McpRuntimeStatus[];
}

export interface CreateAggregatedAgentSessionServicesOptions {
	cwd: string;
	agentDir: string;
	layers: PeerConfigJsonLayers[];
	mergedModelsFile?: string;
	resourceLoaderOptions?: CreateAgentSessionServicesOptions["resourceLoaderOptions"];
	peerMcpSnapshots?: PeerMcpIndexSnapshot[];
}

export interface AggregatedAgentSessionServices {
	services: AgentSessionServices;
	mergedModelsFile: string;
}

export function materializeAggregatedModelsConfig(options: {
	cwd: string;
	layers: PeerConfigJsonLayers[];
	mergedModelsFile?: string;
}): string {
	const merged = mergeConfigLayers(options.layers);
	const mergedModelsFile = options.mergedModelsFile ?? join(getWorkspaceDir(options.cwd), "merged-models.json");
	mkdirSync(getWorkspaceDir(options.cwd), { recursive: true });
	writeFileSync(mergedModelsFile, `${JSON.stringify(merged.models, null, 2)}\n`, "utf8");
	return mergedModelsFile;
}

function createReadOnlySettingsManager(settings: unknown): SettingsManager {
	const content = JSON.stringify(settings && typeof settings === "object" ? settings : {});
	return SettingsManager.fromStorage({
		withLock(scope, fn) {
			return fn(scope === "global" ? content : undefined);
		},
	});
}

function safePathToken(value: string): string {
	const safe = value.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
	const hash = createHash("sha256").update(value).digest("hex").slice(0, 8);
	if (safe.length === 0) {
		return `x_${hash}`;
	}
	return safe.length <= 40 ? safe : `${safe.slice(0, 40)}_${hash}`;
}

interface MaterializedPeerResources {
	metaSkill: Skill;
}

function materializePeerResources(
	cwd: string,
	layers: PeerConfigJsonLayers[],
	peerMcpSnapshots: PeerMcpIndexSnapshot[] = [],
): MaterializedPeerResources {
	const root = join(getWorkspaceDir(cwd), "peer-resources");
	const metaDir = join(root, D_PI_PEER_RESOURCES_SKILL_NAME);
	const metaFilePath = join(metaDir, "SKILL.md");
	mkdirSync(metaDir, { recursive: true });
	const lines = [
		"---",
		`name: ${D_PI_PEER_RESOURCES_SKILL_NAME}`,
		"description: Discover peer-provided D-Pi skills, context, and MCP capabilities.",
		"---",
		"",
		"# D-Pi Peer Resources",
		"",
		"Use this meta skill when hub-local skills and MCP tools do not cover the task.",
		"Peer resources change dynamically; this file is regenerated from the current peer configuration.",
		"",
	];
	let hasPeerResources = false;
	for (let layerIndex = 0; layerIndex < layers.length; layerIndex += 1) {
		const layer = layers[layerIndex]!;
		if (layer.source?.kind !== "peer") {
			continue;
		}
		const peerId = layer.source.peerId;
		const peerToken = safePathToken(peerId);
		if ((layer.contextFiles?.length ?? 0) > 0 || (layer.skills?.length ?? 0) > 0) {
			hasPeerResources = true;
			lines.push(`## Peer ${peerId} (${layer.source.scope})`, "");
		}
		for (const contextFile of layer.contextFiles ?? []) {
			lines.push(`### Context file: ${contextFile.path}`, "", "```text", contextFile.content, "```", "");
		}
		const skills = layer.skills ?? [];
		for (let skillIndex = 0; skillIndex < skills.length; skillIndex += 1) {
			const skill = skills[skillIndex]!;
			const sourceKey = [peerId, layer.source.scope, skill.filePath, skill.name].join("\0");
			const sourceToken = createHash("sha256").update(sourceKey).digest("hex").slice(0, 12);
			const dir = join(root, "peers", peerToken, layer.source.scope, "skills", sourceToken, skill.name);
			mkdirSync(dir, { recursive: true });
			const filePath = join(dir, "SKILL.md");
			writeFileSync(filePath, skill.content, "utf8");
			lines.push(`### Skill: ${skill.name}`, "", `Description: ${skill.description}`, `Location: ${filePath}`, "");
			if (skill.disableModelInvocation === true) {
				lines.push("This skill is explicit-invocation only.", "");
			}
		}
	}
	if (!hasPeerResources) {
		lines.push("No peer-provided skills or context files are currently available.", "");
	}
	lines.push("## Peer MCP capabilities", "");
	lines.push(
		"Call `peer_mcp` with `peer-id`, exact `tool-name`, and `args` when a listed peer MCP tool is needed.",
		"",
	);
	let hasPeerMcpTools = false;
	for (const peer of [...peerMcpSnapshots].sort((a, b) => a.peerId.localeCompare(b.peerId))) {
		const runningServers = peer.servers.filter((server) => server.status === "running");
		if (runningServers.length === 0) {
			continue;
		}
		lines.push(`### Peer MCP: ${peer.peerId}`, "");
		for (const server of [...runningServers].sort((a, b) => a.name.localeCompare(b.name))) {
			const resourceId = server.resourceId ?? server.name;
			lines.push(`- Server: ${server.name}`);
			lines.push(`  Resource ID: ${resourceId}`);
			for (const tool of [...server.capabilities.tools].sort((a, b) => a.name.localeCompare(b.name))) {
				hasPeerMcpTools = true;
				const remoteToolName = `mcp__${remoteMcpResourceToken(peer.peerId, resourceId)}__${tool.name}`;
				lines.push(`  - Tool: ${remoteToolName}`);
				if (tool.description) {
					lines.push(`    Description: ${tool.description}`);
				}
			}
			lines.push("");
		}
	}
	if (!hasPeerMcpTools) {
		lines.push("No peer-provided MCP tools are currently available.", "");
	}
	writeFileSync(metaFilePath, `${lines.join("\n").trimEnd()}\n`, "utf8");
	const baseDir = dirname(metaFilePath);
	return {
		metaSkill: {
			name: D_PI_PEER_RESOURCES_SKILL_NAME,
			description: "Discover peer-provided D-Pi skills, context, and MCP capabilities.",
			filePath: metaFilePath,
			baseDir,
			sourceInfo: createSyntheticSourceInfo(metaFilePath, {
				source: "d-pi",
				scope: "temporary",
				baseDir,
			}),
			disableModelInvocation: false,
		},
	};
}

export async function createAggregatedAgentSessionServices(
	options: CreateAggregatedAgentSessionServicesOptions,
): Promise<AggregatedAgentSessionServices> {
	const merged = mergeConfigLayers(options.layers);
	const promptStableMerged = mergeConfigLayers(
		options.layers.map((layer) =>
			layer.source?.kind === "peer" ? { ...layer, skills: undefined, contextFiles: undefined } : layer,
		),
	);
	const peerResources = materializePeerResources(options.cwd, options.layers, options.peerMcpSnapshots);
	const mergedModelsFile = materializeAggregatedModelsConfig({
		cwd: options.cwd,
		layers: options.layers,
		mergedModelsFile: options.mergedModelsFile,
	});
	const authStorage = AuthStorage.inMemory(merged.auth);
	const settingsManager = createReadOnlySettingsManager(merged.settings);
	const upstreamResourceOptions = options.resourceLoaderOptions;
	const upstreamSkillsOverride = upstreamResourceOptions?.skillsOverride;
	const upstreamAgentsFilesOverride = upstreamResourceOptions?.agentsFilesOverride;
	const services = await createAgentSessionServices({
		cwd: options.cwd,
		agentDir: options.agentDir,
		authStorage,
		settingsManager,
		modelRegistry: ModelRegistry.create(authStorage, mergedModelsFile),
		resourceLoaderOptions: {
			...(upstreamResourceOptions ?? {}),
			skillsOverride: (base) => {
				const upstream = upstreamSkillsOverride ? upstreamSkillsOverride(base) : base;
				return {
					skills: [...upstream.skills, peerResources.metaSkill],
					diagnostics: upstream.diagnostics,
				};
			},
			...(promptStableMerged.contextFiles.length > 0
				? {
						agentsFilesOverride: (base: { agentsFiles: Array<{ path: string; content: string }> }) => ({
							agentsFiles: [
								...(upstreamAgentsFilesOverride
									? upstreamAgentsFilesOverride(base).agentsFiles
									: base.agentsFiles),
								...promptStableMerged.contextFiles,
							],
						}),
					}
				: {}),
		},
	});
	return { services, mergedModelsFile };
}
