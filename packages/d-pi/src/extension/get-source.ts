import { createDPiGetSourceTool } from "../surface/orchestration-tools.ts";
import { createHubActionsClientFromHubChannel } from "./hub-actions-adapter.ts";
import type { HubChannel } from "./hub-channel.ts";

export function createGetSourceTool(channel: HubChannel) {
	return createDPiGetSourceTool(createHubActionsClientFromHubChannel(channel));
}
