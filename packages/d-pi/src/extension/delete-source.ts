import { createDPiDeleteSourceTool } from "../surface/orchestration-tools.ts";
import { createHubActionsClientFromHubChannel } from "./hub-actions-adapter.ts";
import type { HubChannel } from "./hub-channel.ts";

export function createDeleteSourceTool(channel: HubChannel) {
	return createDPiDeleteSourceTool(createHubActionsClientFromHubChannel(channel));
}
