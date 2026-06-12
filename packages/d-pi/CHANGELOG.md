# Changelog

## [Unreleased]

### Added

- **Source persistence: sources survive hub restart.** Previously, every `d-pi serve` start ran with an empty `SourceManager` — any source registered via `create_source` (lark-bridge, webhooks, `tail -f`, ...) was lost the moment the hub exited. Sources are now persisted to `sources/<name>/source.json` on the workspace root, with the same lifecycle semantics as `agents/<name>/agent.json`:
  - `create_source` writes the file (idempotent overwrite).
  - `subscribe_source` / `unsubscribe_source` /
    `removeAgentSubscriptions` rewrite the file with the new
    subscribers set (the subscribers list is now persisted, not
    just the config).
  - `destroy_source` removes the file before tearing down the
    in-memory record.
  - On `Hub.start()`, after the agent registry is fully restored,
    `Hub._restorePersistedSources` calls
    `SourceManager.restoreFromConfigs` which reads every
    `source.json`, re-spawns the subprocess, and re-attaches to
    every persisted subscriber that is still alive in the registry.
    Persisted subscribers whose agent is no longer live are
    silently dropped (the source's creator and the source
    process itself can outlive the agents that once subscribed
    to it; the operator can re-subscribe via `subscribe_source`
    if needed).
  - If an operator pre-registers a source with the same name
    during a session (via the runtime `create_source` tool),
    the persisted entry is skipped on restore — the runtime
    source wins, since it has the live creator's actual config.
  - Corrupt or unreadable `source.json` files are skipped with
    a stderr warning; the hub continues to start with whatever it
    can recover. The unit tests in `test/source-persistence.test.ts`
    cover round-trip, delete, skip-on-corrupt, subscribe/unsubscribe
    writes, destroy-on-disk removal, and the live-only-on-restore
    subscriber rehydration logic (12 cases, all under 20ms).

### Changed

- **Agent identity refactored: names are now the unique key, UUIDs are gone.** Previously, every agent had a generated `id` (UUID) AND a `name`, with the registry map keyed by `id` and parent/children cross-references also stored as `id`s. This required a parallel indirection: persisted `agent.json` already used `parentName` (because the existing restore code had to bridge the disk format back to a fresh in-memory `id`), and the meta header carried both `agentId` and `agentName` for the same agent. With names unique by project invariant, the UUIDs were dead weight. The refactor drops the `id` field from `AgentRecord` entirely and keys the registry map by `name`; `parentId` becomes `parentName`, `creatorAgentId` becomes `creatorName`, the `MessageMeta.agentId` field becomes `MessageMeta.agentName`, the `HubToWorkerMessage.fromAgentId` becomes `fromAgentName`, and `WorkerToHubMessage`'s `agentId` fields become `agentName`. `createAgent` now returns `{ agentName }` (no separate `id`). The on-disk `agent.json` shape is unchanged (it already used `parentName`), so no migration is required for existing persisted agents. The bind/unbind endpoint URL pattern (`/_hub/agents/{name}/bind`) already used the agent's name, just the variable name in the gateway was renamed for clarity. Tool-side: `send_message(agent_id=...)` and `destroy_agent(agent_id=...)` now take the agent's name (the only valid identifier); the previous "name or id" fallback that looked up by `getByName` after a miss is removed because it is no longer reachable (names are the only key). All 201 d-pi vitest cases + 1412 coding-agent vitest cases pass.

## [0.6.0-alpha.5] - 2026-06-12

### Changed

- **`DPI_META_PROMPT` now teaches multi-agent orchestration principles.** Three new sections after the existing "d-pi runtime context" header: (1) **Multi-agent behavior** — each agent is a long-lived node in a larger tree, not a one-shot tool call; inbound messages may interleave with in-flight work, so the agent must identify which task a new message belongs to, who is asking, and whether in-flight work should be paused / combined / abandoned. (2) **Collaboration** — agents should proactively push results to peers that are waiting, ask for input rather than guess, and use `group_architecture` to discover who else is alive (names, ids, parent/child relationships, statuses) before reaching out. (3) **Latency and freshness** — multi-agent dispatch is not real-time; each inbound message's `[meta(...)]` header records the `createTime` of when the message was originally produced, not when it reached the agent; a message you just received may describe a state from minutes or hours ago, so agents must check `createTime` against their session timeline before acting on implied-current-state assertions. Per the existing `test/dpi-meta.test.ts` architectural-contract tests, the new sections contain no backticked tool names, no per-tool constraints (mutex / mode / executor signature), and no TUI-keyboard-vocabulary leaks — they are pure architectural guidance.
- **`agent.json` contents are now injected into every agent's system prompt as a `## Agent identity` section.** The worker reads its own `cwd/agent.json` at session start and appends a formatted block to the `appendSystemPrompt` array (between the workspace-level `APPEND_SYSTEM.md` and the in-source `DPI_META_PROMPT`, so the d-pi runtime meta stays anchored at the end of the system prompt). The block enumerates every `AgentConfig` field the LLM should be able to refer to: `name`, the new optional `description` (free-form prose about who the agent is and when to delegate to it), `parentName`, `roles`, `model`, `sessionId`, and the tool allow/deny list (`includeTools` xor `excludeTools`). `null` parent and empty arrays are omitted rather than rendered as `(unset)`, so the LLM never learns false defaults. New `AgentConfig.description?: string` field; the init template writes `description: ""` by default and the workspace `AGENTS.md` template documents it. New module `packages/d-pi/src/hub/agent-identity.ts` with pure read + format helpers (testable in 7 ms without spawning a worker). Per the user's note, `agent.json` is not expected to change often, so cache invalidation on identity changes is acceptable.

### Fixed

- Source-triggered messages (e.g. from the lark bridge via `events.emit`) now wake an idle agent. The d-pi worker extension's `channel.onIncomingMessage` and TUI `input` handlers now pass `triggerTurn: true` on every `pi.sendMessage(...)` call. Previously, a source message with `mode: "steer"` was forwarded with `{ deliverAs: "steer" }` only; `sendCustomMessage` in the agent's session would then queue the message only if the agent was already streaming, and for an idle agent the message would land as a bare session entry without ever prompting the agent. `deliverAs` is still set to `"steer"` when the source-declared mode is `"steer"`, so busy agents still get the correct queueing behavior (steer vs followUp). The TUI input path (the `enter` vs `alt+enter` keyboard vocabulary) is fixed the same way.
- **Hub restore is now order-deterministic, so child agents stop appearing as orphans at the same depth as their parent.** The previous restore path iterated `agents/` in raw `readdirSync` order, which is filesystem-dependent (e.g. on macOS HFS+/APFS the order is insertion / case-insensitive / locale-dependent). If a child's `agent.json` was read before its parent's, `getByName(parentName)` returned `undefined` and the child was created as an orphan — the bug the user reported, where `llm-wiki` showed up at the same depth as `root` in the TUI's "Switch to agent" selector. The fix lives in a new `packages/d-pi/src/hub/restore-agents.ts` module exporting `discoverPersistedAgents` and `orderAgentsForRestore`; `_restorePersistedAgents` now collects every `agent.json` first, computes each entry's parent-chain depth, then processes them in depth order (root first, then depth 1, etc.) so a child's `parentName` is always resolvable. Cycle detection on the parent chain (e.g. A's parent is B and B's parent is A) treats the offender as an orphan and logs a stderr warning rather than crashing the hub. `Hub.createAgent` gains a defensive check that throws if a non-undefined `parentAgentId` does not resolve to a registry entry — a third-line guard against in-process callers passing stale or fabricated ids. The `create_agent` tool description now spells out the design intent: "the new agent will be a direct child of this agent (the caller) ... never a sibling, never a grandchild, never an orphan."

## [0.6.0-alpha.4] - 2026-06-11

### Changed

- **Release pipeline only ships `@sheason/*` packages.** `scripts/publish.mjs`, `scripts/local-release.mjs`, and `.github/workflows/release.yml` no longer reference the upstream `@earendil-works/pi-{ai,tui,agent-core}` packages. The d-pi release matrix now publishes exactly two npm packages: `@sheason/pi-coding-agent` and `@sheason/d-pi`. The three upstream packages remain runtime dependencies (pulled from the public npm registry at install time) and are still built in CI to satisfy the workspace tsconfig paths, but they are not packed, not published, and not attached to the GitHub release artifacts. The d-pi lockstep `-sheason.<d-pi-version>` suffix on `@sheason/pi-coding-agent` is preserved (it documents the fork's pairing with `@sheason/d-pi`) but is no longer asserted at publish time, since each `@sheason/*` package can now be released on its own cadence. We have no npm publish permission to the `@earendil-works` scope, so this change is what makes the next d-pi release publishable at all.

### Fixed

- Source `stderr` is no longer forwarded to subscribed agents. Previously every stderr line from a source subprocess was wrapped as `[stderr] <line>` and pushed as a "source message", flooding agents with subprocess chatter (e.g. `lark-cli` ready markers, heartbeats). Now stderr is logged to the d-pi supervisor's own stderr only; the JSON-RPC boundary is the only thing agents see. Pairs with the per-source `forwardStderr: true` opt-in (future) if a source genuinely needs stderr surfaced to its agent.
- Fixed npm publish E422 due to missing `repository.url` (will be in v0.6.0-alpha.3)
- Fixed pre-existing 19+1 vitest false positives via `@sheason/*` alias in vitest config
- Fixed multiple inaccuracies in `DPI_META_PROMPT` (the system-prompt block injected into every d-pi agent): removed stale `deliverAs` term (renamed to `mode` in PR #29); corrected the misleading "slash-command interface mirroring each d-pi tool" claim (only `/sources` and `/agents` are registered); documented the `send_message` `mode: next | steer` semantics aligned with TUI Enter / Ctrl+Enter; documented the `create_agent` `includeTools` ↔ `excludeTools` mutex rule; documented `reload`'s limitation that it does not re-parse `agent.json` or group-architecture role directories; documented the executor tool implementation signature `(toolCallId, params, signal, onUpdate, ctx)`.
- Architectural fix for `DPI_META_PROMPT`: tool listings, per-tool constraints, and routing semantics are no longer duplicated in the system prompt — they live on each tool's `description` / JSON schema instead (visible to the LLM via the tools API). Moved the `includeTools` ↔ `excludeTools` mutex info into the `create_agent` schema field descriptions and the reload limitations into the `reload` tool description. `DPI_META_PROMPT` now contains only high-level context + build metadata. Added `test/tool-descriptions.test.ts` to lock in the per-tool constraint descriptions (8 new assertions), and tightened `test/dpi-meta.test.ts` to assert the prompt stays lean (no tool names, no slash commands, no executor signature, no per-tool constraints).

### Removed

- Dropped workspace-level (`WorkspaceConfig.includeTools` / `excludeTools`) tool allow/deny defaults. Tool access is now declared exclusively per agent in `agents/<name>/agent.json` (or via the `create_agent` tool call). The `?? workspaceConfig` fallback in `Hub.createAgent()` is gone; the agent-level value is the single source of truth.
- Dropped unused `WorkspaceConfig.defaultModel` field. The hub's model is sourced from the CLI `--model` flag (`HubConfig.model`), so the workspace-level field was never read. Only `version` remains in `WorkspaceConfig`, reserved as a migration marker.
