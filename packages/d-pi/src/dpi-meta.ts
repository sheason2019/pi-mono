import { DPI_BUILD_COMMIT, DPI_BUILD_TIME } from "./dpi-meta.generated.ts";

/**
 * The d-pi system-prompt meta block. Injected into every agent's system
 * prompt at session start via ResourceLoader.appendSystemPrompt, alongside
 * workspace context/*.md and agent AGENTS.md.
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

d-pi is the agent base you are currently running on. It allows
multiple long-lived agents to run as a team, and provides an executor
capability for running commands remotely through a connected client.

File and shell operations use dispatch tools. By default, omit
connect_id so commands run on the hub host where your agent process
lives. Only provide connect_id when the user explicitly asks you to
operate on a connected client device.

If you need more information about d-pi behavior, or need to debug an
agent/runtime issue, inspect the d-pi source code in the repository.

d-pi build: commit=\`${DPI_BUILD_COMMIT}\`, built=\`${DPI_BUILD_TIME}\`
`;
