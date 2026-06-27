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

### Convention-based configuration

d-pi uses directory-based convention over configuration. The workspace
root is marked by a \`.dpi/\` directory. Key conventions:

- \`agents/<name>/agent.ts\` — each subdirectory under \`agents/\` defines an agent.
  The agent.ts file uses \`defineAgent({...})\` with minimal fields (model, sources,
  parent, description). All other configuration is auto-discovered from
  subdirectories:
  - \`AGENTS.md\` → agent identity (loaded as system context)
  - \`skills/\` → agent-local skills (SKILL.md auto-discovered)
  - \`context/*.md\` → extra context (appended to system prompt)
  - \`tools/*.ts\` → custom tools (export default defineTool)
  - \`commands/*.ts\` → custom slash commands (export default defineCommand)
- \`models/<provider>/<model>.ts\` → model definitions, referenced by path string
  in agent.ts (e.g. \`model: "openai/gpt-4o"\`)
- \`sources/<name>/source.ts\` → external data sources (subprocesses that push
  messages). The directory name is the source key; the entry file must be
  named \`source.ts\`.
- \`context/*.md\` (workspace root) → shared context injected into every agent's
  system prompt.

### Source subscriptions

Sources are long-running subprocesses that push messages to subscribed agents.
Each source starts only when at least one agent subscribes to it, and stops
automatically when no agents are subscribed.

To subscribe to sources or change subscriptions:
1. Edit your \`agent.ts\` file and set the \`sources\` array (e.g. \`sources: ["timeout"]\`
   to subscribe, \`sources: []\` to unsubscribe from all).
2. Call the \`reload\` tool to apply the change. Subscriptions are replaced (not
   appended) on each reload.

When a source sends a message, you receive it as a user-like message with a
meta header indicating \`sourceType: "source"\` and \`sourceName\`. Messages from
connected users have \`sourceType: "connect"\`; messages from other agents have
\`sourceType: "agent"\` with \`agentName\`. Always check the meta header to
distinguish automated source pushes from direct user input.

### Reloading

- \`reload\` — reloads your own agent.ts configuration (model, sources, tools,
  commands, system prompt). Use after editing your agent.ts or context files.
- \`reload_workspace\` — rescans workspace-level resources (models, sources,
  context, skills). Changed source processes are restarted. After calling this,
  each agent must call \`reload\` individually to pick up new workspace context
  or model definitions.

If you need more information about d-pi behavior, or need to debug an
agent/runtime issue, inspect the d-pi source code in the repository.

d-pi build: commit=\`${DPI_BUILD_COMMIT}\`, built=\`${DPI_BUILD_TIME}\`
`;
