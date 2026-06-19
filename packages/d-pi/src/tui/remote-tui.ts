import { Container, Editor, type EditorTheme, ProcessTerminal, type Terminal, Text, TUI } from "@earendil-works/pi-tui";
import type { DPiJsonValue, DPiServiceEvent, DPiServiceSnapshot } from "../service/protocol.ts";
import { buildRemoteFooterView, type DPiRemoteFooterViewModel } from "./components/remote-footer.ts";
import { buildRemoteMessageListView, type DPiRemoteMessageListViewModel } from "./components/remote-message-list.ts";
import { DPiRemoteClient, type DPiRemoteClientConnectOptions, type DPiRemoteClientOptions } from "./remote-client.ts";

export type DPiRemoteTuiConnectionState = "disconnected" | "connecting" | "connected";

export interface DPiRemoteTuiClient {
	connect(options?: DPiRemoteClientConnectOptions): Promise<void>;
	disconnect(): void;
	onEvent(listener: (event: DPiServiceEvent) => void): () => void;
	getSnapshot(): DPiServiceSnapshot | undefined;
	getEvents(): readonly DPiServiceEvent[];
	getErrors(): readonly unknown[];
	prompt(text: string, options?: DPiJsonValue): Promise<void>;
	steer(text: string, options?: DPiJsonValue): Promise<void>;
	followUp(text: string, options?: DPiJsonValue): Promise<void>;
	setAgentName(agentName: string, options?: DPiRemoteClientConnectOptions): Promise<void>;
}

export interface DPiRemoteTuiViewModel {
	connectionState: DPiRemoteTuiConnectionState;
	messages: DPiRemoteMessageListViewModel;
	footer: DPiRemoteFooterViewModel;
	errors: readonly string[];
}

export interface DPiRemoteTuiControllerOptions {
	client: DPiRemoteTuiClient;
	onChange?: () => void;
}

export class DPiRemoteTuiController {
	private readonly client: DPiRemoteTuiClient;
	private readonly onChange: (() => void) | undefined;
	private unsubscribe: (() => void) | undefined;
	private connectionState: DPiRemoteTuiConnectionState = "disconnected";
	private readonly errors: unknown[] = [];

	constructor(options: DPiRemoteTuiControllerOptions) {
		this.client = options.client;
		this.onChange = options.onChange;
	}

	async start(): Promise<void> {
		if (this.connectionState !== "disconnected") {
			return;
		}
		this.connectionState = "connecting";
		try {
			await this.client.connect({ subscribe: true });
			this.unsubscribe = this.client.onEvent(() => {
				this.onChange?.();
			});
			this.connectionState = "connected";
			this.onChange?.();
		} catch (error) {
			this.unsubscribe?.();
			this.unsubscribe = undefined;
			this.connectionState = "disconnected";
			this.recordError(error);
			throw error;
		}
	}

	async submit(text: string): Promise<void> {
		const trimmed = text.trim();
		if (trimmed.length === 0) {
			return;
		}
		await this.runAction(() =>
			isStreamingOrBusy(this.client.getSnapshot()) ? this.client.steer(trimmed) : this.client.prompt(trimmed),
		);
	}

	async followUp(text: string): Promise<void> {
		const trimmed = text.trim();
		if (trimmed.length === 0) {
			return;
		}
		await this.runAction(() => this.client.followUp(trimmed));
	}

	async switchAgent(agentName: string): Promise<void> {
		const trimmed = agentName.trim();
		if (trimmed.length === 0) {
			return;
		}
		await this.runAction(() => this.client.setAgentName(trimmed, { subscribe: true }));
	}

	render(): DPiRemoteTuiViewModel {
		const snapshot = this.client.getSnapshot();
		const events = this.client.getEvents();
		return {
			connectionState: this.connectionState,
			messages: buildRemoteMessageListView({ snapshot, events }),
			footer: buildRemoteFooterView({ snapshot, connectionState: this.connectionState }),
			errors: [...this.errors.map(errorToText), ...this.client.getErrors().map(errorToText)],
		};
	}

	async stop(): Promise<void> {
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		this.client.disconnect();
		this.connectionState = "disconnected";
		this.onChange?.();
	}

	private async runAction(action: () => Promise<void>): Promise<void> {
		try {
			await action();
			this.onChange?.();
		} catch (error) {
			this.recordError(error);
		}
	}

	private recordError(error: unknown): void {
		this.errors.push(error);
		this.onChange?.();
	}
}

export function createDPiRemoteTuiController(options: DPiRemoteTuiControllerOptions): DPiRemoteTuiController {
	return new DPiRemoteTuiController(options);
}

export interface RunDPiRemoteTuiOptions {
	client?: DPiRemoteTuiClient;
	baseUrl?: string;
	agentName?: string;
	authHeaders?: Readonly<Record<string, string>>;
	fetch?: typeof fetch;
	terminal?: Terminal;
}

export interface DPiRemoteTuiRunHandle {
	controller: DPiRemoteTuiController;
	tui: TUI;
	stop(): Promise<void>;
}

const identity = (text: string): string => text;

const DEFAULT_EDITOR_THEME: EditorTheme = {
	borderColor: identity,
	selectList: {
		selectedPrefix: identity,
		selectedText: identity,
		description: identity,
		scrollInfo: identity,
		noMatch: identity,
	},
};

export async function runDPiRemoteTui(options: RunDPiRemoteTuiOptions): Promise<DPiRemoteTuiRunHandle> {
	const terminal = options.terminal ?? new ProcessTerminal();
	const tui = new TUI(terminal);
	const messages = new Text("", 0, 0);
	const footer = new Text("", 0, 0);
	const editor = new Editor(tui, DEFAULT_EDITOR_THEME);
	const root = new Container();
	root.addChild(messages);
	root.addChild(footer);
	root.addChild(editor);
	tui.addChild(root);
	tui.setFocus(editor);

	const client = options.client ?? createRemoteClientFromOptions(options);
	const controller = createDPiRemoteTuiController({
		client,
		onChange: () => {
			renderRemoteTuiView(controller.render(), messages, footer, terminal);
			tui.requestRender();
		},
	});

	editor.onSubmit = (text) => {
		void controller.submit(text);
	};

	await controller.start();
	renderRemoteTuiView(controller.render(), messages, footer, terminal);
	tui.start();

	return {
		controller,
		tui,
		stop: async () => {
			await controller.stop();
			tui.stop();
		},
	};
}

function createRemoteClientFromOptions(options: RunDPiRemoteTuiOptions): DPiRemoteClient {
	if (!options.baseUrl || !options.agentName) {
		throw new Error("runDPiRemoteTui requires baseUrl and agentName when no client is provided");
	}
	const clientOptions: DPiRemoteClientOptions = {
		baseUrl: options.baseUrl,
		agentName: options.agentName,
		...(options.authHeaders === undefined ? {} : { authHeaders: options.authHeaders }),
		...(options.fetch === undefined ? {} : { fetch: options.fetch }),
	};
	return new DPiRemoteClient(clientOptions);
}

function renderRemoteTuiView(view: DPiRemoteTuiViewModel, messages: Text, footer: Text, terminal: Terminal): void {
	const errorText =
		view.errors.length === 0 ? "" : `\n\nErrors:\n${view.errors.map((error) => `- ${error}`).join("\n")}`;
	messages.setText(`${view.messages.text}${errorText}`);
	footer.setText(view.footer.text);
	terminal.setProgress(isStreamingOrBusyFromView(view));
}

function isStreamingOrBusy(snapshot: DPiServiceSnapshot | undefined): boolean {
	const state = asRecord(snapshot?.state);
	if (!state) {
		return false;
	}
	return (
		booleanField(state, "streaming") === true ||
		booleanField(asRecord(state.streaming), "active") === true ||
		booleanField(state, "busy") === true ||
		(numberField(state, "queued") ?? 0) > 0 ||
		stringField(state, "status") === "busy"
	);
}

function isStreamingOrBusyFromView(view: DPiRemoteTuiViewModel): boolean {
	return view.footer.segments.includes("streaming") || view.footer.segments.includes("busy");
}

function errorToText(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	if (typeof error === "string") {
		return error;
	}
	return String(error);
}

function booleanField(record: Record<string, DPiJsonValue> | undefined, key: string): boolean | undefined {
	const value = record?.[key];
	return typeof value === "boolean" ? value : undefined;
}

function numberField(record: Record<string, DPiJsonValue> | undefined, key: string): number | undefined {
	const value = record?.[key];
	return typeof value === "number" ? value : undefined;
}

function stringField(record: Record<string, DPiJsonValue> | undefined, key: string): string | undefined {
	const value = record?.[key];
	return typeof value === "string" ? value : undefined;
}

function asRecord(value: DPiJsonValue | undefined): Record<string, DPiJsonValue> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
}
