export type SourceTransport = "stdio";

export interface SourceConfig {
	resourceId: string;
	/** Original resourceId in the config file when runtime ids are namespaced. */
	configResourceId?: string;
	/** Config file that owns this source entry. */
	configPath?: string;
	name: string;
	transport: SourceTransport;
	command: string;
	/** Inbound lines route to this agent. Omitted is treated as the main agent (`main`). */
	agentId?: string;
	args?: string[];
	cwd?: string;
	env?: Record<string, string>;
	disabled?: boolean;
}

export type HostResourceSelection = true | string[];

export interface ChildSourceExtends {
	host?: {
		sources?: HostResourceSelection;
	};
}

export type SourceRuntimeStatusKind = "starting" | "running" | "stopped" | "error";

export interface SourceRuntimeStatus {
	resourceId?: string;
	name: string;
	transport: "stdio";
	/** Target agent; mirrors config `agentId` with default `main` when omitted. */
	agentId: string;
	/** Source owner. */
	origin: "hub" | "peer";
	/** Peer id when `origin` is `peer`. */
	peerId?: string;
	status: SourceRuntimeStatusKind;
	error?: string;
}
