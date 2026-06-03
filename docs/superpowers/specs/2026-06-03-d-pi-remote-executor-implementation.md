# d-pi Remote Executor — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a client-side executor subprocess to d-pi connect that mirrors pi's native file/bash tools and exposes them to d-pi agents via a `remote_*` tool set, dispatched synchronously through the d-pi serve hub.

**Architecture:**
- `d-pi connect` parent spawns an `executor` subprocess alongside the existing `pi connect` child. The executor registers with d-pi serve via SSE, runs native tools, and POSTs results back.
- The d-pi agent's serve-mode worker loads an inline extension that provides `remote_*` tools. Each call is a blocking HTTP POST to d-pi serve, which dispatches to the executor over the SSE channel.
- All changes live in `packages/d-pi/`. `packages/coding-agent/` is untouched.

**Tech Stack:** Node.js 22+, TypeScript, vitest, d-pi hub gateway (Node http), SSE (text/event-stream).

**Spec:** `docs/superpowers/specs/2026-06-03-d-pi-remote-executor-design.md` (committed at `5fb5fe86`).

---

**Worktree note:** Skill convention is to run in a worktree. Per user's prior instruction, all development happens in the main checkout, no new worktree for this feature.

**Test command convention:** `cd packages/d-pi && node ../../node_modules/vitest/dist/cli.js --run test/<file>.test.ts` (d-pi has no `test` script in package.json).

**TDD discipline:** Every implementation step starts with a failing test, verifies it fails, writes minimal code, verifies it passes, then commits. Tests live alongside source as `*.test.ts` next to the file they test, except for the hub gateway integration tests which live in `test/suite/regressions/<id>-<slug>.test.ts` per AGENTS.md.
## Task 1: Meta change — add `connectId` field to `MessageMeta`

**Files:**
- Modify: `packages/d-pi/src/extension/message-meta.ts` (add field to `MessageMeta`, plumb through `injectMeta`)
- Modify: `packages/d-pi/src/extension/index.ts` (renderer formats `connect <id>` when present)
- Test: `packages/d-pi/test/connect-id-meta.test.ts` (new)

**Step 1: Write the failing test**

Create `packages/d-pi/test/connect-id-meta.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { extractMeta, injectMeta } from "../src/extension/message-meta.ts";

describe("connect meta with connectId", () => {
	it("round-trips connectId through inject/extract", () => {
		const text = "hello world";
		const meta = injectMeta(text, "connect", undefined, { connectId: "abc-123" });
		const extracted = extractMeta(meta);
		expect(extracted).not.toBeNull();
		expect(extracted!.meta.sourceType).toBe("connect");
		expect(extracted!.meta.connectId).toBe("abc-123");
		expect(extracted!.text).toBe(text);
	});

	it("omits connectId when not provided", () => {
		const text = "hello";
		const meta = injectMeta(text, "connect");
		const extracted = extractMeta(meta);
		expect(extracted!.meta.connectId).toBeUndefined();
	});

	it("does not add connectId for non-connect source types", () => {
		const meta = injectMeta("hi", "source", undefined, { connectId: "abc-123" });
		const extracted = extractMeta(meta);
		expect(extracted!.meta.connectId).toBeUndefined();
	});
});
```

**Step 2: Run the test to verify it fails**

```bash
cd packages/d-pi && node ../../node_modules/vitest/dist/cli.js --run test/connect-id-meta.test.ts
```

Expected: FAIL. The `injectMeta` signature doesn't accept a 4th `options` arg with `connectId`, and `MessageMeta` doesn't have a `connectId` field yet.

**Step 3: Update `MessageMeta` type and `injectMeta`**

In `packages/d-pi/src/extension/message-meta.ts`:

- Add to `MessageMeta` interface: `connectId?: string;`
- Change `injectMeta(text, sourceType, auth?, options?)` to accept an optional 4th arg `{ connectId?: string }` and write it into the meta when `sourceType === "connect"`.
- Make sure `extractMeta` returns the `connectId` field unchanged.

**Step 4: Run the test to verify it passes**

```bash
cd packages/d-pi && node ../../node_modules/vitest/dist/cli.js --run test/connect-id-meta.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/d-pi/src/extension/message-meta.ts packages/d-pi/test/connect-id-meta.test.ts
git commit -m "feat(d-pi): add connectId to MessageMeta for connect sessions"
```

---

## Task 2: Renderer formats `connect <id>` when connectId present

**Files:**
- Modify: `packages/d-pi/src/extension/index.ts` (the `registerDPiMessageRenderer` function — header line formatting)
- Test: extend `packages/d-pi/test/connect-id-meta.test.ts` with renderer test (or add new test in `packages/d-pi/test/dpi-message-renderer.test.ts` if it tests rendering)

**Step 1: Write the failing test**

Add to `packages/d-pi/test/dpi-message-renderer.test.ts` (or a new file if that one is too crowded). The test should:
- Build the d-pi client extension with a dummy `ExtensionAPI`.
- Capture the `d-pi-message` renderer.
- Render a message with `connectId: "abc-123"`.
- Strip ANSI, assert the header line contains `connect abc-123`.
- Render a message WITHOUT `connectId` and assert the header contains just `connect`.

**Step 2: Run the test to verify it fails**

```bash
cd packages/d-pi && node ../../node_modules/vitest/dist/cli.js --run test/dpi-message-renderer.test.ts
```

Expected: FAIL on the new test (header doesn't include the id).

**Step 3: Update renderer header in `registerDPiMessageRenderer`**

In `packages/d-pi/src/extension/index.ts`, change the header line construction to:
- If `meta.sourceType === "connect"` and `meta.connectId` is present, build the source label as `connect <id>`.
- Otherwise, keep the existing behavior.

**Step 4: Run the test to verify it passes**

```bash
cd packages/d-pi && node ../../node_modules/vitest/dist/cli.js --run test/dpi-message-renderer.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/d-pi/src/extension/index.ts packages/d-pi/test/dpi-message-renderer.test.ts
git commit -m "feat(d-pi): render 'connect <id>' in message header when connectId set"
```

---
## Task 3: Hub — `ExecutorRegistry` data structure

**Files:**
- Create: `packages/d-pi/src/hub/executor-registry.ts`
- Test: `packages/d-pi/test/executor-registry.test.ts` (new)

**Step 1: Write the failing test**

Create `packages/d-pi/test/executor-registry.test.ts`:

```typescript
import { describe, expect, it, beforeEach } from "vitest";
import { ExecutorRegistry } from "../src/hub/executor-registry.ts";

describe("ExecutorRegistry", () => {
	let registry: ExecutorRegistry;

	beforeEach(() => {
		registry = new ExecutorRegistry();
	});

	it("registers an executor under a connectId", () => {
		registry.register("c1", { cwd: "/tmp", sseConn: {} as never });
		expect(registry.get("c1")).toBeDefined();
		expect(registry.get("c1")!.cwd).toBe("/tmp");
	});

	it("rejects duplicate registration of the same connectId", () => {
		registry.register("c1", { cwd: "/tmp", sseConn: {} as never });
		expect(() => registry.register("c1", { cwd: "/other", sseConn: {} as never })).toThrow(
			/already registered/i,
		);
	});

	it("deregisters and returns true when connectId exists", () => {
		registry.register("c1", { cwd: "/tmp", sseConn: {} as never });
		expect(registry.deregister("c1")).toBe(true);
		expect(registry.get("c1")).toBeUndefined();
	});

	it("deregister returns false when connectId unknown", () => {
		expect(registry.deregister("nope")).toBe(false);
	});

	it("stores and resolves pending calls by callId", () => {
		const conn = { sseConn: {} as never, cwd: "/tmp", pendingCalls: new Map() };
		registry.setHandle("c1", conn);
		const fakeRes = { writeHead: () => {}, end: () => {} } as never;
		registry.addPending("c1", "call-1", fakeRes);
		expect(registry.getPending("c1", "call-1")).toBe(fakeRes);
		registry.removePending("c1", "call-1");
		expect(registry.getPending("c1", "call-1")).toBeUndefined();
	});

	it("deregister rejects all pending calls with an error", () => {
		const conn = { sseConn: {} as never, cwd: "/tmp", pendingCalls: new Map() };
		registry.setHandle("c1", conn);
		let captured: unknown;
		const fakeRes = {
			writeHead: () => {},
			end: (body: string) => {
				captured = JSON.parse(body);
			},
		} as never;
		registry.addPending("c1", "call-1", fakeRes);
		registry.deregister("c1");
		expect(captured).toEqual({ ok: false, error: expect.stringContaining("disconnected") });
	});
});
```

**Step 2: Run the test to verify it fails**

```bash
cd packages/d-pi && node ../../node_modules/vitest/dist/cli.js --run test/executor-registry.test.ts
```

Expected: FAIL — module does not exist.

**Step 3: Implement `ExecutorRegistry`**

Create `packages/d-pi/src/hub/executor-registry.ts`:

```typescript
import type { ServerResponse } from "node:http";

export interface ExecutorHandle {
	cwd: string;
	sseConn: { send: (event: string, data: unknown) => void };
	pendingCalls: Map<string, ServerResponse>;
}

export class ExecutorRegistry {
	private readonly entries = new Map<string, ExecutorHandle>();

	register(connectId: string, partial: { cwd: string; sseConn: ExecutorHandle["sseConn"] }): void {
		if (this.entries.has(connectId)) {
			throw new Error(`Connect id already registered: ${connectId}`);
		}
		this.entries.set(connectId, {
			cwd: partial.cwd,
			sseConn: partial.sseConn,
			pendingCalls: new Map(),
		});
	}

	get(connectId: string): ExecutorHandle | undefined {
		return this.entries.get(connectId);
	}

	setHandle(connectId: string, handle: ExecutorHandle): void {
		this.entries.set(connectId, handle);
	}

	deregister(connectId: string): boolean {
		const handle = this.entries.get(connectId);
		if (!handle) return false;
		for (const res of handle.pendingCalls.values()) {
			try {
				res.writeHead(503, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ ok: false, error: "Executor disconnected" }));
			} catch { /* ignore */ }
		}
		return this.entries.delete(connectId);
	}

	addPending(connectId: string, callId: string, res: ServerResponse): void {
		const handle = this.entries.get(connectId);
		if (!handle) throw new Error(`No executor for connectId ${connectId}`);
		handle.pendingCalls.set(callId, res);
	}

	getPending(connectId: string, callId: string): ServerResponse | undefined {
		return this.entries.get(connectId)?.pendingCalls.get(callId);
	}

	removePending(connectId: string, callId: string): void {
		this.entries.get(connectId)?.pendingCalls.delete(callId);
	}
}
```

**Step 4: Run the test to verify it passes**

```bash
cd packages/d-pi && node ../../node_modules/vitest/dist/cli.js --run test/executor-registry.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/d-pi/src/hub/executor-registry.ts packages/d-pi/test/executor-registry.test.ts
git commit -m "feat(d-pi): add ExecutorRegistry for executor lifecycle and pending calls"
```

---
## Task 4: Hub — `POST /_hub/executor/register` endpoint

**Files:**
- Modify: `packages/d-pi/src/hub/gateway.ts` (add `executorRegistry` field on `HubGateway`, wire into constructor, add the route)
- Modify: `packages/d-pi/src/hub/hub.ts` (construct `ExecutorRegistry` and pass it to `HubGateway`)
- Test: `packages/d-pi/test/suite/regressions/executor-register-endpoint.test.ts` (new, integration with real local server)

**Step 1: Write the failing test**

Create `packages/d-pi/test/suite/regressions/executor-register-endpoint.test.ts`. Follow the pattern from `gateway-auth.test.ts`:
- Boot a `HubGateway` on a random port (port 0 → OS picks one).
- Get the URL back from `gateway.url()`.
- `POST {url}/_hub/executor/register` with `Authorization: Bearer <valid token>` and body `{ connectId: "c1", cwd: "/tmp" }`.
- Expect 200 `{ ok: true }`.
- Call again with the same `connectId`. Expect 409 with error matching `/already registered/i`.
- Without auth header, expect 401.

**Step 2: Run the test to verify it fails**

```bash
cd packages/coding-agent && node ../../node_modules/vitest/dist/cli.js --run test/suite/regressions/executor-register-endpoint.test.ts
```

Expected: FAIL — route doesn't exist.

**Step 3: Implement the endpoint in `HubGateway`**

In `packages/d-pi/src/hub/gateway.ts`:

- Add `private readonly _executorRegistry: ExecutorRegistry;` field.
- In constructor, accept `executorRegistry: ExecutorRegistry` as a 5th arg.
- In `_handleHubApi`, before the existing auth check, add the new endpoint handler:

```typescript
if (path === "/_hub/executor/register" && req.method === "POST") {
	if (!this._auth) {
		// No auth configured; allow local registrations (debug mode).
	} else {
		const auth = this._authenticate(req);
		if (!auth) {
			res.writeHead(401, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "Unauthorized" }));
			return;
		}
	}
	try {
		const body = await this._readBody(req);
		const { connectId, cwd } = JSON.parse(body) as { connectId?: string; cwd?: string };
		if (!connectId || !cwd) {
			throw new Error("connectId and cwd are required");
		}
		// Defer sseConn until SSE handler runs; we register a placeholder
		// and replace it via setHandle in the SSE handler.
		this._executorRegistry.register(connectId, {
			cwd,
			sseConn: { send: () => {} },
		});
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ ok: true }));
	} catch (err) {
		const status = err instanceof Error && /already registered/i.test(err.message) ? 409 : 400;
		res.writeHead(status, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
	}
	return;
}
```

Wait — this is awkward: `register` requires `sseConn` but SSE hasn't connected yet. Refactor: split `register` into two steps:
- The `/executor/register` endpoint just validates auth + body and **stashes** the registration (cwd + connectId) without an sseConn.
- The `/executor/events` SSE handler attaches the sseConn to the stashed entry via `setHandle`.

So the registry needs a small change: track "registered but not yet subscribed" state. Update `ExecutorRegistry`:
- `preRegister(connectId, { cwd })` — record cwd, no sseConn yet, throws if already pre-registered or already fully registered.
- `attachSse(connectId, sseConn)` — promote to fully registered, throws if not pre-registered.

Adjust Task 3's tests to cover the new state machine. Re-run the Task 3 test to make sure it still passes (it might need to be split).

In `Hub._executorRegistry = new ExecutorRegistry()` (in `hub.ts`).

**Step 4: Run the test to verify it passes**

```bash
cd packages/coding-agent && node ../../node_modules/vitest/dist/cli.js --run test/suite/regressions/executor-register-endpoint.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/d-pi/src/hub/executor-registry.ts packages/d-pi/src/hub/gateway.ts packages/d-pi/src/hub/hub.ts packages/d-pi/test/executor-registry.test.ts packages/d-pi/test/suite/regressions/executor-register-endpoint.test.ts
git commit -m "feat(d-pi): hub endpoint POST /_hub/executor/register"
```

---
## Task 5: Hub — `GET /_hub/executor/events` SSE endpoint

**Files:**
- Modify: `packages/d-pi/src/hub/gateway.ts` (add the SSE handler)
- Test: `packages/d-pi/test/suite/regressions/executor-events-sse.test.ts` (new)

**Step 1: Write the failing test**

Create `packages/d-pi/test/suite/regressions/executor-events-sse.test.ts`. The test:
- Boots `HubGateway` on a random port.
- Calls `POST /_hub/executor/register` with `{ connectId: "c1", cwd: "/tmp" }`.
- Opens a `GET /_hub/executor/events?connectId=c1` SSE connection using `EventSource` (use the `eventsource` npm package — verify it is in d-pi's deps, add if missing).
- Asserts: receives a `connected` event immediately.
- Calls `POST /_hub/executor/register` again with a different `connectId` and opens another SSE; pushes an event to `c1`'s SSE via an internal hub method (e.g., `executorRegistry.get("c1")?.sseConn.send("remote-call", { callId, tool, params })`); asserts the first SSE receives the event and the second does not.

**Step 2: Run the test to verify it fails**

```bash
cd packages/coding-agent && node ../../node_modules/vitest/dist/cli.js --run test/suite/regressions/executor-events-sse.test.ts
```

Expected: FAIL — route doesn't exist.

**Step 3: Implement the SSE endpoint in `HubGateway`**

In `_handleHubApi`, after the `/executor/register` branch, add:

```typescript
if (path === "/_hub/executor/events" && req.method === "GET") {
	const url = new URL(req.url ?? "/", "http://localhost");
	const connectId = url.searchParams.get("connectId");
	if (!connectId) {
		res.writeHead(400, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: "connectId is required" }));
		return;
	}
	const handle = this._executorRegistry.get(connectId);
	if (!handle) {
		res.writeHead(404, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: "Not registered" }));
		return;
	}
	res.writeHead(200, {
		"Content-Type": "text/event-stream",
		"Cache-Control": "no-cache",
		Connection: "keep-alive",
	});
	res.write(`event: connected\ndata: {"connectId":"${connectId}"}\n\n`);
	const sseConn = {
		send: (event: string, data: unknown) => {
			try {
				res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
			} catch { /* ignore broken pipe */ }
		},
	};
	this._executorRegistry.attachSse(connectId, sseConn);
	req.on("close", () => {
		this._executorRegistry.deregister(connectId);
	});
	return;
}
```

The auth check before this point should still apply (or skip if no auth configured — same pattern as Task 4).

**Step 4: Run the test to verify it passes**

```bash
cd packages/coding-agent && node ../../node_modules/vitest/dist/cli.js --run test/suite/regressions/executor-events-sse.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/d-pi/src/hub/gateway.ts packages/d-pi/test/suite/regressions/executor-events-sse.test.ts
git commit -m "feat(d-pi): hub SSE endpoint GET /_hub/executor/events"
```

---

## Task 6: Hub — `POST /_hub/executor/results` endpoint

**Files:**
- Modify: `packages/d-pi/src/hub/gateway.ts` (add the route)
- Test: `packages/d-pi/test/suite/regressions/executor-results-endpoint.test.ts` (new)

**Step 1: Write the failing test**

Create the test. The test:
- Boots a hub.
- Registers an executor (so the connectId exists).
- Opens SSE so the executor is "fully attached".
- Sends a `POST /_hub/executor/results` with `{ connectId: "c1", callId: "x", ok: true, result: { foo: 1 } }` and asserts 200.
- Then sends with an unknown `callId: "nope"` and asserts 200 (the registry just drops unknowns).
- The test does NOT exercise the pending-call resolution mechanism (that's done in Task 7) — only that the endpoint is reachable and validates the body.

**Step 2: Run the test to verify it fails**

```bash
cd packages/coding-agent && node ../../node_modules/vitest/dist/cli.js --run test/suite/regressions/executor-results-endpoint.test.ts
```

Expected: FAIL.

**Step 3: Implement the endpoint in `HubGateway`**

```typescript
if (path === "/_hub/executor/results" && req.method === "POST") {
	try {
		const body = await this._readBody(req);
		const { connectId, callId, ok, result, error } = JSON.parse(body) as {
			connectId?: string; callId?: string; ok?: boolean; result?: unknown; error?: string;
		};
		if (!connectId || !callId || typeof ok !== "boolean") {
			throw new Error("connectId, callId, and ok are required");
		}
		const res_ = this._executorRegistry.getPending(connectId, callId);
		if (res_) {
			res_.writeHead(200, { "Content-Type": "application/json" });
			res_.end(JSON.stringify(ok ? { ok: true, result } : { ok: false, error }));
			this._executorRegistry.removePending(connectId, callId);
		} else {
			process.stderr.write(`[hub] dropping result for unknown callId ${callId}\n`);
		}
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ ok: true }));
	} catch (err) {
		res.writeHead(400, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
	}
	return;
}
```

**Step 4: Run the test to verify it passes**

```bash
cd packages/coding-agent && node ../../node_modules/vitest/dist/cli.js --run test/suite/regressions/executor-results-endpoint.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/d-pi/src/hub/gateway.ts packages/d-pi/test/suite/regressions/executor-results-endpoint.test.ts
git commit -m "feat(d-pi): hub endpoint POST /_hub/executor/results"
```

---
## Task 7: Hub — `POST /agents/{id}/remote-call` endpoint + `agent_id → connect_id` resolution

**Files:**
- Modify: `packages/d-pi/src/hub/gateway.ts` (add the route, and a small `agentBindings: Map<agentId, connectId>` in `HubGateway`)
- Modify: `packages/d-pi/src/hub/hub.ts` (add a `bindAgent(agentId, connectId)` and `unbindAgent(agentId)` method that the existing agent registry uses)
- Modify: `packages/d-pi/src/hub/agent-registry.ts` (call `bindAgent` / `unbindAgent` in the right places)
- Test: `packages/d-pi/test/suite/regressions/remote-call-endpoint.test.ts` (new, end-to-end with mocked executor)

**Step 1: Write the failing test**

Create the test. The test:
- Boots a hub.
- Registers executor for `connectId="c1"`.
- Opens SSE for `c1` (so the handle is fully attached).
- Calls `hub.bindAgent("agent-1", "c1")` (this is the new method).
- Sends `POST /agents/agent-1/remote-call` with `{ callId: "x", tool: "bash", params: { command: "ls" } }`.
- The HTTP request should block. The test then sends a `POST /_hub/executor/results` with `{ connectId: "c1", callId: "x", ok: true, result: { output: "hi" } }`.
- The original blocked HTTP request should now return 200 with `{ ok: true, result: { output: "hi" } }`.
- Also test: missing binding → 409. No executor for the connectId → 409.

**Step 2: Run the test to verify it fails**

```bash
cd packages/coding-agent && node ../../node_modules/vitest/dist/cli.js --run test/suite/regressions/remote-call-endpoint.test.ts
```

Expected: FAIL.

**Step 3: Implement**

In `HubGateway`:
- Add `private readonly _agentBindings = new Map<string, string>();` (agentId → connectId).
- Add public methods `bindAgent(agentId, connectId)` and `unbindAgent(agentId)`.
- In the gateway's existing `_proxyToAgent` (or a new method dispatched before proxying for `remote-call`), handle the route:

```typescript
const remoteCallMatch = path.match(/^\/agents\/([^/]+)\/remote-call$/);
if (remoteCallMatch && req.method === "POST") {
	const agentId = remoteCallMatch[1];
	const connectId = this._agentBindings.get(agentId);
	if (!connectId) {
		res.writeHead(409, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: "Agent not in connect mode" }));
		return;
	}
	const handle = this._executorRegistry.get(connectId);
	if (!handle) {
		res.writeHead(409, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: "Executor not available" }));
		return;
	}
	const body = await this._readBody(req);
	const { callId, tool, params } = JSON.parse(body) as {
		callId?: string; tool?: string; params?: unknown;
	};
	if (!callId || !tool) throw new Error("callId and tool are required");
	this._executorRegistry.addPending(connectId, callId, res);
	handle.sseConn.send("remote-call", { callId, tool, params });
	// `res` is now held; the executor's result POST will resolve it.
	return;
}
```

In `Hub`:
- Add public `bindAgent(agentId, connectId)` and `unbindAgent(agentId)` that call into the gateway.
- Make `AgentRegistry` call these when an agent is created / bound to a connect id. (For v1, we may not have a clean hook — wire it in `Hub` after spawning a worker, or have d-pi connect do the binding explicitly. Decide based on the existing `Hub` code; see `packages/d-pi/src/hub/hub.ts`.)

**Step 4: Run the test to verify it passes**

```bash
cd packages/coding-agent && node ../../node_modules/vitest/dist/cli.js --run test/suite/regressions/remote-call-endpoint.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/d-pi/src/hub/gateway.ts packages/d-pi/src/hub/hub.ts packages/d-pi/src/hub/agent-registry.ts packages/d-pi/test/suite/regressions/remote-call-endpoint.test.ts
git commit -m "feat(d-pi): hub endpoint POST /agents/{id}/remote-call with agent→connect binding"
```

---

## Task 8: Executor — env reading and entry

**Files:**
- Create: `packages/d-pi/src/executor/index.ts` (entry point)
- Create: `packages/d-pi/src/executor/cli.ts` (standalone debug CLI: `d-pi executor`)
- Test: `packages/d-pi/test/executor-entry.test.ts` (new)

**Step 1: Write the failing test**

The test reads env vars and checks that the entry point throws with a clear message if required vars are missing.

```typescript
import { describe, expect, it } from "vitest";
import { readExecutorEnv, type ExecutorEnv } from "../src/executor/env.ts";

describe("executor env", () => {
	it("parses required env vars", () => {
		const env = readExecutorEnv({
			DPI_HUB_URL: "http://h:1234",
			DPI_AUTH_TOKEN: "tok",
			DPI_CONNECT_ID: "c1",
			DPI_CWD: "/tmp",
		});
		expect(env).toEqual({
			hubUrl: "http://h:1234",
			authToken: "tok",
			connectId: "c1",
			cwd: "/tmp",
		});
	});

	it("throws if any var missing", () => {
		expect(() => readExecutorEnv({ DPI_HUB_URL: "x" })).toThrow(/DPI_AUTH_TOKEN/);
	});
});
```

**Step 2: Run the test to verify it fails**

```bash
cd packages/d-pi && node ../../node_modules/vitest/dist/cli.js --run test/executor-entry.test.ts
```

Expected: FAIL.

**Step 3: Implement `readExecutorEnv`**

Create `packages/d-pi/src/executor/env.ts`:

```typescript
export interface ExecutorEnv {
	hubUrl: string;
	authToken: string;
	connectId: string;
	cwd: string;
}

export function readExecutorEnv(source: Record<string, string | undefined> = process.env): ExecutorEnv {
	const hubUrl = source.DPI_HUB_URL;
	const authToken = source.DPI_AUTH_TOKEN;
	const connectId = source.DPI_CONNECT_ID;
	const cwd = source.DPI_CWD;
	const missing: string[] = [];
	if (!hubUrl) missing.push("DPI_HUB_URL");
	if (!authToken) missing.push("DPI_AUTH_TOKEN");
	if (!connectId) missing.push("DPI_CONNECT_ID");
	if (!cwd) missing.push("DPI_CWD");
	if (missing.length > 0) {
		throw new Error(`Missing required env vars: ${missing.join(", ")}`);
	}
	return { hubUrl: hubUrl!, authToken: authToken!, connectId: connectId!, cwd: cwd! };
}
```

Create `packages/d-pi/src/executor/index.ts` that reads env and starts the client (client implementation in Task 10). For now, the index can just `process.chdir(env.cwd)` and call into the client.

Create `packages/d-pi/src/executor/cli.ts` that calls `index.main()`. Add to `packages/d-pi/package.json` `"bin": { "d-pi-executor": "dist/executor/cli.js" }` (or similar — only if you want a separate bin for debug; the parent spawns the file directly so this is optional).

**Step 4: Run the test to verify it passes**

```bash
cd packages/d-pi && node ../../node_modules/vitest/dist/cli.js --run test/executor-entry.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/d-pi/src/executor packages/d-pi/test/executor-entry.test.ts packages/d-pi/package.json
git commit -m "feat(d-pi): executor env reading and entry point"
```

---
## Task 9: Executor — tool runner (invoke native tools by name)

**Files:**
- Create: `packages/d-pi/src/executor/runner.ts`
- Test: `packages/d-pi/test/executor-runner.test.ts` (new)

**Step 1: Write the failing test**

```typescript
import { defineTool } from "@sheason/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { ToolRunner } from "../src/executor/runner.ts";

const echoTool = defineTool({
	name: "echo",
	description: "echoes back",
	parameters: {} as never,
	execute: async (args: { text: string }) => ({ content: [{ type: "text", text: args.text }] }),
});

const throwsTool = defineTool({
	name: "throws",
	description: "throws",
	parameters: {} as never,
	execute: async () => {
		throw new Error("kaboom");
	},
});

describe("ToolRunner", () => {
	it("runs a registered tool and returns the result", async () => {
		const r = new ToolRunner([echoTool]);
		const out = await r.run("echo", { text: "hi" });
		expect(out.ok).toBe(true);
		expect(out.result).toEqual({ content: [{ type: "text", text: "hi" }] });
	});

	it("returns error when tool throws", async () => {
		const r = new ToolRunner([throwsTool]);
		const out = await r.run("throws", {});
		expect(out.ok).toBe(false);
		expect(out.error).toBe("kaboom");
	});

	it("returns error when tool name is unknown", async () => {
		const r = new ToolRunner([echoTool]);
		const out = await r.run("nope", {});
		expect(out.ok).toBe(false);
		expect(out.error).toMatch(/unknown tool/i);
	});
});
```

**Step 2: Run the test to verify it fails**

```bash
cd packages/d-pi && node ../../node_modules/vitest/dist/cli.js --run test/executor-runner.test.ts
```

Expected: FAIL.

**Step 3: Implement `ToolRunner`**

Create `packages/d-pi/src/executor/runner.ts`. The class takes a list of pi tool definitions on construction. `run(name, params)` looks up the tool and calls its `execute`. Returns `{ ok: true, result }` or `{ ok: false, error }`.

```typescript
import type { ToolDefinition } from "@sheason/pi-coding-agent";

export type RunnerResult = { ok: true; result: unknown } | { ok: false; error: string };

export class ToolRunner {
	private readonly byName: Map<string, ToolDefinition>;
	constructor(tools: ToolDefinition[]) {
		this.byName = new Map(tools.map((t) => [t.name, t]));
	}
	async run(name: string, params: unknown): Promise<RunnerResult> {
		const tool = this.byName.get(name);
		if (!tool) return { ok: false, error: `Unknown tool: ${name}` };
		try {
			const result = await (tool.execute as (a: unknown) => unknown)(params);
			return { ok: true, result };
		} catch (e) {
			return { ok: false, error: e instanceof Error ? e.message : String(e) };
		}
	}
}
```

**Step 4: Run the test to verify it passes**

```bash
cd packages/d-pi && node ../../node_modules/vitest/dist/cli.js --run test/executor-runner.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/d-pi/src/executor/runner.ts packages/d-pi/test/executor-runner.test.ts
git commit -m "feat(d-pi): ToolRunner for executing native tools by name"
```

---

## Task 10: Executor — hub client (register + SSE subscribe + POST result)

**Files:**
- Create: `packages/d-pi/src/executor/client.ts`
- Test: `packages/d-pi/test/suite/regressions/executor-client.test.ts` (new, end-to-end with a fake hub)

**Step 1: Write the failing test**

The test:
- Spins up a real local HTTP server that emulates the hub's three endpoints (register, SSE, results) — keep it small and inline.
- Calls `new ExecutorClient({ hubUrl: server.url, authToken: "tok", connectId: "c1" })`.
- Calls `await client.start()`. The client's start does: POST register, then open SSE.
- Drives a fake `remote-call` event on the SSE; the client should call a provided `onCommand` callback.
- Calls `client.sendResult("call-1", { ok: true, result: 42 })`. The fake hub should record the result POST.

**Step 2: Run the test to verify it fails**

```bash
cd packages/coding-agent && node ../../node_modules/vitest/dist/cli.js --run test/suite/regressions/executor-client.test.ts
```

Expected: FAIL.

**Step 3: Implement `ExecutorClient`**

`packages/d-pi/src/executor/client.ts`:

```typescript
import EventSource from "eventsource";

export type RemoteCallEvent = { callId: string; tool: string; params: unknown };
export type ResultPayload = { connectId: string; callId: string; ok: true; result: unknown } | { connectId: string; callId: string; ok: false; error: string };

export interface ExecutorClientOptions {
	hubUrl: string;
	authToken: string;
	connectId: string;
	onCommand: (event: RemoteCallEvent) => void;
}

export class ExecutorClient {
	private eventSource: EventSource | undefined;
	constructor(private readonly opts: ExecutorClientOptions) {}

	async start(): Promise<void> {
		const headers = { Authorization: `Bearer ${this.opts.authToken}`, "Content-Type": "application/json" };
		const regRes = await fetch(`${this.opts.hubUrl}/_hub/executor/register`, {
			method: "POST",
			headers,
			body: JSON.stringify({ connectId: this.opts.connectId, cwd: process.cwd() }),
		});
		if (!regRes.ok) {
			throw new Error(`Failed to register executor: ${regRes.status} ${await regRes.text()}`);
		}
		const url = new URL(`${this.opts.hubUrl}/_hub/executor/events`);
		url.searchParams.set("connectId", this.opts.connectId);
		this.eventSource = new EventSource(url.toString(), { headers: { Authorization: `Bearer ${this.opts.authToken}` } });
		this.eventSource.addEventListener("remote-call", (ev) => {
			try {
				const event = JSON.parse((ev as MessageEvent).data) as RemoteCallEvent;
				this.opts.onCommand(event);
			} catch (e) {
				process.stderr.write(`[executor] bad event: ${(e as Error).message}\n`);
			}
		});
	}

	async sendResult(payload: Omit<ResultPayload, "connectId">): Promise<void> {
		const res = await fetch(`${this.opts.hubUrl}/_hub/executor/results`, {
			method: "POST",
			headers: { Authorization: `Bearer ${this.opts.authToken}`, "Content-Type": "application/json" },
			body: JSON.stringify({ connectId: this.opts.connectId, ...payload }),
		});
		if (!res.ok) {
			throw new Error(`Failed to post result: ${res.status} ${await res.text()}`);
		}
	}

	stop(): void {
		this.eventSource?.close();
	}
}
```

Add `eventsource` to `packages/d-pi/package.json` dependencies (verify what version is in the repo already; reuse if possible).

**Step 4: Run the test to verify it passes**

```bash
cd packages/coding-agent && node ../../node_modules/vitest/dist/cli.js --run test/suite/regressions/executor-client.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/d-pi/src/executor/client.ts packages/d-pi/package.json packages/d-pi/test/suite/regressions/executor-client.test.ts
git commit -m "feat(d-pi): ExecutorClient (register, SSE subscribe, POST result)"
```

---
## Task 11: Inline extension for agent worker (7 `remote_*` tools)

**Files:**
- Create: `packages/d-pi/src/agent-extension/remote-tools.ts` (the extension)
- Test: `packages/d-pi/test/remote-tools-extension.test.ts` (new, uses fake `ExtensionAPI` + fake `fetch`)

**Step 1: Write the failing test**

```typescript
import { describe, expect, it, beforeEach } from "vitest";
import { createRemoteToolsExtension } from "../src/agent-extension/remote-tools.ts";

describe("remote tools extension", () => {
	let registered: Record<string, { description: string; handler: unknown }> = {};
	let fetchCalls: Array<{ url: string; init: RequestInit }> = [];
	let fetchResponse: { ok: boolean; body: unknown } = { ok: true, body: { ok: true, result: "done" } };

	beforeEach(() => {
		registered = {};
		fetchCalls = [];
		fetchResponse = { ok: true, body: { ok: true, result: "done" } };
	});

	function makeApi() {
		return {
			DPI_HUB_URL: "http://h:1234",
			DPI_AUTH_TOKEN: "tok",
			agentId: "agent-1",
		};
	}

	function fetchImpl(url: string, init: RequestInit) {
		fetchCalls.push({ url, init });
		return Promise.resolve(new Response(JSON.stringify(fetchResponse.body), { status: fetchResponse.ok ? 200 : 500 }));
	}

	it("registers 7 tools", () => {
		createRemoteToolsExtension({ api: makeApi(), fetchImpl, registerTool: (name, def) => { registered[name] = def; } });
		expect(Object.keys(registered).sort()).toEqual([
			"remote_bash", "remote_edit", "remote_find", "remote_grep", "remote_ls", "remote_read", "remote_write",
		]);
	});

	it("remote_bash handler POSTs to /agents/{id}/remote-call and returns the result", async () => {
		createRemoteToolsExtension({ api: makeApi(), fetchImpl, registerTool: (name, def) => { registered[name] = def; } });
		const out = await (registered.remote_bash.handler as (p: { command: string }) => Promise<unknown>)({ command: "ls" });
		expect(out).toEqual("done");
		expect(fetchCalls).toHaveLength(1);
		expect(fetchCalls[0].url).toBe("http://h:1234/agents/agent-1/remote-call");
		const body = JSON.parse(fetchCalls[0].init.body as string);
		expect(body.tool).toBe("bash");
		expect(body.params).toEqual({ command: "ls" });
		expect(typeof body.callId).toBe("string");
	});

	it("throws when the hub returns ok: false", async () => {
		fetchResponse = { ok: true, body: { ok: false, error: "Executor not available" } };
		createRemoteToolsExtension({ api: makeApi(), fetchImpl, registerTool: (name, def) => { registered[name] = def; } });
		await expect(
			(registered.remote_bash.handler as (p: { command: string }) => Promise<unknown>)({ command: "ls" }),
		).rejects.toThrow(/Executor not available/);
	});

	it("throws when fetchImpl throws", async () => {
		createRemoteToolsExtension({
			api: makeApi(),
			fetchImpl: () => Promise.reject(new Error("ECONNREFUSED")),
			registerTool: (name, def) => { registered[name] = def; },
		});
		await expect(
			(registered.remote_bash.handler as (p: { command: string }) => Promise<unknown>)({ command: "ls" }),
		).rejects.toThrow(/Hub unreachable/);
	});
});
```

**Step 2: Run the test to verify it fails**

```bash
cd packages/d-pi && node ../../node_modules/vitest/dist/cli.js --run test/remote-tools-extension.test.ts
```

Expected: FAIL.

**Step 3: Implement the extension**

`packages/d-pi/src/agent-extension/remote-tools.ts`:

```typescript
import type { ToolDefinition } from "@sheason/pi-coding-agent";

export interface RemoteToolsContext {
	api: { DPI_HUB_URL: string; DPI_AUTH_TOKEN: string; agentId: string };
	fetchImpl: typeof fetch;
	registerTool: (name: string, def: ToolDefinition) => void;
}

const TOOL_NAME_MAP = {
	bash: "remote_bash",
	read: "remote_read",
	ls: "remote_ls",
	grep: "remote_grep",
	find: "remote_find",
	write: "remote_write",
	edit: "remote_edit",
} as const;

export function createRemoteToolsExtension(ctx: RemoteToolsContext): void {
	for (const [native, remote] of Object.entries(TOOL_NAME_MAP)) {
		ctx.registerTool(remote, makeRemoteTool(native, remote, ctx));
	}
}

function makeRemoteTool(nativeName: string, registeredName: string, ctx: RemoteToolsContext): ToolDefinition {
	return {
		name: registeredName,
		description: `Run native ${nativeName} on the connected client.`,
		parameters: {} as never, // We accept the native tool's params and pass them through; the schema is opaque here.
		execute: async (params: unknown) => {
			const callId = crypto.randomUUID();
			const url = `${ctx.api.DPI_HUB_URL}/agents/${ctx.api.agentId}/remote-call`;
			const headers = {
				Authorization: `Bearer ${ctx.api.DPI_AUTH_TOKEN}`,
				"Content-Type": "application/json",
			};
			let res: Response;
			try {
				res = await ctx.fetchImpl(url, {
					method: "POST",
					headers,
					body: JSON.stringify({ callId, tool: nativeName, params }),
				});
			} catch (e) {
				throw new Error(`Hub unreachable: ${e instanceof Error ? e.message : String(e)}`);
			}
			if (!res.ok) {
				throw new Error(`Hub returned ${res.status}: ${await res.text()}`);
			}
			const body = (await res.json()) as { ok: boolean; result?: unknown; error?: string };
			if (!body.ok) {
				throw new Error(body.error ?? "Unknown hub error");
			}
			return body.result;
		},
	} as unknown as ToolDefinition;
}
```

Note: the tool `parameters` field is `{}` here — the upstream pi extension runtime should pass the registered tool's schema through. The actual schema for each native tool is defined in `@sheason/pi-coding-agent`'s public API; we may need to import and re-export the schemas in a future task. For v1, the empty-schema placeholder is acceptable; the LLM will see the right description and call the tool. Tighten the schema in a follow-up if needed.

**Step 4: Run the test to verify it passes**

```bash
cd packages/d-pi && node ../../node_modules/vitest/dist/cli.js --run test/remote-tools-extension.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/d-pi/src/agent-extension/remote-tools.ts packages/d-pi/test/remote-tools-extension.test.ts
git commit -m "feat(d-pi): inline extension with 7 remote_* tools for agent workers"
```

---

## Task 12: d-pi connect parent — spawn executor

**Files:**
- Modify: `packages/d-pi/src/cli-runner.ts` (in `d-pi connect` flow, after auth handshake, spawn executor with env vars)
- Modify: `packages/d-pi/src/connect/connect-mode.ts` (expose `connectId` and `authToken` to the parent after the handshake)
- Test: `packages/d-pi/test/connect-spawns-executor.test.ts` (new, mocks `child_process.spawn`)

**Step 1: Write the failing test**

Mock `child_process.spawn` and assert that after `runDPiConnectMode` enters the connect loop, a child is spawned with the right env vars and cwd. Test:
- Stub `fetch` for `/_hub/network` to return a single agent.
- Stub `spawn` to record the call.
- Call `runDPiConnectMode` (with auth pre-supplied so it skips the auth flow).
- Assert: `spawn` was called once with an executable that looks like our executor entry, with `env` containing the 4 DPI_* vars, and `cwd` set to the parent's cwd.

**Step 2: Run the test to verify it fails**

```bash
cd packages/d-pi && node ../../node_modules/vitest/dist/cli.js --run test/connect-spawns-executor.test.ts
```

Expected: FAIL.

**Step 3: Implement the spawn**

In `packages/d-pi/src/connect/connect-mode.ts`:
- After the auth handshake (or when `authToken` is already provided), record `connectId` and `authToken` somewhere the parent can read. Simplest: pass them via a returned object: change `runDPiConnectMode` to return `{ connectId, authToken, hubUrl }` (or a new `DPiConnectSession` type) instead of `void`.

In `packages/d-pi/src/cli-runner.ts`:
- Call `runDPiConnectMode(...)`, await its return to get the session.
- `spawn(process.execPath, [executorEntry], { env: { ...process.env, DPI_HUB_URL, DPI_AUTH_TOKEN, DPI_CONNECT_ID, DPI_CWD }, cwd: process.cwd(), stdio: ["ignore", "inherit", "inherit"] })`.
- Stash the child handle. On parent shutdown, `child.kill("SIGTERM")`; on uncaught exception, the OS takes care of cleanup.
- For dev convenience, the executor entry is `path.join(import.meta.dirname, "..", "executor", "index.ts")` when running from source (via tsx) or `path.join(import.meta.dirname, "executor", "index.js")` when running from dist. Detect with `endsWith("dist")` or pass the file path explicitly.

**Step 4: Run the test to verify it passes**

```bash
cd packages/d-pi && node ../../node_modules/vitest/dist/cli.js --run test/connect-spawns-executor.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/d-pi/src/cli-runner.ts packages/d-pi/src/connect/connect-mode.ts packages/d-pi/test/connect-spawns-executor.test.ts
git commit -m "feat(d-pi): connect parent spawns executor subprocess with env"
```

---

## Task 13: End-to-end integration test

**Files:**
- Test: `packages/d-pi/test/suite/regressions/remote-executor-e2e.test.ts` (new)

**Step 1: Write the failing test**

The test:
- Boots a `HubGateway` and a `Hub` on a random port.
- Registers an executor (with SSE) and binds it to a fake agent id.
- Builds an `ExecutorClient` pointing at the hub.
- Builds the inline extension's `remote_bash` tool pointing at the same hub.
- Wires: when the tool is called with `{ command: "echo hi" }`, it should POST to the hub, the hub should push via SSE to the executor client, the client should run a stub tool (returning `{ output: "hi", exitCode: 0 }`), the result should flow back, and the tool call should resolve with that result.
- Asserts end-to-end latency, result shape, and that the callId is correlated correctly.

**Step 2: Run the test to verify it fails**

```bash
cd packages/coding-agent && node ../../node_modules/vitest/dist/cli.js --run test/suite/regressions/remote-executor-e2e.test.ts
```

Expected: FAIL (because earlier tasks aren't done — but each task has its own test, so by Task 13 all of them should be green).

**Step 3: Wire it up**

This task is mostly verification. The existing Task 1-12 implementations should make this test pass. If the test reveals integration issues (likely), fix them in the responsible task and re-run.

**Step 4: Run the test to verify it passes**

```bash
cd packages/coding-agent && node ../../node_modules/vitest/dist/cli.js --run test/suite/regressions/remote-executor-e2e.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/d-pi/test/suite/regressions/remote-executor-e2e.test.ts
git commit -m "test(d-pi): end-to-end remote executor flow"
```

---

## Done

Run all d-pi tests one last time:

```bash
cd packages/d-pi && node ../../node_modules/vitest/dist/cli.js --run
```

And `npm run check` at the repo root.
