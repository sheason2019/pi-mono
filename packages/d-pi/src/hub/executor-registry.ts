import type { ServerResponse } from "node:http";

export interface SseConn {
	send: (event: string, data: unknown) => void;
}

/**
 * One in-flight call to a connected executor. The hub parks a
 * PendingCall when it dispatches a tool to the client and resolves
 * it when the client POSTs back a result (see
 * `HubGateway._handleHubApi` for `/_hub/executor/results`).
 *
 * Two transport shapes share this interface:
 *
 * - **HTTP** (`httpPendingCall`): wraps a `ServerResponse` from the
 *   public `/agents/{name}/remote-call` endpoint. The resolver
 *   writes JSON headers + body, which is what the executor client
 *   expects over its fetch.
 * - **In-process** (`callbackPendingCall`): wraps a `(value) =>
 *   void` callback used by `_handleToolCall("call_executor", ...)`
 *   on the IPC path so a worker thread can dispatch a tool through
 *   the hub to the executor without going through HTTP and without
 *   bypassing auth.
 *
 * Both shapes carry the same payload shape on resolve — the
 * executor result body — so the dispatching code does not care
 * which transport the original call came in on.
 */
export interface PendingCall {
	resolve(value: { ok: true; result: unknown } | { ok: false; error: string }): void;
}

/**
 * The shape of the JSON body an HTTP response writes for a
 * resolved executor call. Lives in its own type so tests and
 * downstream consumers can refer to it without re-declaring the
 * shape. Successful calls use `ok: true` with the tool result;
 * failed calls use `ok: false` with a human-readable error.
 */
export type ResolvedCall = { ok: true; result: unknown } | { ok: false; error: string };

export interface ExecutorHandle {
	cwd: string;
	sseConn?: SseConn;
	pendingCalls: Map<string, PendingCall>;
	/** Per-call timeout handles so a result POST can clear the timer
	 *  before it fires, preventing a stale timeout from clobbering a
	 *  late-but-valid result. */
	pendingTimers: Map<string, NodeJS.Timeout>;
	attached: boolean;
}

export interface PreRegisterInput {
	cwd: string;
}

export interface RegisterInput extends PreRegisterInput {
	sseConn: SseConn;
}

export class ExecutorRegistry {
	private readonly entries = new Map<string, ExecutorHandle>();

	preRegister(connectId: string, input: PreRegisterInput): void {
		if (this.entries.has(connectId)) {
			throw new Error(`Connect id already registered: ${connectId}`);
		}
		this.entries.set(connectId, {
			cwd: input.cwd,
			pendingCalls: new Map(),
			pendingTimers: new Map(),
			attached: false,
		});
	}

	attachSse(connectId: string, sseConn: SseConn): void {
		const handle = this.entries.get(connectId);
		if (!handle) {
			throw new Error(`Connect id not pre-registered: ${connectId}`);
		}
		if (handle.attached) {
			throw new Error(`Connect id already attached: ${connectId}`);
		}
		handle.sseConn = sseConn;
		handle.attached = true;
	}

	register(connectId: string, input: RegisterInput): void {
		this.preRegister(connectId, input);
		this.attachSse(connectId, input.sseConn);
	}

	get(connectId: string): ExecutorHandle | undefined {
		return this.entries.get(connectId);
	}

	deregister(connectId: string): boolean {
		const handle = this.entries.get(connectId);
		if (!handle) return false;
		for (const timer of handle.pendingTimers.values()) {
			clearTimeout(timer);
		}
		handle.pendingTimers.clear();
		for (const pending of handle.pendingCalls.values()) {
			pending.resolve({ ok: false, error: "Executor disconnected" });
		}
		return this.entries.delete(connectId);
	}

	/**
	 * Park a `ServerResponse` from a `/agents/{name}/remote-call`
	 * HTTP request. When the executor POSTs a result, the resolver
	 * writes the JSON response and the request completes.
	 *
	 * The HTTP code is 200 on a delivered result — the call's
	 * success or failure is encoded in the JSON body as
	 * `{ ok: true, result }` vs `{ ok: false, error }`, mirroring
	 * the `ExecutorClient` fetch contract. Failures that the hub
	 * raises itself (timeout, disconnect) use distinct HTTP
	 * codes: 504 for timeouts, 503 for disconnect, so the client
	 * can distinguish "executor didn't reply" from "executor
	 * replied with an error".
	 */
	addPending(connectId: string, callId: string, res: ServerResponse): void {
		const handle = this.entries.get(connectId);
		if (!handle) throw new Error(`No executor for connectId ${connectId}`);
		const status = { sent: false };
		const pending: PendingCall = {
			resolve(value) {
				if (status.sent) return;
				status.sent = true;
				let httpCode = 200;
				if (!value.ok) {
					if (value.error === "Executor disconnected") httpCode = 503;
					else if (/timed out/i.test(value.error)) httpCode = 504;
				}
				try {
					res.writeHead(httpCode, { "Content-Type": "application/json" });
					res.end(JSON.stringify(value));
				} catch {
					/* ignore — connection may already be closed */
				}
			},
		};
		handle.pendingCalls.set(callId, pending);
	}

	/**
	 * Park a callback for an in-process dispatch (e.g. from the
	 * worker's `call_executor` IPC tool). The resolver hands the
	 * payload back to the awaiting call site (the LLM-facing
	 * `bashRemote.execute()` promise). This is the in-process
	 * sibling of `addPending` and shares the same
	 * `pendingCalls: Map<callId, PendingCall>` backing store, so a
	 * single result POST resolves whichever transport the
	 * dispatching code chose.
	 */
	addPendingCallback(connectId: string, callId: string, callback: PendingCall["resolve"]): void {
		const handle = this.entries.get(connectId);
		if (!handle) throw new Error(`No executor for connectId ${connectId}`);
		handle.pendingCalls.set(callId, { resolve: callback });
	}

	/**
	 * Resolve a pending call by callId. Called from
	 * `HubGateway._handleHubApi` when the executor POSTs
	 * `/_hub/executor/results`. Returns true if a pending call
	 * was found and resolved, false if the callId is unknown (the
	 * call may have already timed out and been removed; in that
	 * case the result is silently dropped, which is the right
	 * behavior — a late result for a timed-out call is
	 * indistinguishable from a stale duplicate).
	 */
	resolveOne(
		connectId: string,
		callId: string,
		value: { ok: true; result: unknown } | { ok: false; error: string },
	): boolean {
		const handle = this.entries.get(connectId);
		if (!handle) return false;
		const pending = handle.pendingCalls.get(callId);
		if (!pending) return false;
		this.clearPendingTimer(connectId, callId);
		handle.pendingCalls.delete(callId);
		pending.resolve(value);
		return true;
	}

	/** @deprecated Use `resolveOne` instead. Kept for tests. */
	getPending(connectId: string, callId: string): PendingCall | undefined {
		return this.entries.get(connectId)?.pendingCalls.get(callId);
	}

	/** @deprecated Use `resolveOne` instead. Kept for tests. */
	removePending(connectId: string, callId: string): void {
		this.entries.get(connectId)?.pendingCalls.delete(callId);
	}

	setPendingTimer(connectId: string, callId: string, timer: NodeJS.Timeout): void {
		this.entries.get(connectId)?.pendingTimers.set(callId, timer);
	}

	clearPendingTimer(connectId: string, callId: string): void {
		const handle = this.entries.get(connectId);
		if (!handle) return;
		const timer = handle.pendingTimers.get(callId);
		if (timer !== undefined) {
			clearTimeout(timer);
			handle.pendingTimers.delete(callId);
		}
	}
}
