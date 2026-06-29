import type { TeamSnapshot, WorkerToHubMessage } from "../types.ts";

type MessageMode = "next" | "steer";

type PendingCall = {
	resolve: (result: unknown) => void;
	reject: (error: Error) => void;
	timer?: ReturnType<typeof setTimeout>;
	abortListener?: () => void;
	signal?: AbortSignal;
};

export class HubChannel {
	private readonly _agentName: string;
	private readonly _postToHub: (message: WorkerToHubMessage) => void;
	private readonly _pendingCalls = new Map<string, PendingCall>();
	private _callIdCounter = 0;

	constructor(agentName: string, postToHub: (message: WorkerToHubMessage) => void) {
		this._agentName = agentName;
		this._postToHub = postToHub;
	}

	get agentName(): string {
		return this._agentName;
	}

	sendMessage(toAgentName: string, content: string, mode: MessageMode = "next"): Promise<unknown> {
		return this._callTool("send_message", { agent_name: toAgentName, message: content, mode });
	}

	createAgent(name: string, cwd?: string): Promise<unknown> {
		return this._callTool("create_agent", { name, cwd });
	}

	destroyAgent(agentName: string): Promise<unknown> {
		return this._callTool("destroy_agent", { agent_name: agentName });
	}

	getTeam(): Promise<TeamSnapshot> {
		return this._callTool("team", {}) as Promise<TeamSnapshot>;
	}

	callDispatch(tool: string, params: unknown, connectId: string, signal?: AbortSignal): Promise<unknown> {
		return this._callTool("dispatch", { tool, params, connect_id: connectId }, signal);
	}

	reloadWorkspace(): Promise<unknown> {
		return this._callTool("reload_workspace", {});
	}

	syncAgents(): Promise<unknown> {
		return this._callTool("sync_agents", {});
	}

	resolveCall(callId: string, result: unknown): void {
		const pending = this._pendingCalls.get(callId);
		if (pending) {
			this._pendingCalls.delete(callId);
			if (pending.timer) clearTimeout(pending.timer);
			if (pending.abortListener && pending.signal) {
				pending.signal.removeEventListener("abort", pending.abortListener);
			}
			pending.resolve(result);
		}
	}

	rejectCall(callId: string, error: Error): void {
		const pending = this._pendingCalls.get(callId);
		if (pending) {
			this._pendingCalls.delete(callId);
			if (pending.timer) clearTimeout(pending.timer);
			if (pending.abortListener && pending.signal) {
				pending.signal.removeEventListener("abort", pending.abortListener);
			}
			pending.reject(error);
		}
	}

	private _callTool(tool: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
		const callId = `${this._agentName}-${++this._callIdCounter}`;
		return new Promise<unknown>((resolve, reject) => {
			const pendingEntry: PendingCall = { resolve, reject, signal };
			this._pendingCalls.set(callId, pendingEntry);

			if (signal) {
				const abortListener = () => {
					const pending = this._pendingCalls.get(callId);
					if (pending) {
						this._pendingCalls.delete(callId);
						if (pending.timer) clearTimeout(pending.timer);
						if (tool === "dispatch") {
							this._postToHub({ type: "cancel_tool_call", agentName: this._agentName, callId });
						}
						pending.reject(new DOMException("Aborted", "AbortError"));
					}
				};
				if (signal.aborted) {
					abortListener();
					return;
				}
				pendingEntry.abortListener = abortListener;
				signal.addEventListener("abort", abortListener, { once: true });
			}

			this._postToHub({ type: "tool_call", agentName: this._agentName, tool, params, callId });
			pendingEntry.timer = setTimeout(() => {
				const pending = this._pendingCalls.get(callId);
				if (pending) {
					this._pendingCalls.delete(callId);
					if (pending.abortListener && pending.signal) {
						pending.signal.removeEventListener("abort", pending.abortListener);
					}
					this._postToHub({ type: "tool_call_timeout", agentName: this._agentName, callId });
					pending.reject(new Error(`Tool call ${tool} timed out`));
				}
			}, 60_000);
		});
	}
}
