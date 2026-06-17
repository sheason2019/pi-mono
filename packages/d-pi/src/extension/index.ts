/**
 * d-pi built-in extensions — public entry points.
 *
 * We have decomposed the previous monolithic `createDPiExtension` into three
 * focused extensions that can be registered independently (with clear names
 * for diagnostics) or composed via the convenience `createDPiExtension`:
 *
 * - multi-agent-extension: agent tree, sources, send_message, group_architecture,
 *   /agents and /sources commands, d-pi message routing and rendering.
 * - dispatch-extension: the `dispatch_*` tools (remote_bash, remote_read, ...)
 *   that dispatch to a connected d-pi client executor.
 * - agent-metadata (separate package): reload + set_model + set_thinking_level.
 *
 * Existing call sites that use `createDPiExtension` continue to receive the
 * full previous behavior (the composer wires the first two + metadata is
 * registered separately in the worker bootstrap).
 */

import type { ExtensionFactory } from "@sheason/pi-coding-agent";
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

// ── Composer (keeps the old public surface working) ─────────────────────

/**
 * Create the d-pi std extension behavior.
 *
 * This is now a thin composer:
 * - In worker mode it wires both the multi-agent orchestration surface and
 *   the dispatch tools (so existing `createDPiExtension` call sites
 *   and tests get the same set of tools + handlers as before).
 * - In client mode it only needs the multi-agent piece (the TUI command UIs).
 *
 * The three focused factories are also exported so that the worker bootstrap
 * (agent-worker.ts) can register them as separate named extensions for better
 * diagnostics and future optionality:
 *
 *   { factory: multi, name: "<d-pi-multi-agent>" },
 *   { factory: remote, name: "<d-pi-dispatch>" },
 *   { factory: metadata, name: "<d-pi-metadata>" },
 *
 * Note on reload: the `reload` tool (plus set_model/set_thinking_level) lives
 * exclusively inside the agent-metadata extension. createDPiExtension (the
 * composer) only wires multi-agent + dispatch; metadata is always
 * registered as a distinct third factory by the worker. This prevents
 * accidental double-registration of reload if a caller manually composes
 * the pieces.
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

// ── Focused factories (the real decomposition) ───────────────────────────

/**
 * Multi-agent / orchestration extension.
 *
 * Covers: agent lifecycle, sources, send_message, group_architecture,
 * the dual-registered /agents and /sources commands, d-pi custom message
 * routing and rendering, and connect/source input wiring.
 *
 * In worker mode the returned object also carries the HubChannel (used by
 * the dispatch extension and by the worker bootstrap to post messages).
 */
export { createMultiAgentExtension } from "./multi-agent-extension.ts";

/**
 * Remote executor extension.
 *
 * Provides only the `dispatch_*` tool family. These tools let a hub-side agent
 * execute native tools on a connected d-pi client (via the IPC channel
 * established by `d-pi connect`). If no client is bound the tools surface
 * a clear error.
 *
 * This is intentionally separate from the multi-agent surface so the two
 * concerns can be traced and enabled independently.
 */

// ── Other d-pi built-in extensions (unchanged) ───────────────────────────

export { createAgentMetadataExtension } from "./agent-metadata.ts";
export { createDispatchExtension } from "./dispatch-extension.ts";
// HubChannel is useful for advanced callers that construct the pieces manually.
export { HubChannel } from "./multi-agent-extension.ts";
export { createReloadExtension, createReloadTools, type ReloadToolsDeps } from "./reload-tools.ts";
