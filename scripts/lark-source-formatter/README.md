# lark-source-formatter

Bash wrappers that translate raw `lark-cli` output into JSON-RPC 2.0
notifications, matching the d-pi hub's source contract. See
[`docs/superpowers/specs/2026-06-07-source-redesign-design.md`](../../../docs/superpowers/specs/2026-06-07-source-redesign-design.md).

## Files

| File | Purpose |
|------|---------|
| `notify.sh` | Pipes `lark-cli event consume im.message.receive_v1 --as bot` through `lark-im-shim.ts`. Emits one `lark.message` JSONRPC notification per inbound message event. |
| `health-notify.sh` | Runs `scripts/lark-health-check/run.sh` and pipes its stdout through `lark-health-shim.ts`. Emits one `health.report` JSONRPC notification per `[health-check] ...` line. |

Both wrappers:

- Resolve paths relative to their own location (`BASH_SOURCE[0]`) so they
  work from any checkout (worktree, npm-link, `/tmp/...-release`).
- Preflight `tsx` + shim presence with clear errors on missing pieces.
- Accept env overrides (`LARK_CLI_BIN`, `HEALTH_SCRIPT`) for tests and
  for ops who need to point at a different upstream binary.

## Registering the wrappers as d-pi sources

The d-pi hub has no static source config — sources are registered at
runtime via the `create_source` tool. To pick up the new wrappers, an
operator (or root agent) registers them from inside the d-pi session
using the tool's exact `command` + `args` shape:

```text
# lark-im-messages source — inbound chat messages
create_source \
  --name lark-im-messages \
  --command sh \
  --args ["/absolute/path/to/pi-mono-shallow/scripts/lark-source-formatter/notify.sh"]

# lark-health-check source — 2-hour cron-style consistency probe
create_source \
  --name lark-health-check \
  --command sh \
  --args ["/absolute/path/to/pi-mono-shallow/scripts/lark-source-formatter/health-notify.sh"]
```

The absolute path is required because the hub spawns the wrapper via
`argv` (no shell tokenisation). Relative paths and `~` expansion do not
work.

## Migration from the old pass-through shape

The old hub contract was "any stdout line passes through to the agent".
The new contract requires valid JSON-RPC 2.0 notifications on stdout
(everything else is dropped at the hub boundary). The wrappers are the
bridge: the old direct `lark-cli event consume ...` source command will
silently emit zero events under the new contract (the lark-cli raw NDJSON
does not parse as a JSON-RPC 2.0 notification).

To migrate an existing deployment:

1. `list_sources` — confirm current source names.
2. For each lark source, `unsubscribe_source <name>` from all subscribers.
3. `destroy_source <name>`.
4. Re-register using the new `create_source` invocations above.
5. Subscribers re-subscribe via `subscribe_source <name>`.

After this change the hub will see only valid JSON-RPC 2.0 notifications
on its source stdout; raw lark-cli lines never reach the agent's input
stream.

## Output shape

Each wrapper emits one JSON-RPC 2.0 notification per upstream event.
The hub's `source-validator` parses each line and forwards only
`notification` shapes (silently dropping `request` / `response` shapes
and logging a warning for `invalid` lines).

Example `lark-im-messages` notification:

```json
{
  "jsonrpc": "2.0",
  "method": "events.emit",
  "params": {
    "type": "lark.message",
    "id": "om_xxxxxxxxxxxx",
    "priority": "follow-up",
    "data": { "...raw lark-cli event payload..." }
  }
}
```

Example `lark-health-check` notification:

```json
{
  "jsonrpc": "2.0",
  "method": "events.emit",
  "params": {
    "type": "health.report",
    "timestamp": "2026-06-07T16:00:01Z",
    "service": "lark-cli",
    "status": "OK",
    "bus_pid": 894190
  }
}
```

`priority` is currently hardcoded to `"follow-up"` (per Issue #3). A
follow-up task will make it configurable per source via the hub's source
config (e.g. `~/.dpi/config.json`).

## Tests

End-to-end behaviour is covered by:

- `packages/d-pi/test/lark-im-shim.test.ts` — unit tests of the shim
  transform.
- `packages/d-pi/test/lark-health-shim.test.ts` — unit tests of the
  health-shim transform.
- `packages/d-pi/test/lark-source-formatter.test.ts` — spawns the
  wrappers end-to-end with mock `lark-cli` / `HEALTH_SCRIPT` binaries
  injected via `PATH` or env override; asserts on JSONRPC output.

Run from the repo root:

```bash
cd packages/d-pi && ../../node_modules/.bin/vitest run \
  test/lark-im-shim.test.ts \
  test/lark-health-shim.test.ts \
  test/lark-source-formatter.test.ts \
  test/source-validator-integration.test.ts
```