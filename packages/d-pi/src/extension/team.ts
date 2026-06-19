import { createDPiTeamTool } from "../surface/orchestration-tools.ts";
import { createHubActionsClientFromHubChannel } from "./hub-actions-adapter.ts";
import type { HubChannel } from "./hub-channel.ts";

export function createTeamTool(channel: HubChannel) {
	return createDPiTeamTool(createHubActionsClientFromHubChannel(channel));
}
