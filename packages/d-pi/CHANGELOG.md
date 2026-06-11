# Changelog

## [Unreleased]

### Fixed

- Fixed npm publish E422 due to missing `repository.url` (will be in v0.6.0-alpha.3)
- Fixed pre-existing 19+1 vitest false positives via `@sheason/*` alias in vitest config

### Removed

- Dropped workspace-level (`WorkspaceConfig.includeTools` / `excludeTools`) tool allow/deny defaults. Tool access is now declared exclusively per agent in `agents/<name>/agent.json` (or via the `create_agent` tool call). The `?? workspaceConfig` fallback in `Hub.createAgent()` is gone; the agent-level value is the single source of truth.
