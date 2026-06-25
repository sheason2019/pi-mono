/**
 * The result shape that every pending call resolves with, regardless of
 * transport (HTTP ServerResponse or IPC callback). Encoded in the JSON
 * body that an HTTP caller receives, and passed verbatim to an IPC
 * callback. Mirrors the shape the executor POSTs back via
 * `/_hub/executor/results`.
 */
export type ResolvedCall = { ok: true; result: unknown } | { ok: false; error: string };

/**
 * One in-flight call to a connected executor. The hub parks a PendingCall
 * when it dispatches a tool to the client and resolves it when the client
 * POSTs back a result (see HubGateway._handleHubApi for
 * `/_hub/executor/results`).
 *
 * Two transport shapes share this interface:
 *
 * - **HTTP** (via `addPending`): wraps a `ServerResponse` from the public
 *   `/agents/{name}/remote-call` endpoint. The resolver writes JSON
 *   headers + body so the executor client / remote-tools extension gets
 *   its fetch response.
 * - **IPC** (via `addPendingCallback`): wraps a `(value) => void`
 *   callback used by `_handleToolCall("remote", ...)` so a worker thread
 *   can dispatch a tool through the hub to the executor without going
 *   through HTTP and without needing an auth token.
 *
 * Both transports share the same `pendingCalls: Map<callId, PendingCall>`
 * backing store, so a single result POST from the executor resolves
 * whichever transport the dispatching code chose.
 */
export interface PendingCall {
	resolve(value: ResolvedCall): void;
}

export interface SseConn {
	send: (event: string, data: unknown) => void;
}

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

import type { ServerResponse } from "node:http";

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

	list(): Array<{ connectId: string; cwd: string; attached: boolean }> {
		return Array.from(this.entries.entries()).map(([connectId, handle]) => ({
			connectId,
			cwd: handle.cwd,
			attached: handle.attached,
		}));
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
	 * Park a `ServerResponse` from a `/agents/{name}/remote-call` HTTP
	 * request. The resolver writes the JSON response with an HTTP code
	 * derived from the result (200 for ok / executor error, 504 for
	 * timeout, 503 for disconnect). This is the HTTP transport sibling
	 * of `addPendingCallback`; both share the same
	 * `pendingCalls: Map<callId, PendingCall>` store so a single
	 * `resolveOne` call covers both paths.
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
					/* connection may already be closed */
				}
			},
		};
		handle.pendingCalls.set(callId, pending);
	}

	/**
	 * Park a callback for an in-process (IPC) dispatch — used by the
	 * worker's `_handleToolCall("remote", ...)` path so a server agent
	 * can dispatch a tool through the hub to the executor without going
	 * through HTTP and without needing an auth token. The resolver hands
	 * the payload back to the awaiting call site (the LLM-facing
	 * `remote_*.execute()` promise).
	 */
	addPendingCallback(connectId: string, callId: string, callback: PendingCall["resolve"]): void {
		const handle = this.entries.get(connectId);
		if (!handle) throw new Error(`No executor for connectId ${connectId}`);
		handle.pendingCalls.set(callId, { resolve: callback });
	}

	/**
	 * Resolve a pending call by callId. Called from
	 * `HubGateway._handleHubApi` when the executor POSTs
	 * `/_hub/executor/results`, and from the server-side timeout / IPC
	 * dispatch paths. Returns true if a pending call was found and
	 * resolved, false if the callId is unknown (the call may have
	 * already timed out / been removed; a late duplicate result is
	 * silently dropped).
	 */
	resolveOne(connectId: string, callId: string, value: ResolvedCall): boolean {
		const handle = this.entries.get(connectId);
		if (!handle) return false;
		const pending = handle.pendingCalls.get(callId);
		if (!pending) return false;
		this.clearPendingTimer(connectId, callId);
		handle.pendingCalls.delete(callId);
		pending.resolve(value);
		return true;
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
