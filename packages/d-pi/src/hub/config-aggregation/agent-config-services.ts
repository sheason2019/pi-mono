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
import { mergeConfigLayers } from "./merge-config.js";
import type { ConfigLayerSource, PeerConfigJsonLayers, PeerSkillSnapshot } from "./types.js";

export interface CreateAggregatedAgentSessionServicesOptions {
	cwd: string;
	agentDir: string;
	layers: PeerConfigJsonLayers[];
	mergedModelsFile?: string;
	resourceLoaderOptions?: CreateAgentSessionServicesOptions["resourceLoaderOptions"];
}

export interface AggregatedAgentSessionServices {
	services: AgentSessionServices;
	mergedModelsFile: string;
}

function createReadOnlySettingsManager(settings: unknown): SettingsManager {
	const content = JSON.stringify(settings && typeof settings === "object" ? settings : {});
	return SettingsManager.fromStorage({
		withLock(scope, fn) {
			return fn(scope === "global" ? content : undefined);
		},
	});
}

function peerSkillSourceLabel(source: ConfigLayerSource): string {
	return source.kind === "peer" ? source.peerId : "hub";
}

function materializePeerSkills(cwd: string, layers: PeerConfigJsonLayers[]): Skill[] {
	const skills: Skill[] = [];
	const root = join(getWorkspaceDir(cwd), "peer-resources");
	for (let layerIndex = 0; layerIndex < layers.length; layerIndex += 1) {
		const layer = layers[layerIndex]!;
		if (layer.source?.kind !== "peer" || !layer.skills) {
			continue;
		}
		for (let skillIndex = 0; skillIndex < layer.skills.length; skillIndex += 1) {
			const skill = layer.skills[skillIndex]!;
			const sourceKey = [layer.source.peerId, layer.source.scope, layerIndex, skillIndex, skill.filePath].join("\0");
			const sourceToken = createHash("sha256").update(sourceKey).digest("hex").slice(0, 12);
			const dir = join(root, layer.source.peerId, "skills", sourceToken, skill.name);
			mkdirSync(dir, { recursive: true });
			const filePath = join(dir, "SKILL.md");
			writeFileSync(filePath, skill.content, "utf8");
			skills.push(createPeerSkill(skill, layer.source, filePath));
		}
	}
	return skills;
}

function createPeerSkill(skill: PeerSkillSnapshot, source: ConfigLayerSource, filePath: string): Skill {
	const baseDir = dirname(filePath);
	return {
		name: skill.name,
		description: skill.description,
		filePath,
		baseDir,
		sourceInfo: createSyntheticSourceInfo(filePath, {
			source: peerSkillSourceLabel(source),
			scope: "temporary",
			baseDir,
		}),
		disableModelInvocation: skill.disableModelInvocation === true,
	};
}

export async function createAggregatedAgentSessionServices(
	options: CreateAggregatedAgentSessionServicesOptions,
): Promise<AggregatedAgentSessionServices> {
	const merged = mergeConfigLayers(options.layers);
	const peerSkills = materializePeerSkills(options.cwd, options.layers);
	const mergedModelsFile = options.mergedModelsFile ?? join(getWorkspaceDir(options.cwd), "merged-models.json");
	mkdirSync(getWorkspaceDir(options.cwd), { recursive: true });
	writeFileSync(mergedModelsFile, `${JSON.stringify(merged.models, null, 2)}\n`, "utf8");
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
					skills: [...upstream.skills, ...peerSkills],
					diagnostics: upstream.diagnostics,
				};
			},
			...(merged.contextFiles.length > 0
				? {
						agentsFilesOverride: (base: { agentsFiles: Array<{ path: string; content: string }> }) => ({
							agentsFiles: [
								...(upstreamAgentsFilesOverride
									? upstreamAgentsFilesOverride(base).agentsFiles
									: base.agentsFiles),
								...merged.contextFiles,
							],
						}),
					}
				: {}),
		},
	});
	return { services, mergedModelsFile };
}
