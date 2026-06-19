import { createDPiCreateAgentTool } from "../surface/orchestration-tools.ts";
import { createHubActionsClientFromHubChannel } from "./hub-actions-adapter.ts";
import type { HubChannel } from "./hub-channel.ts";

export function createCreateAgentTool(channel: HubChannel) {
	const tool = createDPiCreateAgentTool(createHubActionsClientFromHubChannel(channel));
	return {
		...tool,
		execute(
			toolCallId: Parameters<typeof tool.execute>[0],
			params: Parameters<typeof tool.execute>[1],
			signal?: Parameters<typeof tool.execute>[2],
			onUpdate?: Parameters<typeof tool.execute>[3],
			_ctx?: unknown,
		): ReturnType<typeof tool.execute> {
			return tool.execute(toolCallId, params, signal, onUpdate);
		},
	};
}
