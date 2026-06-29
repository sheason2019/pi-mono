import { z } from "zod";
import type { HubChannel } from "../multi-agent/hub-channel.ts";
import type {
	DPiCreateAgentActionResult,
	DPiDispatchRemoteToolActionPayload,
	DPiDispatchRemoteToolActionResult,
	DPiHubActionsClient,
	DPiReloadWorkspaceResult,
	DPiSyncAgentsResult,
	DPiTeamSnapshot,
} from "./index.ts";

const createAgentResultSchema = z.object({
	agentName: z.string().optional(),
	error: z.string().optional(),
});

const okResultSchema = z.object({
	ok: z.boolean().optional(),
	error: z.string().optional(),
});

export function createHubActionsClientFromHubChannel(channel: HubChannel): DPiHubActionsClient {
	return {
		async createAgent(payload): Promise<DPiCreateAgentActionResult> {
			const raw = await channel.createAgent(payload.name, payload.cwd);
			const result = createAgentResultSchema.safeParse(raw).data;
			if (result?.error) {
				throw new Error(result.error);
			}
			return { agentName: result?.agentName ?? payload.name };
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
		async reloadWorkspace(): Promise<DPiReloadWorkspaceResult> {
			return (await channel.reloadWorkspace()) as DPiReloadWorkspaceResult;
		},
		async syncAgents(): Promise<DPiSyncAgentsResult> {
			return (await channel.syncAgents()) as DPiSyncAgentsResult;
		},
		async dispatchRemoteTool(
			_payload: DPiDispatchRemoteToolActionPayload,
		): Promise<DPiDispatchRemoteToolActionResult> {
			throw new Error("dispatchRemoteTool is not part of the orchestration adapter");
		},
	};
}

function normalizeOkResult(value: unknown): { ok: boolean; error?: string } {
	const result = okResultSchema.safeParse(value).data;
	if (result?.error) {
		return { ok: false, error: result.error };
	}
	return { ok: result?.ok ?? true };
}
