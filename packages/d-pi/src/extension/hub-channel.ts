import type { AgentNetworkSnapshot, WorkerToHubMessage } from "../types.ts";

type IncomingMessageHandler = (content: string, sourceName?: string) => void;

/**
 * Communication channel from extension tools to the Hub.
 *
 * Each worker creates a HubChannel with its agentId and a postToHub callback
 * (which calls parentPort.postMessage). Tools call channel methods which
 * post tool_call messages to the Hub and return Promises that resolve when
 * the Hub sends back tool_result with the matching callId.
 */
export class HubChannel {
	private readonly _agentId: string;
	private readonly _postToHub: (message: WorkerToHubMessage) => void;
	private readonly _pendingCalls = new Map<
		string,
		{ resolve: (result: unknown) => void; reject: (error: Error) => void }
	>();
	private _callIdCounter = 0;
	private _onIncomingMessage?: IncomingMessageHandler;

	constructor(agentId: string, postToHub: (message: WorkerToHubMessage) => void) {
		this._agentId = agentId;
		this._postToHub = postToHub;
	}

	get agentId(): string {
		return this._agentId;
	}

	/** Register handler for incoming messages from the Hub */
	onIncomingMessage(handler: IncomingMessageHandler): void {
		this._onIncomingMessage = handler;
	}

	/** Deliver an incoming message — called by agent-worker, handled by extension */
	deliverMessage(content: string, sourceName?: string): void {
		this._onIncomingMessage?.(content, sourceName);
	}

	/** Send a message to another agent */
	sendMessage(toAgentId: string, content: string): Promise<unknown> {
		return this._callTool("send_message", { agent_id: toAgentId, message: content });
	}

	/** Create a new child agent */
	createAgent(
		name: string,
		cwd?: string,
		model?: string,
		roles?: string[],
		tools?: string[],
		excludeTools?: string[],
	): Promise<unknown> {
		return this._callTool("create_agent", { name, cwd, model, roles, tools, excludeTools });
	}

	/** Destroy an agent */
	destroyAgent(agentId: string): Promise<unknown> {
		return this._callTool("destroy_agent", { agent_id: agentId });
	}

	/** Get the agent network snapshot */
	getNetwork(): Promise<AgentNetworkSnapshot> {
		return this._callTool("agent_network", {}) as Promise<AgentNetworkSnapshot>;
	}

	/** Create a new source */
	createSource(
		name: string,
		command: string,
		args?: string[],
		cwd?: string,
		env?: Record<string, string>,
	): Promise<unknown> {
		return this._callTool("create_source", { name, command, args, cwd, env });
	}

	/** Destroy a source */
	destroySource(name: string): Promise<unknown> {
		return this._callTool("destroy_source", { name });
	}

	/** Subscribe this agent to a source */
	subscribeSource(sourceName: string): Promise<unknown> {
		return this._callTool("subscribe_source", { source_name: sourceName });
	}

	/** Unsubscribe this agent from a source */
	unsubscribeSource(sourceName: string): Promise<unknown> {
		return this._callTool("unsubscribe_source", { source_name: sourceName });
	}

	/** List all available sources */
	listSources(): Promise<unknown> {
		return this._callTool("list_sources", {});
	}

	/** Resolve a pending tool call — called when Hub sends tool_result */
	resolveCall(callId: string, result: unknown): void {
		const pending = this._pendingCalls.get(callId);
		if (pending) {
			this._pendingCalls.delete(callId);
			clearTimeout((pending as typeof pending & { timer?: ReturnType<typeof setTimeout> }).timer);
			process.stderr.write(`[d-pi hub-channel] resolveCall callId=${callId}, result=${JSON.stringify(result)}\n`);
			pending.resolve(result);
		} else {
			process.stderr.write(`[d-pi hub-channel] resolveCall: no pending call for callId=${callId}\n`);
		}
	}

	/** Reject a pending tool call */
	rejectCall(callId: string, error: Error): void {
		const pending = this._pendingCalls.get(callId);
		if (pending) {
			this._pendingCalls.delete(callId);
			clearTimeout((pending as typeof pending & { timer?: ReturnType<typeof setTimeout> }).timer);
			pending.reject(error);
		}
	}

	private _callTool(tool: string, params: unknown): Promise<unknown> {
		const callId = `${this._agentId}-${++this._callIdCounter}`;
		return new Promise<unknown>((resolve, reject) => {
			this._pendingCalls.set(callId, { resolve, reject });
			this._postToHub({ type: "tool_call", agentId: this._agentId, tool, params, callId });
			// Timeout after 60s — clean up and notify hub
			const timer = setTimeout(() => {
				if (this._pendingCalls.has(callId)) {
					this._pendingCalls.delete(callId);
					this._postToHub({ type: "tool_call_timeout", agentId: this._agentId, callId });
					reject(new Error(`Tool call ${tool} timed out`));
				}
			}, 60_000);
			// Store timer so it can be cleared on resolve
			const pending = this._pendingCalls.get(callId);
			if (pending) {
				(pending as typeof pending & { timer: ReturnType<typeof setTimeout> }).timer = timer;
			}
		});
	}
}
