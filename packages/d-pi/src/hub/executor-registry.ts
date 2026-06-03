import type { ServerResponse } from "node:http";

export interface SseConn {
	send: (event: string, data: unknown) => void;
}

export interface ExecutorHandle {
	cwd: string;
	sseConn: SseConn;
	pendingCalls: Map<string, ServerResponse>;
}

export interface RegisterInput {
	cwd: string;
	sseConn: SseConn;
}

export class ExecutorRegistry {
	private readonly entries = new Map<string, ExecutorHandle>();

	register(connectId: string, input: RegisterInput): void {
		if (this.entries.has(connectId)) {
			throw new Error(`Connect id already registered: ${connectId}`);
		}
		this.entries.set(connectId, {
			cwd: input.cwd,
			sseConn: input.sseConn,
			pendingCalls: new Map(),
		});
	}

	get(connectId: string): ExecutorHandle | undefined {
		return this.entries.get(connectId);
	}

	deregister(connectId: string): boolean {
		const handle = this.entries.get(connectId);
		if (!handle) return false;
		for (const res of handle.pendingCalls.values()) {
			try {
				res.writeHead(503, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ ok: false, error: "Executor disconnected" }));
			} catch {
				/* ignore */
			}
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
