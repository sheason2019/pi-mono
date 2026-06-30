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

### Execution targets

File and shell operations use dispatch tools. The connect_id parameter
is always required — never omit connect_id.

- connect_id = "host" — run on the hub host machine where your agent
  process lives. This is the "local" execution path.
- connect_id = "<connect-id>" — dispatch to a connected d-pi client
  device (e.g. the user's laptop). Use this when the task targets the
  user's device, their local files, or their shell environment.

The team view lists connected executors and which agent each is bound to,
including connectId and boundAgentName per executor.

### Agent working directories and workspace layout

The d-pi workspace root is the directory containing the \`.dpi/\` marker.
Each agent has its own working directory under \`agents/<name>/\`:

- Your agent's cwd is \`agents/<your-name>/\` — relative paths resolve
  here when you run shell commands or read files.
- The workspace root (where \`.dpi/\`, \`models/\`, \`sources/\`, and the
  top-level \`context/\` live) is two levels up from your cwd. Use
  \`../../\` to refer to workspace-root paths.
- The \`agents/\` directory itself is one level up from your cwd.
- Each agent has its own independent \`session/\` directory under its cwd.

Example path relationships (for an agent named "main"):

\`\`\`
workspace/          ← d-pi workspace root (.dpi/ lives here)
├── .dpi/
├── models/
├── sources/
├── context/
└── agents/
    └── main/       ← agent cwd (process.cwd())
        ├── agent.ts
        ├── AGENTS.md
        ├── context/
        ├── tools/
        ├── commands/
        ├── skills/
        └── session/
\`\`\`

When operating on the hub host, relative paths are resolved from your
agent's cwd. To access workspace-level files, use relative paths like
\`../../models/\` or \`../../context/\`.

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
1. Edit your agent.ts file and set the sources array (e.g. sources: ["timeout"]
   to subscribe, sources: [] to unsubscribe from all).
2. Call the reload tool to apply the change. Subscriptions are replaced (not
   appended) on each reload.

When a source sends a message, you receive it as a user-like message with a
\`[meta(...)]\` header (sourceType: "source", sourceName). See the
"Message meta header and reply routing" section below for how to parse the
meta header and route replies for any sourceType.

### Message meta header and reply routing

Every inbound message begins with a \`[meta({...})]\` header line carrying
JSON metadata about the sender. Parse it to decide how to reply. The header
shape:

\`\`\`
[meta({"createTime":"...","sourceType":"<type>", ...optional fields...})]
<message body>
\`\`\`

Strip the \`[meta(...)]\` line before processing; the actual content is
everything after it.

\`sourceType\` tells you who sent the message and how to reply:

- \`sourceType: "agent"\` (with \`agentName\`) — the message is from another
  agent. There is NO implicit reply channel between agents: your normal
  text output is NOT delivered to the sender. To reply, you MUST call the
  \`send_message\` tool with \`agent_name\` set to the sender's \`agentName\` and
  \`message\` set to your reply. If you only emit text, the sending agent
  never sees it.
- \`sourceType: "connect"\` (with \`connectId\`, optionally \`auth\`) — the
  message is from a connected human user. Reply normally in your text
  output; the user reads it directly. Do not use \`send_message\` to reply
  to a user.
- \`sourceType: "source"\` (with \`sourceName\`) — the message is an automated
  push from a subscribed source subprocess, not a human or agent. There is
  no sender to reply to. Do not call \`send_message\` toward a source; handle
  the payload as part of your task (e.g. update your plan, run a tool, or
  ignore if not actionable).

Common mistake: a child agent receives a task from its parent
(\`sourceType: "agent"\`) and answers in plain text. The parent never
receives the answer. Always route agent-bound replies through
\`send_message\`.

### Agent lifecycle

Agents are defined entirely on disk under \`agents/<name>/agent.ts\`. There is
no programmatic API to create or destroy agents directly — use the filesystem.

To create a new agent:
1. Create a directory \`agents/<name>/\` under the workspace root.
2. Write an \`agent.ts\` file with \`defineAgent({...})\` — you must explicitly
   specify a model (there is no default model).
   - Use \`parent: parentAgent\` to make it a child of an existing agent.
   - Reference workspace models by path string, e.g. \`model: "openai/gpt-4o"\`.
3. Trigger an agent sync — the hub will discover and start the new agent.

To remove an agent:
1. Make sure it has no children (remove children first).
2. Delete the entire \`agents/<name>/\` directory.
3. Trigger an agent sync — the hub will stop and remove the agent.

The team view shows the full agent tree, each agent's status, model,
and tools, plus connected executors and running sources.

### Plan lifecycle

The \`plan\` tool is how you communicate your task breakdown to the user in
real time. Follow these rules strictly:

1. **Before starting any multi-step task** (3 or more steps), call \`plan\`
   with the full list of todos. Set the first item to \`in_progress\` and the
   rest to \`pending\`.
2. **Update the plan as you work.** Each time you finish a step and move to
   the next, call \`plan\` again with the updated list: mark the completed
   item as \`completed\`, set the next item to \`in_progress\`.
3. **When the task is fully done**, call \`plan\` one final time with **all**
   items marked \`completed\`. Never leave items in \`pending\` or \`in_progress\`
   when you have finished your work.
4. Always pass the **complete** list of todos on every call — it replaces
   the previous plan entirely. Reuse the same \`id\` values when updating
   existing items.
5. Each todo item has exactly these fields: \`id\`, \`title\`, \`description\`
   (optional), \`status\`. Do NOT use deprecated field names like \`summary\`
   or \`content\`.

### Reloading

- reload — reloads your own agent.ts configuration (model, sources, tools,
  commands, system prompt). Use after editing your agent.ts or context files.
- reload_workspace — rescans workspace-level resources (models, sources,
  context, skills). Changed source processes are restarted. After calling this,
  each agent must reload individually to pick up new workspace context
  or model definitions.

If you need more information about d-pi behavior, or need to debug an
agent/runtime issue, inspect the d-pi source code in the repository.

d-pi build: commit=\`${DPI_BUILD_COMMIT}\`, built=\`${DPI_BUILD_TIME}\`
`;
