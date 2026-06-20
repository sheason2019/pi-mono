/**
 * d-pi built-in extensions — public entry points.
 *
 * Agent-local `agent.ts` tool definitions are registered by the worker. This
 * extension layer now only carries the shared d-pi message renderer, input
 * routing, and client/server slash-command glue.
 */

import type { ExtensionFactory } from "./contracts.ts";
import type { HubChannel } from "./hub-channel.ts";
import {
	AGENT_SWITCH_FILE,
	createMultiAgentExtension,
	type DPiClientConfig,
	type DPiExtensionConfig,
	type DPiWorkerConfig,
} from "./multi-agent-extension.ts";

// Re-export the public config types and the agent-switch sentinel so that
// call sites and tests that previously imported them from this barrel continue
// to work without change.
export type { DPiWorkerConfig, DPiClientConfig, DPiExtensionConfig };
export { AGENT_SWITCH_FILE };

// ── Composer ─────────────────────────────────────────────────────────────

/**
 * Create the d-pi std extension behavior.
 */
export function createDPiExtension(config: DPiExtensionConfig): { factory: ExtensionFactory; channel?: HubChannel } {
	if (config.mode === "worker") {
		const { factory: multiFactory, channel } = createMultiAgentExtension(config);
		// Dispatch tools are registered separately in agent-worker.ts
		// (they need cwd which the composer doesn't have).
		return {
			factory: multiFactory,
			channel,
		};
	}
	const { factory } = createMultiAgentExtension(config);
	return { factory };
}

// ── Focused factories ────────────────────────────────────────────────────

/**
 * Multi-agent / orchestration extension.
 *
 * Covers the dual-registered /agents and /sources commands, d-pi custom
 * message routing/rendering, and connect/source input wiring.
 *
 * In worker mode the returned object also carries the HubChannel (used by
 * the worker bootstrap to post messages and hydrate agent-local tools).
 */
// HubChannel is useful for advanced callers that construct the pieces manually.
export { createMultiAgentExtension, HubChannel } from "./multi-agent-extension.ts";
