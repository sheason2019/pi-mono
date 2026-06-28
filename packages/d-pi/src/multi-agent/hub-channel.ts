import type { TeamSnapshot, WorkerToHubMessage } from "../types.ts";

type MessageMode = "next" | "steer";

export class HubChannel {
	private readonly _agentName: string;
	private readonly _postToHub: (message: WorkerToHubMessage) => void;
	private readonly _pendingCalls = new Map<
		string,
		{ resolve: (result: unknown) => void; reject: (error: Error) => void }
	>();
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

	callDispatch(tool: string, params: unknown, connectId: string): Promise<unknown> {
		return this._callTool("dispatch", { tool, params, connect_id: connectId });
	}

	reloadWorkspace(): Promise<unknown> {
		return this._callTool("reload_workspace", {});
	}

	resolveCall(callId: string, result: unknown): void {
		const pending = this._pendingCalls.get(callId);
		if (pending) {
			this._pendingCalls.delete(callId);
			clearTimeout((pending as typeof pending & { timer?: ReturnType<typeof setTimeout> }).timer);
			pending.resolve(result);
		}
	}

	rejectCall(callId: string, error: Error): void {
		const pending = this._pendingCalls.get(callId);
		if (pending) {
			this._pendingCalls.delete(callId);
			clearTimeout((pending as typeof pending & { timer?: ReturnType<typeof setTimeout> }).timer);
			pending.reject(error);
		}
	}

	private _callTool(tool: string, params: unknown): Promise<unknown> {
		const callId = `${this._agentName}-${++this._callIdCounter}`;
		return new Promise<unknown>((resolve, reject) => {
			this._pendingCalls.set(callId, { resolve, reject });
			this._postToHub({ type: "tool_call", agentName: this._agentName, tool, params, callId });
			const timer = setTimeout(() => {
				if (this._pendingCalls.has(callId)) {
					this._pendingCalls.delete(callId);
					this._postToHub({ type: "tool_call_timeout", agentName: this._agentName, callId });
					reject(new Error(`Tool call ${tool} timed out`));
				}
			}, 60_000);
			const pending = this._pendingCalls.get(callId);
			if (pending) {
				(pending as typeof pending & { timer: ReturnType<typeof setTimeout> }).timer = timer;
			}
		});
	}
}
