# Changelog

## [Unreleased]

### Fixed

- Fixed npm publish E422 due to missing `repository.url` (will be in v0.6.0-alpha.3)
- Fixed pre-existing 19+1 vitest false positives via `@sheason/*` alias in vitest config
- Fixed multiple inaccuracies in `DPI_META_PROMPT` (the system-prompt block injected into every d-pi agent): removed stale `deliverAs` term (renamed to `mode` in PR #29); corrected the misleading "slash-command interface mirroring each d-pi tool" claim (only `/sources` and `/agents` are registered); documented the `send_message` `mode: next | steer` semantics aligned with TUI Enter / Ctrl+Enter; documented the `create_agent` `includeTools` ↔ `excludeTools` mutex rule; documented `reload`'s limitation that it does not re-parse `agent.json` or group-architecture role directories; documented the executor tool implementation signature `(toolCallId, params, signal, onUpdate, ctx)`.

### Removed

- Dropped workspace-level (`WorkspaceConfig.includeTools` / `excludeTools`) tool allow/deny defaults. Tool access is now declared exclusively per agent in `agents/<name>/agent.json` (or via the `create_agent` tool call). The `?? workspaceConfig` fallback in `Hub.createAgent()` is gone; the agent-level value is the single source of truth.
- Dropped unused `WorkspaceConfig.defaultModel` field. The hub's model is sourced from the CLI `--model` flag (`HubConfig.model`), so the workspace-level field was never read. Only `version` remains in `WorkspaceConfig`, reserved as a migration marker.
