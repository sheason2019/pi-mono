import { createDPiDestroyAgentTool } from "../surface/orchestration-tools.ts";
import { createHubActionsClientFromHubChannel } from "./hub-actions-adapter.ts";
import type { HubChannel } from "./hub-channel.ts";

export function createDestroyAgentTool(channel: HubChannel) {
	return createDPiDestroyAgentTool(createHubActionsClientFromHubChannel(channel));
}
