import type {
	DPiCreateAgentActionResult,
	DPiDispatchRemoteToolActionPayload,
	DPiDispatchRemoteToolActionResult,
	DPiHubActionsClient,
	DPiTeamSnapshot,
} from "../surface/index.ts";
import type { HubChannel } from "./hub-channel.ts";

interface OkResult {
	ok?: boolean;
	error?: string;
}

export function createHubActionsClientFromHubChannel(channel: HubChannel): DPiHubActionsClient {
	return {
		async createAgent(payload): Promise<DPiCreateAgentActionResult> {
			const raw = await channel.createAgent(payload.name, payload.cwd);
			const result = asCreateAgentResult(raw);
			if (result.error) {
				throw new Error(result.error);
			}
			return { agentName: result.agentName ?? payload.name };
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
		async dispatchRemoteTool(
			_payload: DPiDispatchRemoteToolActionPayload,
		): Promise<DPiDispatchRemoteToolActionResult> {
			throw new Error("dispatchRemoteTool is not part of the orchestration adapter");
		},
	};
}

function asCreateAgentResult(value: unknown): { agentName?: string; error?: string } {
	if (!isRecord(value)) {
		return {};
	}
	return {
		agentName: stringField(value, "agentName"),
		error: stringField(value, "error"),
	};
}

function normalizeOkResult(value: unknown): { ok: boolean; error?: string } {
	const result = asOkResult(value);
	if (result.error) {
		return { ok: false, error: result.error };
	}
	return { ok: result.ok ?? true };
}

function asOkResult(value: unknown): OkResult {
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
