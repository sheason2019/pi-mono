import type { HubServeMode, HubTuiModeDeps } from "./hub-tui-mode.js";

export class HubHeadlessMode implements HubServeMode {
	private resolveRun: ((code: number) => void) | undefined;
	private stopped = false;

	constructor(private readonly deps: HubTuiModeDeps) {}

	async run(): Promise<number> {
		const view = this.deps.getView();
		console.log(`D-Pi hub listening on ${view.address}`);
		console.log(`Public org dashboard: ${view.address}/`);
		console.log(`Agent Web UI: ${view.address}/agents/root`);
		if (view.rootToken) {
			console.warn(`Root token: ${view.rootToken}`);
			console.warn("Root token is shown once; store it securely.");
		}
		this.registerSignals();
		return new Promise<number>((resolve) => {
			this.resolveRun = resolve;
		});
	}

	async stop(): Promise<void> {
		if (this.stopped) {
			return;
		}
		this.stopped = true;
		this.unregisterSignals();
		this.resolveRun?.(0);
	}

	private readonly handleSignal = (): void => {
		void this.stop();
	};

	private registerSignals(): void {
		process.once("SIGINT", this.handleSignal);
		process.once("SIGTERM", this.handleSignal);
	}

	private unregisterSignals(): void {
		process.off("SIGINT", this.handleSignal);
		process.off("SIGTERM", this.handleSignal);
	}
}
