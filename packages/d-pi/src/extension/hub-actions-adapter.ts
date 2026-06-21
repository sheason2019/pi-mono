import type {
	DPiCreateAgentActionResult,
	DPiDispatchRemoteToolActionPayload,
	DPiDispatchRemoteToolActionResult,
	DPiGetSourceActionResult,
	DPiHubActionsClient,
	DPiSourceConfig,
	DPiTeamSnapshot,
} from "../surface/index.ts";
import type { HubChannel } from "./hub-channel.ts";

interface LegacyCreateAgentResult {
	agentId?: string;
	agentName?: string;
	name?: string;
	error?: string;
}

interface LegacyOkResult {
	ok?: boolean;
	error?: string;
}

export function createHubActionsClientFromHubChannel(channel: HubChannel): DPiHubActionsClient {
	return {
		async createAgent(payload): Promise<DPiCreateAgentActionResult> {
			const raw = await channel.createAgent(payload.name, payload.cwd);
			const result = legacyCreateAgentResult(raw);
			if (result.error) {
				throw new Error(result.error);
			}
			const agentName = result.agentName ?? result.name ?? payload.name;
			return result.agentId === undefined ? { agentName } : { agentName, agentId: result.agentId };
		},
		async destroyAgent(payload): Promise<{ ok: boolean; error?: string }> {
			return normalizeOkResult(await channel.destroyAgent(payload.agentName));
		},
		async getTeam(): Promise<DPiTeamSnapshot> {
			return (await channel.getTeam()) as DPiTeamSnapshot;
		},
		async sendMessage(payload): Promise<{ ok: boolean; error?: string }> {
			return normalizeOkResult(await channel.sendMessage(payload.toAgentName, payload.content, payload.mode));
		},
		async setSource(payload: DPiSourceConfig): Promise<{ ok: boolean; error?: string }> {
			return normalizeOkResult(await channel.setSource(payload));
		},
		async getSource(payload = {}): Promise<DPiGetSourceActionResult> {
			return (await channel.getSource(payload.name)) as DPiGetSourceActionResult;
		},
		async deleteSource(payload): Promise<{ ok: boolean; error?: string }> {
			return normalizeOkResult(await channel.deleteSource(payload.name));
		},
		async dispatchRemoteTool(
			_payload: DPiDispatchRemoteToolActionPayload,
		): Promise<DPiDispatchRemoteToolActionResult> {
			throw new Error("dispatchRemoteTool is not part of the orchestration adapter");
		},
	};
}

function legacyCreateAgentResult(value: unknown): LegacyCreateAgentResult {
	if (!isRecord(value)) {
		return {};
	}
	return {
		agentId: stringField(value, "agentId"),
		agentName: stringField(value, "agentName"),
		name: stringField(value, "name"),
		error: stringField(value, "error"),
	};
}

function normalizeOkResult(value: unknown): { ok: boolean; error?: string } {
	const result = legacyOkResult(value);
	if (result.error) {
		return { ok: false, error: result.error };
	}
	return { ok: result.ok ?? true };
}

function legacyOkResult(value: unknown): LegacyOkResult {
	if (!isRecord(value)) {
		return {};
	}
	const ok = value.ok;
	return {
		ok: typeof ok === "boolean" ? ok : undefined,
		error: stringField(value, "error"),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" ? value : undefined;
}
