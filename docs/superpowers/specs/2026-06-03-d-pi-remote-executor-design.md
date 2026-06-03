# d-pi Remote Executor — Design

**Date**: 2026-06-03
**Status**: Draft (pending design approval)
**Package scope**: `packages/d-pi/` only. `packages/coding-agent/` is **not modified**.

## Context

d-pi orchestrates multiple agents in a hub-and-spoke topology. Today, d-pi
agents (running in serve-mode workers on the hub) cannot run file-system
or shell operations on the **client's** machine — every tool execution
happens wherever the worker is spawned.

We want d-pi agents to be able to run read/ls/grep/find/bash/write/edit
on the user's local machine, transparently and synchronously, using the
client's existing connect session as the conduit.

## Goal

When the user runs `d-pi connect` against a d-pi serve:

1. A new **executor** subprocess is spawned alongside the existing
   pi connect child. The executor carries pi's native tools
   (read, ls, grep, find, bash, write, edit) on the user's machine.
2. The executor registers itself with the d-pi serve using the
   connect session's id.
3. The d-pi agent worker (in serve mode) loads an inline extension
   that exposes a `remote_*` tool set mirroring the native tools.
4. When the d-pi agent calls `remote_bash(...)`, the call is routed
   by d-pi serve to the executor, which runs the tool locally and
   returns the result synchronously to the agent.

Tool behavior, parameters, and result shape are **identical** to the
native tools — no special confirmation prompts, no schema translation.

## Architecture

```
┌──────────────────────────── client machine ────────────────────────────┐
│                                                                       │
│  d-pi connect (parent, this process)                                  │
│  ├── spawn #1: pi connect child (TUI, runs runConnectMode)           │
│  │           → RemoteAgentSessionProxy                                │
│  │                                                                  │
│  └── spawn #2: executor (independent subprocess)                     │
│              env: { DPI_HUB_URL, DPI_AUTH_TOKEN, DPI_CONNECT_ID,     │
│                      DPI_CWD }                                       │
│              cwd = d-pi connect parent's cwd                          │
│                                                                       │
└───────────────────────────────────────────────────────────────────────┘
                              │
                              │ HTTP: register  ─┐
                              │ SSE:  subscribe  ─┼─► d-pi serve
                              │ POST: result     ─┘
                              ▼
┌──────────────────────────── d-pi serve ───────────────────────────────┐
│                                                                       │
│  Hub                                                                  │
│  ├── 维护 executor registry: connect_id → { sseConn, pendingCalls } │
│  └── spawn: agent worker (每个 agent 一个, serve mode)              │
│                                                                       │
│  agent worker (pi serve mode)                                         │
│  └── 加载 inline extension (d-pi 包内置, 路径由 hub 注入)            │
│      → 注册 7 个 remote_* 工具                                        │
│                                                                       │
└───────────────────────────────────────────────────────────────────────┘
```

## Components

### 1. executor (new module in `packages/d-pi/src/executor/`)

A standalone Node.js subprocess. Imports tool definitions from
`@sheason/pi-coding-agent` (using its public exports — no coding-agent
source changes required).

- `index.ts` — entry point; reads env vars; orchestrates the lifecycle.
- `runner.ts` — invokes a native tool by name with the given params.
- `client.ts` — talks to d-pi serve: register, SSE subscribe, POST result.
- `cli.ts` — `d-pi executor` subcommand (debug / standalone usage; not
  the primary entry — d-pi connect parent spawns the executor
  programmatically, but having a CLI helps testing).

Tool registration uses `defineTool` from
`@sheason/pi-coding-agent` so the executor's tool set is bit-identical
to the agent's native tool set.

### 2. d-pi serve hub extensions (modify `packages/d-pi/src/hub/gateway.ts`)

Three new endpoints, all behind the existing connect auth (Bearer token):

- `POST /_hub/executor/register` — body: `{ connectId, cwd }`. Validates
  the connect id is not already registered. Stores the SSE connection
  handle and cwd. Responds `200 { ok: true }` or `409` on conflict.
- `GET /_hub/executor/events?connectId=...` — SSE stream. Hub pushes
  events of type `remote-call` with payload
  `{ callId, tool, params }`.
- `POST /_hub/executor/results` — body:
  `{ connectId, callId, ok: true, result }` or
  `{ connectId, callId, ok: false, error }`. Hub looks up the pending
  HTTP response for that `callId` and resolves it.

Internal: `executorRegistry: Map<connect_id, { sseConn, cwd, pendingCalls: Map<callId, httpRes> }>`.

Also a new endpoint for the worker's inline extension:

- `POST /agents/{agentId}/remote-call` — body: `{ callId, tool, params }`.
  Resolves `agentId → connectId` (via the existing agent→connect
  binding maintained by d-pi connect), looks up the executor, sends
  an SSE event, then blocks the HTTP response until
  `pendingCalls.get(callId)` is resolved by the executor's result POST.
  Resolves with the same `{ ok, result | error }` shape.

### 3. Inline extension for agent worker (new file `packages/d-pi/src/agent-extension/remote-tools.ts`)

A regular pi extension (TypeScript file, loaded by the worker from
`extensionPaths` in the session). Uses `defineTool` from
`@sheason/pi-coding-agent` to register 7 tools:

- `remote_bash` — params and result identical to native `bash`
- `remote_read` — params and result identical to native `read`
- `remote_ls` — params and result identical to native `ls`
- `remote_grep` — params and result identical to native `grep`
- `remote_find` — params and result identical to native `find`
- `remote_write` — params and result identical to native `write`
- `remote_edit` — params and result identical to native `edit`

Each tool's implementation:

1. Generate a `callId` (UUID).
2. `POST` `/agents/{agentId}/remote-call` to the hub (hub URL from env
   `DPI_HUB_URL`; auth from `DPI_AUTH_TOKEN`).
3. Await the response. If `ok: true`, return the result. If
   `ok: false`, throw an `Error` whose message is the hub's error
   payload (matching the shape the LLM would see from a failed native
   tool call).

The d-pi serve hub sets the extension path on the worker when
spawning it. The worker already loads extensions from
`session.extensionPaths` — no new mechanism required.

### 4. d-pi connect parent (modify `packages/d-pi/src/cli-runner.ts`)

After the auth handshake and before spawning the `d-pi _connect-child`,
the d-pi connect parent spawns the executor as a child process. The
executor inherits the connect id, auth token, and cwd via env vars
(`DPI_HUB_URL`, `DPI_AUTH_TOKEN`, `DPI_CONNECT_ID`, `DPI_CWD`).

If the executor fails to start (exits non-zero immediately), d-pi
connect logs a warning and **continues** the connect flow — the
remote tools are best-effort; the user can still use the local-mode
native tools on the client.

## Protocol

### Connect time

```
d-pi connect parent
  ├── (existing) auth handshake → connect_id + auth_token
  ├── spawn executor (env = above)
  │
  executor
  └── POST /_hub/executor/register
        Authorization: Bearer {token}
        { connectId, cwd }
        → 200 { ok: true }
  └── GET /_hub/executor/events?connectId=...   (SSE)
        Authorization: Bearer {token}
        → 200 text/event-stream
```

### Tool call (synchronous)

```
worker (LLM calls remote_bash):
  const callId = uuid();
  POST /agents/{agentId}/remote-call
    Authorization: Bearer {token}
    { callId, tool: "bash", params: { command: "ls -la" } }
    → 200 (blocked until executor returns)
    ← { ok: true, result: { output: "...", exitCode: 0 } }
```

Internally the hub:

1. Resolves `agentId → connectId`.
2. Looks up `executorRegistry.get(connectId)`.
3. Stores `pendingCalls.set(callId, httpRes)`.
4. Sends SSE event `remote-call` with
   `{ callId, tool, params }` to the executor.
5. Awaits the resolution of `pendingCalls.get(callId).resolve(...)`.

### Executor side

```
executor (SSE listener):
  on event 'remote-call':
    try:
      const result = await runner.run(tool, params);
      POST /_hub/executor/results
        Authorization: Bearer {token}
        { connectId, callId, ok: true, result }
    catch err:
      POST /_hub/executor/results
        { connectId, callId, ok: false, error: err.message }
```

## Meta change

Current meta renders as `connect` in messages sent via d-pi
connect. The user wants the rendered form to become
`connect <connect_id>` so multiple concurrent connect sessions are
distinguishable.

Changes (all in `packages/d-pi/src/extension/message-meta.ts`):

- `MessageMeta` schema gains an optional `connectId: string` field,
  populated only when `sourceType === "connect"`.
- `injectMeta(text, "connect", auth, options)` now also accepts
  `connectId` in options and writes it into the meta.
- The message renderer combines the two: displays
  `connect <connect_id>` when present, falls back to plain `connect`
  when absent.

The client pi does not need to know about this change — it just
renders the meta text the d-pi extension provides. No coding-agent
changes.

## Lifecycle

| Event | Behavior |
|---|---|
| `d-pi connect` starts | Spawn executor before spawning pi connect child |
| `d-pi connect` exits normally | SIGTERM the executor; wait up to 5s; SIGKILL if needed |
| `d-pi connect` crashes (uncaught exception) | OS / child_process default sends SIGHUP to executor; executor detects broken pipe → exits |
| `d-pi connect` runs `/agents` (agent switch) | **Executor does NOT restart** — cwd is unchanged, executor state survives across agent switches on the same client. Only restart on full d-pi connect exit/relaunch. |
| Executor crashes | stderr warning from d-pi connect; executor deregisters; subsequent `remote_*` calls return "Executor not available" |

## Error handling

### Hub

| Scenario | Response |
|---|---|
| `POST /_hub/executor/register` with already-registered connect_id | 409 `{ error: "Connect id already registered" }` |
| `GET /_hub/executor/events` with bad/unknown connect_id | 404 |
| SSE connection drops (executor crash / network) | Deregister connect_id; resolve all pending calls with `Error("Executor disconnected")` |
| `POST /_hub/executor/results` with unknown callId | 200 OK + stderr warn (drop) |
| `POST /agents/{id}/remote-call` with non-existent agent | 404 |
| `POST /agents/{id}/remote-call` but agent not bound to a connect session | 409 `{ error: "Agent not in connect mode" }` |
| `POST /agents/{id}/remote-call` but no executor for that connect_id | 409 `{ error: "Executor not available" }` |

### Worker (inline extension)

- Hub unreachable: throw `Error("Hub unreachable: <reason>")`.
- Hub 4xx/5xx: throw with the body error message.
- Tool call timeout: handled by pi's native tool framework (no
  change — defaults apply).

### d-pi connect parent

- Executor spawn fails: log warning, continue.
- Executor dies mid-session: log warning, do not auto-restart.
  Subsequent `remote_*` calls surface the error from the hub.

## File-level changes

**New files** (all in `packages/d-pi/`):

- `src/executor/index.ts` — entry, lifecycle
- `src/executor/runner.ts` — tool invocation
- `src/executor/client.ts` — hub communication (register / SSE / POST)
- `src/executor/cli.ts` — `d-pi executor` subcommand (standalone debug)
- `src/agent-extension/remote-tools.ts` — inline extension
- `src/hub/executor-registry.ts` — hub-side state management
- `test/suite/regressions/<id>-remote-executor.test.ts` — integration test

**Modified files** (all in `packages/d-pi/`):

- `src/cli-runner.ts` — `d-pi connect` spawns executor
- `src/hub/gateway.ts` — 4 new endpoints
- `src/extension/message-meta.ts` — `connectId` field + renderer
- `package.json` — add `d-pi-executor` bin entry (debug CLI)

**Not modified**:

- `packages/coding-agent/**` — zero changes. All imports come from
  the existing `@sheason/pi-coding-agent` public API.

## Testing

### Unit (vitest)

- `injectMeta` / `formatMeta` correctly round-trip `connectId`.
- `extractMeta` can read `connectId` out of a meta block.
- Inline extension tool function: with a mocked hub, generates
  `callId`, posts to the right endpoint, propagates the result /
  error correctly.

### Integration (mocked network)

- End-to-end flow: executor register → SSE subscribe → receive
  `remote-call` event → run tool → POST result. Hub routes the
  result back to the pending HTTP response.
- Error paths: SSE drop, executor disconnect, bad callId,
  unauthorized register, conflict on already-registered connect_id.

### E2E (real subprocess)

- Spawn a real executor + real d-pi serve hub + real worker.
- Drive `remote_bash` through the worker; assert result.
- (Optional) Multiple concurrent `remote_*` calls to confirm
  `callId` correlation works under load.

## Open items

None at the design level. Implementation details will be settled in
the writing-plans phase.
