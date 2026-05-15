import type { AuthCredential } from "@sheason/pi-coding-agent";

export type AuthStorageData = Record<string, AuthCredential>;

export type ConfigLayerSource =
	| { kind: "hub"; scope: "global" | "workspace" | "child" }
	| { kind: "peer"; peerId: string; scope: "global" | "cwd" };

export interface PeerSkillSnapshot {
	name: string;
	description: string;
	filePath: string;
	content: string;
	disableModelInvocation?: boolean;
}

export interface PeerPromptSnapshot {
	name: string;
	content: string;
	filePath: string;
}

export interface PeerThemeSnapshot {
	name: string;
	content: string;
	filePath: string;
}

export interface PeerExtensionSnapshot {
	name: string;
	content: string;
	filePath: string;
}

export interface PeerConfigJsonLayers {
	source?: ConfigLayerSource;
	auth?: AuthStorageData;
	models?: unknown;
	settings?: unknown;
	mcp?: unknown;
	skills?: PeerSkillSnapshot[];
	contextFiles?: Array<{ path: string; content: string }>;
	systemPrompt?: string;
	appendSystemPrompt?: string[];
	prompts?: PeerPromptSnapshot[];
	themes?: PeerThemeSnapshot[];
	extensions?: PeerExtensionSnapshot[];
}

export interface PeerConfigSnapshot {
	version: 1;
	capturedAt: string;
	cwd: string;
	global?: PeerConfigJsonLayers;
	cwdLayer?: PeerConfigJsonLayers;
}

export function sanitizePeerConfigSnapshotForLog(snapshot: PeerConfigSnapshot): PeerConfigSnapshot {
	return {
		...snapshot,
		global: snapshot.global ? { ...snapshot.global, auth: undefined } : undefined,
		cwdLayer: snapshot.cwdLayer ? { ...snapshot.cwdLayer, auth: undefined } : undefined,
	};
}
