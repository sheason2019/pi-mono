import type { HubTuiViewModel } from "./hub-tui-view.js";

export interface HubTuiModeDeps {
	getView(): HubTuiViewModel;
	subscribe(listener: () => void): () => void;
	autoRefreshIntervalMs?: number;
	getTerminalSize?: () => { columns?: number; rows?: number };
}

export interface HubServeMode {
	run(): Promise<number>;
	stop(): Promise<void>;
}
