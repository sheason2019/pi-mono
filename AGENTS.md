# Development Rules

## Conversational Style

- Keep answers short and concise
- No emojis in commits, issues, PR comments, or code
- No fluff or cheerful filler text (e.g., "Thanks @user" not "Thanks so much @user!")
- Technical prose only, be direct
- When the user asks a question, answer it first before making edits or running implementation commands.
- When responding to user feedback or an analysis, explicitly say whether you agree or disagree before saying what you changed.

## Code Quality

- Read files in full before wide-ranging changes, before editing files you have not fully inspected, and when asked to investigate or audit. Do not rely on search snippets for broad changes.
- No `any` unless absolutely necessary.
- Inline single-line helpers that have only one call site.
- Check node_modules for external API types; don't guess.
- **No inline imports** (`await import()`, `import("pkg").Type`, dynamic type imports). Top-level imports only.
- Never remove or downgrade code to fix type errors from outdated deps; upgrade the dep instead.
- Use only erasable TypeScript syntax (Node strip-only mode) in code checked by the root config (`packages/*/src`, `packages/*/test`, `packages/coding-agent/examples`): no parameter properties, `enum`, `namespace`/`module`, `import =`, `export =`, or other constructs needing JS emit. Use explicit fields with constructor assignments.
- Always ask before removing functionality or code that appears intentional.
- Do not preserve backward compatibility unless the user asks for it.
- Never hardcode key checks (e.g. `matchesKey(keyData, "ctrl+x")`). Add defaults to `DEFAULT_EDITOR_KEYBINDINGS` or `DEFAULT_APP_KEYBINDINGS` so they stay configurable.
- Never modify `packages/ai/src/models.generated.ts` directly; update `packages/ai/scripts/generate-models.ts` instead, then regenerate. Including the resulting `models.generated.ts` diff is always OK, even if regeneration includes unrelated upstream model metadata changes.

## Source design

d-pi sources are loose, long-running commands that emit **JSON-RPC 2.0
notifications** on stdout, one per line. The hub parses every line
through `packages/d-pi/src/hub/source-validator.ts` and forwards only
`notification` shapes to subscribed agents — requests/responses are
silently dropped, invalid lines are logged to hub stderr and dropped.

Full design: `docs/superpowers/specs/2026-06-07-source-redesign-design.md`.

Quick reference for new sources:

- One JSON-RPC 2.0 notification per stdout line. Use `\n` (not `\r\n`).
- Required: `jsonrpc: "2.0"`, `method: "events.emit"`, `params.type`.
- Optional but standard: `params.id` (event id for ack/dedup), `params.data` (arbitrary payload), `params.deliverAs` (routing mode — see below).
- Notifications must NOT carry `id`, `result`, or `error` fields — those mark the message as a request/response and the hub will drop it.
- Anything that fails to parse is logged to hub stderr (`[d-pi source] Source "<name>" emitted invalid line: <reason> (truncated: <line>)`) and dropped. Sources must not crash on hub-side rejection — the hub catches validator throws and keeps the source alive.
- Sources can be written in Node / Python / Bash / Rust / anything. The hub only spawns the command (argv vector, no shell). For pipes / redirects / env vars, wrap in `sh -c`.
- Reference impls and wrappers for the bundled Lark sources live under `scripts/lark-source-formatter/` (notify.sh, health-notify.sh) and `packages/d-pi/src/sources/` (lark-im-shim.ts, lark-health-shim.ts). Use them as templates when adding a new source.

`params.deliverAs` routes the notification through the agent's `pi.sendMessage` to a specific executor endpoint. Three values, default `followUp`:

- `"steer"` — interrupt the agent's current turn and inject immediately. Use for urgent events where queueing would lose value (operator pokes, kill switches, security alerts).
- `"followUp"` — queue after the current turn finishes (default for most sources: lark chats, health reports, low-priority ambient data).
- `"prompt"` — same routing as `followUp` but flagged for tools that want to distinguish an explicit prompt from a passive follow-up. Sources that intentionally drive a turn (e.g. user-driven chat) should declare `prompt` instead of leaving it as default.

Unknown values (wrong case, wrong type, missing) coerce to `followUp` so a misbehaving source can never accidentally route to `steer`. Supervisor-error broadcasts (e.g. `[source-error] ...` lines) always use `followUp` regardless of source content — they are operational infra, not user-visible messages.

When adding a new source type, write its transform/shim as a separate
small executable (similar to the Lark shims) rather than embedding
JSON-RPC wrapping logic in whatever produces the raw output. Keeps each
piece testable in isolation.

## Commands

- After code changes (not docs): `npm run check` (full output, no tail). Fix all errors, warnings, and infos before committing. Does not run tests.
- Never run `npm run build` or `npm test` unless requested by the user.
- Never run the full vitest suite directly: it includes e2e tests that activate when endpoint/auth env vars are present. For all non-e2e tests, run `./test.sh` from the repo root. Otherwise run specific tests from the package root: `node ../../node_modules/vitest/dist/cli.js --run test/specific.test.ts`.
- If you create or modify a test file, run it and iterate on test or implementation until it passes.
- For `packages/coding-agent/test/suite/`, use `test/suite/harness.ts` + the faux provider. No real provider APIs, keys, or paid tokens.
- Put issue-specific regressions under `packages/coding-agent/test/suite/regressions/` named `<issue-number>-<short-slug>.test.ts`.
- For ad-hoc scripts, `write` them to a temp file (e.g. `/tmp`), run, edit if needed, remove when done. Don't embed multi-line scripts in `bash` commands.
- Never commit unless the user asks.

### Skipped tests

- `packages/d-pi/src/executor/client.ts:170` calls `process.exit(0)` on SSE end. The corresponding test in `packages/d-pi/test/executor-client.test.ts` is `it.skip`'d because vitest treats `process.exit` calls in child processes as unhandled errors. We rely on the OS to clean up the process (acceptable for SSE-end behavior; not worth the test infrastructure complexity).

## Dependency and Install Security

- Treat npm dep and lockfile changes as reviewed code. Direct external deps stay pinned to exact versions.
- Hydrate/update locally with `npm install --ignore-scripts`; clean/CI-style with `npm ci --ignore-scripts`. Don't run lifecycle scripts unless the user asks.
- If dep metadata changes, refresh `package-lock.json` with `npm install --package-lock-only --ignore-scripts`.
- If `packages/coding-agent/npm-shrinkwrap.json` needs regen, run `node scripts/generate-coding-agent-shrinkwrap.mjs` (verify with `--check` or `npm run check`). New deps with lifecycle scripts require review and an explicit allowlist entry in that script; never add one silently.
- Pre-commit blocks lockfile commits unless `PI_ALLOW_LOCKFILE_CHANGE=1`. Don't bypass unless the user wants the lockfile change committed.

## Git

Multiple pi sessions may be running in this cwd at the same time, each modifying different files. Git operations that touch unstaged, staged, or untracked files outside your own changes will stomp on other sessions' work. Follow these rules:

Committing:

- Only commit files YOU changed in THIS session.
- Stage explicit paths (`git add <path1> <path2>`); never `git add -A` / `git add .`.
- Before committing, run `git status` and verify you are only staging your files.
- `packages/ai/src/models.generated.ts` may always be included alongside your files.

Never run (destroys other agents' work or bypasses checks):

- `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash`, `git add -A`, `git add .`, `git commit --no-verify`.

If rebase conflicts occur:

- Resolve conflicts only in files you modified.
- If a conflict is in a file you did not modify, abort and ask the user.
- Never force push.

## Issues and PRs

See `CONTRIBUTING.md` for the contributor gate (auto-close workflows, `lgtm`/`lgtmi`, quality bar).

When reviewing PRs:

- Do not run `gh pr checkout`, `git switch`, or otherwise move the worktree to the PR branch unless the user explicitly asks.
- Use `gh pr view`, `gh pr diff`, `gh api`, and local `git show`/`git diff` against fetched refs to inspect PR metadata, commits, and patches without changing branches.
- If you need PR file contents, fetch/read them into temporary files or use `git show <ref>:<path>` without switching branches.

When creating issues:

- Add `pkg:*` labels for affected packages (`pkg:agent`, `pkg:ai`, `pkg:coding-agent`, `pkg:tui`); use all that apply.

When posting issue/PR comments:

- Write the comment to a temp file and post with `gh issue/pr comment --body-file` (never multi-line markdown via `--body`).
- Keep comments concise, technical, in the user's tone.
- End every AI-posted comment with the AI-generated disclaimer line specified by the originating prompt (e.g. `This comment is AI-generated by `/wr``).

When closing issues via commit:

- Include `fixes #<number>` or `closes #<number>` in the message so merging auto-closes the issue. For multiple issues, repeat the keyword per issue (`closes #1, closes #2`); a shared keyword (`closes #1, #2`) only closes the first.

## Testing pi Interactive Mode with tmux

Run the TUI in a controlled terminal (from the repo root):

```bash
tmux new-session -d -s pi-test -x 80 -y 24
tmux send-keys -t pi-test "./pi-test.sh" Enter
sleep 3 && tmux capture-pane -t pi-test -p     # capture after startup
tmux send-keys -t pi-test "your prompt here" Enter
tmux send-keys -t pi-test Escape               # special keys (also C-o for ctrl+o, etc.)
tmux kill-session -t pi-test
```

## Changelog

Location: `packages/*/CHANGELOG.md` (one per package).

Sections under `## [Unreleased]`: `### Breaking Changes` (API changes requiring migration), `### Added`, `### Changed`, `### Fixed`, `### Removed`.

Rules:

- All new entries go under `## [Unreleased]`. Read the full section first and append to existing subsections; never duplicate them.
- Released version sections (e.g. `## [0.12.2]`) are immutable; never modify them.

Attribution:

- Internal (from issues): `Fixed foo bar ([#123](https://github.com/earendil-works/pi-mono/issues/123))`
- External contributions: `Added feature X ([#456](https://github.com/earendil-works/pi-mono/pull/456) by [@username](https://github.com/username))`

## Releasing

**Lockstep versioning**: all packages share one version; every release updates all together. `patch` = fixes + additions, `minor` = breaking changes. No major releases.

1. **Update CHANGELOGs**: ask the user whether they ran the `/cl` prompt on the latest commit on `main`. If not, they must run `/cl` first to audit and update each package's `[Unreleased]` section before releasing.

2. **Local smoke test**: build an unpublished release and smoke test from outside the repo (so it can't resolve workspace files):
   ```bash
   npm run release:local -- --out /tmp/pi-local-release --force
   cd /tmp

   # Node package install smoke tests
   /tmp/pi-local-release/node/pi --help
   /tmp/pi-local-release/node/pi --version
   /tmp/pi-local-release/node/pi --list-models
   /tmp/pi-local-release/node/pi -p "Say exactly: ok"
   /tmp/pi-local-release/node/pi

   # Bun binary smoke tests
   /tmp/pi-local-release/bun/pi --help
   /tmp/pi-local-release/bun/pi --version
   /tmp/pi-local-release/bun/pi --list-models
   /tmp/pi-local-release/bun/pi -p "Say exactly: ok"
   /tmp/pi-local-release/bun/pi
   ```
   Verify both Node and Bun startup, model/account listing, interactive startup, and at least one real prompt with the intended default provider. The bare commands `/tmp/pi-local-release/node/pi` and `/tmp/pi-local-release/bun/pi` start interactive mode; run each in tmux, submit a prompt, and wait for the model reply before considering the interactive smoke test passed. Failures are release blockers unless the user explicitly accepts the risk.

3. **Run the release script**:
   ```bash
   PI_ALLOW_LOCKFILE_CHANGE=1 npm_config_min_release_age=0 npm run release:patch    # fixes + additions
   PI_ALLOW_LOCKFILE_CHANGE=1 npm_config_min_release_age=0 npm run release:minor    # breaking changes
   ```
   Use `npm_config_min_release_age=0` only for the release command. The repo's normal npm age gate can otherwise block the release lockfile refresh when the current workspace package version was published recently. Review any lockfile or shrinkwrap diffs the release creates before push.

   The release script bumps all package versions, updates changelogs, regenerates release artifacts, runs `npm run check`, commits `Release vX.Y.Z`, tags `vX.Y.Z`, adds fresh `## [Unreleased]` changelog sections, commits `Add [Unreleased] section for next cycle`, then pushes `main` and the tag. Do not rerun the release script after a tag was pushed.

4. **CI publishes npm packages**: pushing the `vX.Y.Z` tag triggers `.github/workflows/build-binaries.yml`. The `publish-npm` job uses npm trusted publishing through GitHub Actions OIDC with environment `npm-publish`; no local `npm publish`, `npm whoami`, OTP, or WebAuthn flow is required.

5. **If CI publish fails**: inspect the failed `publish-npm` job. The publish helper is idempotent and skips package versions already present on npm, so rerun the tag workflow after fixing CI or transient npm issues. Do not rerun `npm run release:patch` or `npm run release:minor` for the same version.

## Releasing d-pi (fork-specific)

`sheason2019/pi-mono` is a fork. **Five** packages under the `@sheason` npm scope are maintained here as forks of upstream pi-mono: `@sheason/pi-ai`, `@sheason/pi-tui`, `@sheason/pi-agent-core`, `@sheason/pi-coding-agent`, `@sheason/d-pi`. The docusaurus docs site at `packages/d-pi-official` is **not** part of the release pipeline and is deployed independently (Vercel / Cloudflare Pages / GitHub Pages) — tracked by a follow-up issue. The `## Releasing` section above describes the upstream-style flow that uses `npm run release:patch` / `release:minor` and `scripts/release.mjs` to bump versions across the lockstep set. `.github/workflows/release.yml` is the d-pi-tag-push trigger that does the actual publishing for this fork.

Workflow: `.github/workflows/release.yml`. Triggers on `v*` tag push or `workflow_dispatch` with a `tag` input. Three jobs:

1. `test` — `npm ci --ignore-scripts` + `npm run build` + `npm run check` + `npm test` (same as `ci.yml`).
2. `publish` (matrix over the five packages, **serial** via `max-parallel: 1`) — order is fixed by the dependency graph:
   1. `@sheason/pi-ai` (`packages/ai`)
   2. `@sheason/pi-tui` (`packages/tui`)
   3. `@sheason/pi-agent-core` (`packages/agent`)
   4. `@sheason/pi-coding-agent` (`packages/coding-agent`)
   5. `@sheason/d-pi` (`packages/d-pi`)

   Serial execution is required: downstream packages (pi-coding-agent, d-pi) read upstream `dist/` from the filesystem via `tsconfig` `paths`. Before the matrix runs, the job runs `npm run build` (root chain: `tui → ai → agent → coding-agent → d-pi`) so every package's `dist/` exists on disk for the matrix. Each matrix row then re-runs its own `npm run build` (idempotent) and resolves the npm `dist-tag` from the tag name (`v1.2.3` → `latest`, `v1.2.3-alpha.N` → `alpha`, `v1.2.3-beta.N` → `beta`, `v1.2.3-rc.N` → `rc`). The five publishable rows run `npm publish --access public --tag <tag> --provenance --ignore-scripts` (npm trusted publishing configured against `@sheason` org + `sheason2019/pi-mono` repo, environment `npm-publish`). Each row uploads its build output as a workflow artifact (`pkg-<name>`).
3. `github-release` — downloads the five build artifacts and creates a GitHub Release via `softprops/action-gh-release@v2` with auto-generated notes (`generate_release_notes: true`) and the `dist/` directories attached (`overwrite_files: true` + `fail_on_unmatched_files: false` for idempotent re-runs alongside the 6 platform binaries from `build-binaries.yml`).

Required secret on the fork repo (Settings → Secrets and variables → Actions):

- `NPM_TOKEN` — a single npm access token with **Automation** permission, publish scope limited to `@sheason`. Used for all five packages. The `id-token: write` permission is requested for npm provenance, which also requires configuring npm trusted publishing for the `@sheason` org against this repo (Settings → Environments → `npm-publish`).
- `GITHUB_TOKEN` is provided automatically; no extra token needed for the GitHub Release step.

Cut a release:

1. Bump versions in `packages/*/package.json` (all five packages stay lockstep on the d-pi version) and refresh the lockfile + shrinkwrap:
   ```bash
   # edit each packages/*/package.json by hand — do not use `npm version` (it would auto-tag)
   npm install --package-lock-only --ignore-scripts
   npm run shrinkwrap:coding-agent
   ```
2. Commit and push to `main`:
   ```bash
   git commit -m "chore(release): bump version to <X>"
   git push origin main
   ```
3. Tag and push (triggers `.github/workflows/release.yml`):
   ```bash
   git tag -a v<X> -m "Release v<X>" <commit-sha>
   git push origin v<X>
   ```
4. CI runs `test` → `publish` (five matrix rows, serial) → `github-release`. `.github/workflows/release.yml` is the **only** publishing path on the fork: `.github/workflows/build-binaries.yml` still runs on `v*` tag push for the binary artifacts, but its `publish-npm` job has been removed to avoid double-publishing. The upstream `## Releasing` section above remains the source of truth for the bump/commit/tag ritual.

## User Override

If the user's instructions conflict with any rule in this document, ask for explicit confirmation before overriding. Only then execute their instructions.
