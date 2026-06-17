import type { GroupArchitectureSnapshot, WorkerToHubMessage } from "../types.ts";

/**
 * Message routing mode — mirrors the user-facing TUI Enter / Ctrl+Enter
 * distinction. `next` queues the message at the start of the next agent
 * turn (default, equivalent to pressing Enter in the TUI). `steer`
 * interrupts the current turn to inject the message immediately
 * (equivalent to Ctrl+Enter in the TUI).
 *
 * Internal deliverAs routing (steer queue / followUp queue / new turn)
 * is owned by the downstream extension — callers (sources, the
 * send_message tool) just declare which mode they want.
 */
type MessageMode = "next" | "steer";

type IncomingMessageHandler = (content: string, sourceName?: string, mode?: MessageMode) => void;

/**
 * Communication channel from extension tools to the Hub.
 *
 * Each worker creates a HubChannel with its agentName and a postToHub
 * callback (which calls parentPort.postMessage). Tools call channel
 * methods which post tool_call messages to the Hub and return Promises
 * that resolve when the Hub sends back tool_result with the matching
 * callId. The "agentName" field on tool_call / tool_call_timeout
 * messages is the agent's identity (name is the unique key — see
 * "name is identity" in the changelog).
 */
export class HubChannel {
	private readonly _agentName: string;
	private readonly _postToHub: (message: WorkerToHubMessage) => void;
	private readonly _pendingCalls = new Map<
		string,
		{ resolve: (result: unknown) => void; reject: (error: Error) => void }
	>();
	private _callIdCounter = 0;
	private _onIncomingMessage?: IncomingMessageHandler;

	constructor(agentName: string, postToHub: (message: WorkerToHubMessage) => void) {
		this._agentName = agentName;
		this._postToHub = postToHub;
	}

	get agentName(): string {
		return this._agentName;
	}

	/** Register handler for incoming messages from the Hub */
	onIncomingMessage(handler: IncomingMessageHandler): void {
		this._onIncomingMessage = handler;
	}

	/** Deliver an incoming message — called by agent-worker, handled by extension */
	deliverMessage(content: string, sourceName?: string, mode?: MessageMode): void {
		this._onIncomingMessage?.(content, sourceName, mode);
	}

	/** Send a message to another agent (by name). mode defaults to "next" (Enter-style). */
	sendMessage(toAgentName: string, content: string, mode: MessageMode = "next"): Promise<unknown> {
		return this._callTool("send_message", { agent_id: toAgentName, message: content, mode });
	}

	/** Create a new child agent */
	createAgent(
		name: string,
		cwd?: string,
		model?: string,
		roles?: string[],
		includeTools?: string[],
		excludeTools?: string[],
	): Promise<unknown> {
		return this._callTool("create_agent", { name, cwd, model, roles, includeTools, excludeTools });
	}

	/** Destroy an agent (by name) */
	destroyAgent(agentName: string): Promise<unknown> {
		return this._callTool("destroy_agent", { agent_id: agentName });
	}

	/** Get the group architecture snapshot */
	getGroupArchitecture(): Promise<GroupArchitectureSnapshot> {
		return this._callTool("group_architecture", {}) as Promise<GroupArchitectureSnapshot>;
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

	/**
	 * Dispatch a tool call to a specific connected executor (by
	 * connect_id). The hub verifies the connect_id, routes the call
	 * to the matching executor registry entry, which sends a
	 * `remote-call` event over SSE to the client.
	 *
	 * `tool` is the native tool name ("bash", "read", etc.).
	 * `params` must match that tool's schema (without connect_id).
	 * `connectId` identifies which connected client to dispatch to.
	 */
	callDispatch(tool: string, params: unknown, connectId: string): Promise<unknown> {
		return this._callTool("dispatch", { tool, params, connect_id: connectId });
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
		// callId is scoped to this worker; the agentName prefix is for log
		// readability and to make overlapping tool calls from different
		// workers trivially distinguishable in the hub's stderr.
		const callId = `${this._agentName}-${++this._callIdCounter}`;
		return new Promise<unknown>((resolve, reject) => {
			this._pendingCalls.set(callId, { resolve, reject });
			this._postToHub({ type: "tool_call", agentName: this._agentName, tool, params, callId });
			// Timeout after 60s — clean up and notify hub
			const timer = setTimeout(() => {
				if (this._pendingCalls.has(callId)) {
					this._pendingCalls.delete(callId);
					this._postToHub({ type: "tool_call_timeout", agentName: this._agentName, callId });
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
