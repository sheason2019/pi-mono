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
 * @returns An ExtensionFactory that registers d-pi tools
 */
export function createDPiExtensionFactory(
	agentId: string,
	postToHub: (message: WorkerToHubMessage) => void,
): ExtensionFactory {
	// Create the channel — it will be shared across all 4 tools
	const channel = new HubChannel(agentId, postToHub);

	return (pi) => {
		pi.registerTool(createSendMessageTool(channel));
		pi.registerTool(createCreateAgentTool(channel));
		pi.registerTool(createDestroyAgentTool(channel));
		pi.registerTool(createAgentNetworkTool(channel));
	};
}

/**
 * Get the HubChannel for a given agent's extension runtime.
 * This is used by the worker to resolve tool_call results.
 */
export function getHubChannelFromFactory(
	agentId: string,
	postToHub: (message: WorkerToHubMessage) => void,
): HubChannel {
	return new HubChannel(agentId, postToHub);
}

export { HubChannel };
