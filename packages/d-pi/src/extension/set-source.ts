import { createDPiSetSourceTool } from "../surface/orchestration-tools.ts";
import { createHubActionsClientFromHubChannel } from "./hub-actions-adapter.ts";
import type { HubChannel } from "./hub-channel.ts";

export function createSetSourceTool(channel: HubChannel) {
	return createDPiSetSourceTool(createHubActionsClientFromHubChannel(channel));
}
