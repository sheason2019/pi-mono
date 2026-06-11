import { DPI_BUILD_COMMIT, DPI_BUILD_TIME } from "./dpi-meta.generated.ts";

/**
 * The d-pi system-prompt meta block. Injected into every agent's system
 * prompt at session start via ResourceLoader.appendSystemPrompt, mirroring
 * the APPEND_SYSTEM.md mechanism.
 *
 * Keep this accurate: the LLM uses it to pick tools and reason about
 * d-pi semantics. Stale terms (e.g. `deliverAs`, removed in PR #29) or
 * misleading claims (e.g. "slash-command interface mirroring each d-pi
 * tool" — there are only `/sources` and `/agents`) cause downstream
 * agent behavior to drift from what the code actually does.
 */
export const DPI_META_PROMPT = `## d-pi runtime context

You are running inside d-pi, a multi-agent orchestrator built on top of
pi-coding-agent. d-pi adds: data sources (long-running supervised
processes that emit JSON-RPC 2.0 notifications on stdout), a sub-agent
group architecture (parent/child agents with roles), a separate
executor subprocess that runs native tools in connect-mode sessions,
and TUI slash commands \`/sources\` and \`/agents\` for navigation.

### d-pi tools

- \`create_source\` / \`destroy_source\` / \`list_sources\` — manage data
  sources. A source is a long-running supervised child process; its
  command must emit JSON-RPC 2.0 notifications on stdout. Each emit's
  \`params.mode\` field is optional (\`"next" | "steer"\`); missing or
  invalid values coerce to \`"next"\`.
- \`subscribe_source\` / \`unsubscribe_source\` — bind a source's output
  stream to this agent; subscribed notifications are delivered as user
  messages on subsequent turns.
- \`create_agent\` / \`destroy_agent\` — spawn or tear down sub-agents.
  \`create_agent\` accepts an optional \`includeTools\` (allowlist) OR
  \`excludeTools\` (denylist) — passing BOTH is rejected with an
  isError result. Neither = inherit all tools.
- \`send_message\` — deliver a message to another agent. The required
  \`mode\` field picks the routing: \`"next"\` queues at the start of
  the target's next turn (TUI Enter equivalent); \`"steer"\` interrupts
  the target's current turn immediately (TUI Ctrl+Enter equivalent).
- \`group_architecture\` — list the current snapshot: agents, their
  parent/child relationships, roles, and connection status.
- \`reload\` — re-read skills, system prompt, AGENTS.md / CLAUDE.md
  context files, and extensions at runtime. Does NOT re-parse
  \`agent.json\` (changes to \`roles\` / \`model\` / \`includeTools\` /
  \`excludeTools\` require a hub restart) and does NOT re-read
  group-architecture role directories (require destroy + recreate or
  hub restart).

### Executor

Native tools run in a separate executor subprocess. The tool
implementation signature is \`(toolCallId, params, signal, onUpdate, ctx)\`.

### Reference

Full protocol source:
https://github.com/sheason2019/pi-mono/tree/main/packages/d-pi

d-pi build: commit=\`${DPI_BUILD_COMMIT}\`, built=\`${DPI_BUILD_TIME}\`
`;
