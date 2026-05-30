import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { SourceInfo, WorkerToHubMessage } from "../types.ts";
import { createAgentNetworkTool } from "./agent-network.ts";
import { createCreateAgentTool } from "./create-agent.ts";
import { createCreateSourceTool } from "./create-source.ts";
import { createDestroyAgentTool } from "./destroy-agent.ts";
import { createDestroySourceTool } from "./destroy-source.ts";
import { HubChannel } from "./hub-channel.ts";
import { createListSourcesTool } from "./list-sources.ts";
import { createSendMessageTool } from "./send-message.ts";
import { createSubscribeSourceTool } from "./subscribe-source.ts";
import { createUnsubscribeSourceTool } from "./unsubscribe-source.ts";

/**
 * Create the d-pi extension factory.
 *
 * This factory is injected into each agent's extension system via
 * `resourceLoaderOptions.extensionFactories`. It registers tools
 * that allow agents to communicate with each other through the Hub
 * and interact with external sources.
 *
 * @param agentId - The ID of the agent this extension is loaded into
 * @param postToHub - Callback to send messages to the Hub (via parentPort)
 * @returns An object with the ExtensionFactory and the shared HubChannel
 */
export function createDPiExtensionFactory(
	agentId: string,
	postToHub: (message: WorkerToHubMessage) => void,
): { factory: ExtensionFactory; channel: HubChannel } {
	// Create the channel — shared across all tools AND the worker
	const channel = new HubChannel(agentId, postToHub);

	const factory: ExtensionFactory = (pi) => {
		pi.registerTool(createSendMessageTool(channel));
		pi.registerTool(createCreateAgentTool(channel));
		pi.registerTool(createDestroyAgentTool(channel));
		pi.registerTool(createAgentNetworkTool(channel));
		pi.registerTool(createCreateSourceTool(channel));
		pi.registerTool(createDestroySourceTool(channel));
		pi.registerTool(createSubscribeSourceTool(channel));
		pi.registerTool(createUnsubscribeSourceTool(channel));
		pi.registerTool(createListSourcesTool(channel));

		// Register /sources command — lists all sources via the hub channel
		pi.registerCommand("sources", {
			description: "List all registered sources",
			async handler(_args: string, ctx): Promise<void> {
				try {
					const raw = await channel.listSources();
					const result = raw as { sources?: SourceInfo[]; error?: string };
					if (result.error) {
						ctx.ui.notify(`Failed to list sources: ${result.error}`, "error");
						return;
					}
					const sources = result.sources ?? [];
					if (sources.length === 0) {
						ctx.ui.notify("No sources registered. Use create_source tool to register one.", "info");
						return;
					}
					const lines = sources.map(
						(s) => `  ${s.name} [${s.status}] command="${s.command}" subscribers=${s.subscriberCount}`,
					);
					ctx.ui.notify(`Sources:\n${lines.join("\n")}`, "info");
				} catch (err) {
					ctx.ui.notify(`Failed to list sources: ${err instanceof Error ? err.message : String(err)}`, "error");
				}
			},
		});
	};

	return { factory, channel };
}

export { HubChannel };
