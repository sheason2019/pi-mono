---
name: reproducing-real-bugs-with-e2e
description: Use when a real user-visible defect escaped unit tests, especially in D-Pi hub/peer, multi-agent, source, MCP, model, WebSocket, terminal UI, or cross-process workflows
---

# Reproducing Real Bugs With E2E

## Overview

Escaped defects usually live at component boundaries. Do not fix them from a unit-test mental model. Recreate the user's topology, capture evidence at each boundary, then reduce the bug into a targeted regression.

Core principle: first prove where the live flow breaks, then write the smallest automated regression that would have caught it.

## When to Use

Use this skill when:

- The user reports behavior that only appears in a running `d-pi hub` / `d-pi peer` system.
- A source, MCP server, child agent, model selection, peer tool, Socket.IO event, or TUI command works in tests but fails in the real workspace.
- The symptom depends on process startup order, reconnects, config reloads, terminal input, or live model/tool execution.
- A previous unit test passed but manual acceptance still failed.

Do not use this for isolated pure functions or already-minimized compile errors.

## The Workflow

### 1. State the Reported Flow

Write the failing flow in operational terms:

- workspace path
- exact hub command
- exact peer command
- target agent id
- relevant files under `.pi/` and `.child-agent/`
- expected behavior
- actual behavior

If any part is missing, inspect existing workspace files and logs before asking the user.

### 2. Recreate the Real Topology First

Use the same component graph the user uses. For Pi, that often means:

- one `d-pi hub` process in the target workspace
- one or more `d-pi peer` processes bound to specific agents
- real `.pi/models.json`, `.pi/sources.json`, `.pi/mcp.json`
- child config under `.child-agent/<agent-id>/`
- real source process or MCP process when the bug is about process boundaries

For TUI flows, use `tmux` instead of guessing from code:

```bash
tmux new-session -d -s pi-e2e -x 100 -y 30
tmux send-keys -t pi-e2e "cd /path/to/workspace && d-pi hub serve" Enter
tmux capture-pane -t pi-e2e -p
```

Use separate sessions or panes for peers:

```bash
tmux new-session -d -s d-pi-peer-main -x 100 -y 30
tmux send-keys -t d-pi-peer-main "d-pi peer --hub http://127.0.0.1:4317 --peer-id e2e-main" Enter
tmux capture-pane -t d-pi-peer-main -p
```

Clean up after the run:

```bash
tmux kill-session -t pi-e2e
tmux kill-session -t d-pi-peer-main
```

### 3. Trace Every Boundary

For multi-component defects, record what enters and exits each boundary:

| Boundary | Evidence to capture |
| --- | --- |
| Config load | Parsed config, resource ids, agent ids, selected layers |
| Process startup | command, args, cwd, env, status, stderr |
| Source/MCP stdout | exact JSON-RPC line or MCP request/response |
| Socket.IO | event name, payload agentId/resourceId, ack |
| Hub runtime | target `HubAgentRuntime`, queue write, flush |
| Peer runtime | bound agent id, rendered state, TUI command output |
| Session | persisted message source metadata and live CRDT update |

Prefer structured logs or small temporary diagnostics. Remove temporary diagnostics before finishing.

### 4. Prove the Failure Before Fixing

Do not patch from intuition. Produce one of:

- a live reproduction transcript with commands and observed output
- a minimal script that drives hub/peer/socket/source boundaries
- a failing test that models the boundary that broke

The failure should match the user's symptom. If the test fails for setup reasons, fix the test first.

### 5. Fix at the Broken Boundary

Fix the layer where evidence shows the data first becomes wrong. Examples:

- If `source:message` has the wrong `agentId`, fix routing before queue writes.
- If `/source` shows main resources in a child peer, fix socket status filtering before TUI rendering.
- If an MCP tool name contains display prefixes, fix config aggregation or resource identity before view labels.
- If child agents see a resource but do not receive messages, verify whether they have their own resource instance, not just a shared display row.

Avoid adding compatibility fallbacks for unshipped branch behavior. Prefer the current architecture's invariant.

### 6. Add the Regression

Convert the live failure into the lowest-cost automated regression test:

- source routing: socket or `SourceHost` test
- config materialization: config loader test
- MCP/resource identity: host/runtime test
- TUI rendering or commands: component/controller test
- real timing/race: integration test with fake process and explicit event ordering

The test must fail before the fix and pass after the fix.

### 7. Verify the Release Path

Run verification that matches the touched surface:

- targeted tests from the package root
- `npm run check` from repo root after code changes
- build/link only when the user asks for manual acceptance or repo rules allow it
- live E2E again when the bug was only visible live

Do not claim completion from `npm run check` alone if the defect was reported in a live multi-process path.

## Pi-Specific Checklists

### Source Bugs

- Check `.pi/sources.json` and `.child-agent/<agent-id>/sources.json`.
- Confirm each expected source has a distinct `resourceId`.
- Confirm inherited child sources are materialized as independent instances.
- Confirm `/source` is filtered to the peer's bound `agentId`.
- Confirm stdout emits only one-line `queue/write` JSON-RPC notifications.
- Confirm logs go to stderr.

### MCP Bugs

- Check `.pi/mcp.json` and child `.child-agent/<agent-id>/mcp.json`.
- Confirm server display names stay unprefixed.
- Confirm internal tool names route by resource identity, not display names.
- Confirm pause/restart/remove uses `resourceId`.
- Confirm remote peer MCP tools execute on the owning peer.

### Child Agent Bugs

- Check `.pi/agents.json`.
- Check `.child-agent/<agent-id>/session.jsonl`.
- Check child-local resource files.
- Confirm the peer connected with `--agent <agent-id>`.
- Confirm `/group` reports the expected agent and peer.

### TUI Bugs

- Reproduce in a real terminal or `tmux`.
- Capture before/after panes.
- Send actual keys with `tmux send-keys`.
- Verify timers/status lines do not reset unless the session state changed.

### Model/API Bugs

- Prefer faux providers in automated tests.
- Use real providers only when the user explicitly requests live acceptance.
- Record model id, provider, env vars present/not present, and failure response.
- Do not print API keys or tokens.

## Common Mistakes

- **Only writing a unit test:** The bug escaped unit tests; first identify the missing boundary.
- **Trusting a TUI row:** A displayed resource does not prove the agent owns or subscribes to it.
- **Fixing the view only:** If the config layer generated wrong identity, fix config aggregation or resource identity before view labels.
- **Using sleeps as proof:** Prefer deterministic event hooks, process emits, socket acks, and captured logs.
- **Skipping live retest:** If the user's bug was live-only, repeat the live path after the fix.
- **Leaking secrets:** Never print real provider keys, Lark secrets, access tokens, or auth headers.

## Final Report Template

When closing the work, report:

- Root cause: one sentence naming the failed boundary.
- Fix: one sentence naming the changed invariant.
- Regression: exact test file(s).
- E2E evidence: command(s) and observed result.
- Remaining risk: any live provider or external service not exercised.
