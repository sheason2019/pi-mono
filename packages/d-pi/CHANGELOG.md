# Changelog

## [0.6.0-alpha.4] - 2026-06-11

### Removed

- Dropped the `github-release` job (and the `Upload build artifacts` step) from `.github/workflows/release.yml`. The d-pi release pipeline now ends at npm publish; the GitHub release page (with downloadable dist/ artifacts) is out of scope for this fork. softprops/action-gh-release was tripping GitHub's secondary rate limit on artifact upload, which caused the workflow's last job to fail even though the publish step had already succeeded — making the run look failed when it wasn't. The npm publish + OIDC trusted publishing flow is the only thing that needs to succeed for a release to be useful, and that path is unaffected. If we ever want release-page artifacts back, the right path is the cross-platform binary workflow (`.github/workflows/build-binaries.yml`) wiring its outputs into a release, not the npm publish job uploading its own dist/.

### Changed

- **Release pipeline only ships `@sheason/*` packages.** `scripts/publish.mjs`, `scripts/local-release.mjs`, and `.github/workflows/release.yml` no longer reference the upstream `@earendil-works/pi-{ai,tui,agent-core}` packages. The d-pi release matrix now publishes exactly two npm packages: `@sheason/pi-coding-agent` and `@sheason/d-pi`. The three upstream packages remain runtime dependencies (pulled from the public npm registry at install time) and are still built in CI to satisfy the workspace tsconfig paths, but they are not packed, not published, and not attached to the release. The d-pi lockstep `-sheason.<d-pi-version>` suffix on `@sheason/pi-coding-agent` is preserved (it documents the fork's pairing with `@sheason/d-pi`) but is no longer asserted at publish time, since each `@sheason/*` package can now be released on its own cadence. We have no npm publish permission to the `@earendil-works` scope, so this change is what makes the next d-pi release publishable at all.

### Fixed

- Source `stderr` is no longer forwarded to subscribed agents. Previously every stderr line from a source subprocess was wrapped as `[stderr] <line>` and pushed as a "source message", flooding agents with subprocess chatter (e.g. `lark-cli` ready markers, heartbeats). Now stderr is logged to the d-pi supervisor's own stderr only; the JSON-RPC boundary is the only thing agents see. Pairs with the per-source `forwardStderr: true` opt-in (future) if a source genuinely needs stderr surfaced to its agent.
- Fixed npm publish E422 due to missing `repository.url` (will be in v0.6.0-alpha.3)
- Fixed pre-existing 19+1 vitest false positives via `@sheason/*` alias in vitest config
- Fixed multiple inaccuracies in `DPI_META_PROMPT` (the system-prompt block injected into every d-pi agent): removed stale `deliverAs` term (renamed to `mode` in PR #29); corrected the misleading "slash-command interface mirroring each d-pi tool" claim (only `/sources` and `/agents` are registered); documented the `send_message` `mode: next | steer` semantics aligned with TUI Enter / Ctrl+Enter; documented the `create_agent` `includeTools` ↔ `excludeTools` mutex rule; documented `reload`'s limitation that it does not re-parse `agent.json` or group-architecture role directories; documented the executor tool implementation signature `(toolCallId, params, signal, onUpdate, ctx)`.
- Architectural fix for `DPI_META_PROMPT`: tool listings, per-tool constraints, and routing semantics are no longer duplicated in the system prompt — they live on each tool's `description` / JSON schema instead (visible to the LLM via the tools API). Moved the `includeTools` ↔ `excludeTools` mutex info into the `create_agent` schema field descriptions and the reload limitations into the `reload` tool description. `DPI_META_PROMPT` now contains only high-level context + build metadata. Added `test/tool-descriptions.test.ts` to lock in the per-tool constraint descriptions (8 new assertions), and tightened `test/dpi-meta.test.ts` to assert the prompt stays lean (no tool names, no slash commands, no executor signature, no per-tool constraints).

### Removed

- Dropped workspace-level (`WorkspaceConfig.includeTools` / `excludeTools`) tool allow/deny defaults. Tool access is now declared exclusively per agent in `agents/<name>/agent.json` (or via the `create_agent` tool call). The `?? workspaceConfig` fallback in `Hub.createAgent()` is gone; the agent-level value is the single source of truth.
- Dropped unused `WorkspaceConfig.defaultModel` field. The hub's model is sourced from the CLI `--model` flag (`HubConfig.model`), so the workspace-level field was never read. Only `version` remains in `WorkspaceConfig`, reserved as a migration marker.
