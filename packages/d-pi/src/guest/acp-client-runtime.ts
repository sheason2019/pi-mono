import * as acp from "@agentclientprotocol/sdk";

export interface AcpClientRuntimeOptions {
	stream: acp.Stream;
	cwd: string;
	onSessionUpdate?: (notification: acp.SessionNotification) => void | Promise<void>;
}

export class AcpClientRuntime {
	private readonly connection: acp.ClientSideConnection;
	private sessionId: string | undefined;

	constructor(private readonly options: AcpClientRuntimeOptions) {
		this.connection = new acp.ClientSideConnection(
			() => ({
				requestPermission: async (params) => this.requestPermission(params),
				sessionUpdate: async (params) => {
					await this.options.onSessionUpdate?.(params);
				},
			}),
			options.stream,
		);
	}

	async start(): Promise<void> {
		await this.connection.initialize({
			protocolVersion: acp.PROTOCOL_VERSION,
			clientCapabilities: {
				fs: {
					readTextFile: false,
					writeTextFile: false,
				},
				terminal: false,
			},
		});
		const session = await this.connection.newSession({
			cwd: this.options.cwd,
			mcpServers: [],
		});
		this.sessionId = session.sessionId;
	}

	async prompt(text: string): Promise<acp.PromptResponse> {
		if (!this.sessionId) {
			throw new Error("ACP session is not started.");
		}
		return this.connection.prompt({
			sessionId: this.sessionId,
			prompt: [{ type: "text", text }],
		});
	}

	async cancel(): Promise<void> {
		if (!this.sessionId) {
			return;
		}
		await this.connection.cancel({ sessionId: this.sessionId });
	}

	async stop(): Promise<void> {
		await this.cancel().catch(() => {});
	}

	private async requestPermission(params: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
		const allow =
			params.options.find((option) => option.kind === "allow_always") ??
			params.options.find((option) => option.kind === "allow_once");
		if (allow) {
			return { outcome: { outcome: "selected", optionId: allow.optionId } };
		}
		const reject =
			params.options.find((option) => option.kind === "reject_once") ??
			params.options.find((option) => option.kind === "reject_always");
		if (reject) {
			return { outcome: { outcome: "selected", optionId: reject.optionId } };
		}
		return { outcome: { outcome: "cancelled" } };
	}
}
