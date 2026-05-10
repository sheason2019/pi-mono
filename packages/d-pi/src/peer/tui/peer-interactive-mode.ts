import type { PeerRuntime } from "../runtime/peer-runtime.js";
import { ForkedInteractiveMode } from "./forked/interactive-mode.js";
import { createRemoteInteractiveController } from "./interactive/remote-interactive-controller.js";

export interface PeerInteractiveModeOptions {
	themeName?: string;
}

export class PeerInteractiveMode {
	private readonly controller;
	private readonly mode: ForkedInteractiveMode;

	constructor(
		private readonly runtime: PeerRuntime,
		options: PeerInteractiveModeOptions = {},
	) {
		this.controller = createRemoteInteractiveController(this.runtime);
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
