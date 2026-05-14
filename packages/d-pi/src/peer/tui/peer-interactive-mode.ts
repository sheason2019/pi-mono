import type { PeerAppState } from "../state/peer-app-state.js";
import type { PeerUiState } from "../state/peer-ui-state.js";
import { ForkedInteractiveMode } from "./forked/interactive-mode.js";
import type { RemoteInteractiveCapabilities } from "./interactive/remote-interactive-capabilities.js";
import {
	createRemoteInteractiveController,
	type RemoteInteractiveRuntimeBridge,
} from "./interactive/remote-interactive-controller.js";

export interface PeerInteractiveRuntime extends RemoteInteractiveRuntimeBridge {
	appState: PeerAppState;
	uiState: PeerUiState;
	start(): Promise<void>;
	stop(): Promise<void>;
}

export interface PeerInteractiveModeOptions {
	themeName?: string;
	capabilities?: Partial<RemoteInteractiveCapabilities>;
}

export class PeerInteractiveMode {
	private readonly controller;
	private readonly mode: ForkedInteractiveMode;

	constructor(
		private readonly runtime: PeerInteractiveRuntime,
		options: PeerInteractiveModeOptions = {},
	) {
		this.controller = createRemoteInteractiveController(this.runtime, options.capabilities);
		this.mode = new ForkedInteractiveMode(
			{
				peerId: this.runtime.hello.peerId,
				cwd: this.runtime.hello.cwd ?? process.cwd(),
				getView: () => this.controller.getView(),
				actions: this.controller.actions,
				capabilities: this.controller.capabilities,
				getDraft: () => this.runtime.uiState.getSnapshot().draft,
				setDraft: (draft: string) => this.runtime.uiState.setDraft(draft),
				subscribe: (listener: () => void) => {
					const unsubscribers = [
						this.runtime.appState.subscribe(() => listener()),
						this.runtime.uiState.subscribe(() => listener()),
					];
					return () => {
						for (const unsubscribe of unsubscribers) {
							unsubscribe();
						}
					};
				},
			},
			options,
		);
	}

	async run(): Promise<number> {
		await this.runtime.start();
		try {
			return await this.mode.run();
		} finally {
			await this.runtime.stop();
		}
	}

	async stop(): Promise<void> {
		await this.mode.stop();
	}
}
