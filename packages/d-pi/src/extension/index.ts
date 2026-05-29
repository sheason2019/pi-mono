import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { WorkerToHubMessage } from "../types.ts";
import { createAgentNetworkTool } from "./agent-network.ts";
import { createCreateAgentTool } from "./create-agent.ts";
import { createDestroyAgentTool } from "./destroy-agent.ts";
import { HubChannel } from "./hub-channel.ts";
import { createSendMessageTool } from "./send-message.ts";

/**
 * Create the d-pi extension factory.
 *
 * This factory is injected into each agent's extension system via
 * `resourceLoaderOptions.extensionFactories`. It registers 4 tools
 * that allow agents to communicate with each other through the Hub.
 *
 * @param agentId - The ID of the agent this extension is loaded into
 * @param postToHub - Callback to send messages to the Hub (via parentPort)
 * @returns An object with the ExtensionFactory and the shared HubChannel
 */
export function createDPiExtensionFactory(
	agentId: string,
	postToHub: (message: WorkerToHubMessage) => void,
): { factory: ExtensionFactory; channel: HubChannel } {
	// Create the channel — shared across all 4 tools AND the worker
	const channel = new HubChannel(agentId, postToHub);

	const factory: ExtensionFactory = (pi) => {
		pi.registerTool(createSendMessageTool(channel));
		pi.registerTool(createCreateAgentTool(channel));
		pi.registerTool(createDestroyAgentTool(channel));
		pi.registerTool(createAgentNetworkTool(channel));
	};

	return { factory, channel };
}

export { HubChannel };
