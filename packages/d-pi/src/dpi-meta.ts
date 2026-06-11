import { DPI_BUILD_COMMIT, DPI_BUILD_TIME } from "./dpi-meta.generated.ts";

/**
 * The d-pi system-prompt meta block. Injected into every agent's system
 * prompt at session start via ResourceLoader.appendSystemPrompt, mirroring
 * the APPEND_SYSTEM.md mechanism.
 *
 * Keep this lean: tool listings, parameters, and per-tool behavior live
 * in each tool's `description` and JSON schema (visible to the LLM via
 * the tools API). Duplicating that information here is a maintenance
 * liability and an accuracy drift risk — see PR #34 history.
 *
 * What belongs here instead: high-level context about the d-pi runtime,
 * plus anything that is genuinely cross-tool (architectural facts that
 * apply to multiple tools). Per-tool constraints belong on the tool
 * itself, not in this block.
 */
export const DPI_META_PROMPT = `## d-pi runtime context

You are running inside d-pi, a multi-agent orchestrator built on top of
pi-coding-agent. d-pi adds: data sources (long-running supervised
processes emitting JSON-RPC 2.0 notifications on stdout), a sub-agent
group architecture (parent/child agents with roles), and a separate
executor subprocess that runs native tools for connect-mode sessions.

The available d-pi tools (create_source, subscribe_source, create_agent,
send_message, group_architecture, reload, ...) are listed in the tools
section of this turn — refer to each tool's description and JSON schema
for parameters, constraints, and routing semantics.

d-pi build: commit=\`${DPI_BUILD_COMMIT}\`, built=\`${DPI_BUILD_TIME}\`
`;
