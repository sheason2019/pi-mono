import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import type { HubAgentAdapter } from "../agent/hub-agent-adapter.js";

/** Runtimes expose `agentAdapter` for messaging; keep structural to avoid importing `HubAgentRuntime` (cycle). */
export interface AgentMessagingTargetRuntime {
	agentAdapter: HubAgentAdapter | undefined;
}

/**
 * `HubRuntime` implements this: resolve agent runtimes and list hub agent ids (main + children with runtimes).
 */
export interface AgentMessagingToolHost {
	tryGetAgentRuntime(agentId: string): AgentMessagingTargetRuntime | undefined;
	ensureAgentStarted?: (agentId: string, reason?: string) => Promise<AgentMessagingTargetRuntime | undefined>;
	getAllMessagingAgentIds(): readonly string[];
	deliverMessageToGuest?: (
		senderAgentId: string,
		targetAgentId: string,
		message: string,
	) => Promise<boolean> | boolean;
}

const sendSchema = Type.Object(
	{
		agentIds: Type.Union([
			Type.String({ minLength: 1, description: "Single target agent id." }),
			Type.Array(Type.String({ minLength: 1 }), {
				minItems: 1,
				description: "Target agent ids (deduplicated).",
			}),
		]),
		message: Type.String({ minLength: 1, description: "Message text to deliver to each target." }),
		flush: Type.Optional(
			Type.Boolean({
				description: "Interrupt running target turn to deliver immediately.",
			}),
		),
	},
	{ additionalProperties: false },
);

const broadcastSchema = Type.Object(
	{
		message: Type.String({ minLength: 1, description: "Message text broadcast to all other agents." }),
	},
	{ additionalProperties: false },
);

export type SendMessageToAgentToolInput = Static<typeof sendSchema>;
export type BroadcastMessageToAgentsToolInput = Static<typeof broadcastSchema>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseMaybeJsonStringArray(raw: string): string | string[] {
	const trimmed = raw.trim();
	if (!trimmed.startsWith("[")) {
		return raw;
	}
	try {
		const parsed = JSON.parse(trimmed) as unknown;
		if (Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string")) {
			return parsed;
		}
	} catch {
		return raw;
	}
	return raw;
}

function prepareSendArguments(args: unknown): SendMessageToAgentToolInput {
	if (!isRecord(args)) {
		return args as SendMessageToAgentToolInput;
	}
	const agentIds = typeof args.agentIds === "string" ? parseMaybeJsonStringArray(args.agentIds) : args.agentIds;
	return {
		...args,
		agentIds,
	} as SendMessageToAgentToolInput;
}

function normalizeTargetIds(raw: string | string[]): string[] {
	const arr = typeof raw === "string" ? [raw] : raw;
	return [...new Set(arr)];
}

function jsonText(obj: unknown): { content: Array<{ type: "text"; text: string }>; details: null } {
	return { content: [{ type: "text" as const, text: JSON.stringify(obj) }], details: null };
}

async function resolveReadyTargets(
	host: AgentMessagingToolHost,
	senderAgentId: string,
	targetIds: readonly string[],
	message: string,
): Promise<Array<{ id: string; adapter?: HubAgentAdapter }> | { error: unknown }> {
	const ready: Array<{ id: string; adapter?: HubAgentAdapter }> = [];
	for (const id of targetIds) {
		const rt = (await host.ensureAgentStarted?.(id, "agent_message")) ?? host.tryGetAgentRuntime(id);
		if (!rt) {
			return { error: { ok: false, error: "agent runtime not found", agentId: id } };
		}
		const adapter = rt.agentAdapter;
		if (!adapter) {
			if ((await host.deliverMessageToGuest?.(senderAgentId, id, message)) === true) {
				ready.push({ id });
				continue;
			}
			return {
				error: {
					ok: false,
					error: "Hub agent adapter is not initialized for target",
					agentId: id,
				},
			};
		}
		ready.push({ id, adapter });
	}
	return ready;
}

export function createAgentMessagingToolDefinitions(
	getHost: () => AgentMessagingToolHost,
	senderAgentId: string,
): ToolDefinition[] {
	return [
		defineTool({
			name: "send_message_to_agent",
			label: "send_message_to_agent",
			description:
				"Queue a message for one or more other hub agents (main or child). Uses agent/<your id> metadata for attribution. Rejects self-target. Set flush=true for high-priority delivery: the target queue is flushed immediately, interrupting an active target turn if needed.",
			parameters: sendSchema,
			prepareArguments: prepareSendArguments,
			async execute(_id, params) {
				const { message } = params;
				const targetIds = normalizeTargetIds(params.agentIds);
				if (targetIds.includes(senderAgentId)) {
					return jsonText({ ok: false, error: "send_message_to_agent cannot target the sender (self)" });
				}
				const host = getHost();
				const unknown: string[] = [];
				for (const id of targetIds) {
					if (!host.getAllMessagingAgentIds().includes(id)) {
						unknown.push(id);
					}
				}
				if (unknown.length > 0) {
					return jsonText({
						ok: false,
						error: "unknown agent id(s)",
						unknown,
					});
				}
				const ready = await resolveReadyTargets(host, senderAgentId, targetIds, message);
				if (!Array.isArray(ready)) {
					return jsonText(ready.error);
				}
				for (const target of ready) {
					await target.adapter?.enqueueFromAgent(senderAgentId, message);
				}
				if (params.flush !== true) {
					return jsonText({ ok: true, queued: ready.map((target) => target.id) });
				}
				const flush = [];
				for (const target of ready) {
					if (!target.adapter) {
						continue;
					}
					const result = await target.adapter.flushInputQueue();
					flush.push({ agentId: target.id, ...result });
				}
				return jsonText({ ok: true, queued: ready.map((target) => target.id), flush });
			},
		}),
		defineTool({
			name: "broadcast_message_to_agents",
			label: "broadcast_message_to_agents",
			description:
				"Queue a message for every other hub agent (all registered agents except the sender). No-op with a clear result when there are no recipients.",
			parameters: broadcastSchema,
			async execute(_id, params) {
				const { message } = params;
				const host = getHost();
				const all = host.getAllMessagingAgentIds();
				const recipients = all.filter((id) => id !== senderAgentId);
				if (recipients.length === 0) {
					return jsonText({
						ok: true,
						queued: [] as string[],
						message: "no other agents to receive broadcast",
					});
				}
				const ready = await resolveReadyTargets(host, senderAgentId, recipients, message);
				if (!Array.isArray(ready)) {
					return jsonText(ready.error);
				}
				for (const target of ready) {
					await target.adapter?.enqueueFromAgent(senderAgentId, message);
				}
				return jsonText({ ok: true, queued: ready.map((target) => target.id) });
			},
		}),
	];
}
