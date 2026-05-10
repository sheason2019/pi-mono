import { Container, getKeybindings, ProcessTerminal, Text, TUI } from "@earendil-works/pi-tui";
import { type HubTuiViewModel, renderHubLogLines, renderHubTuiLines } from "./hub-tui-view.js";

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

export class HubTuiMode implements HubServeMode {
	private static readonly DEFAULT_AUTO_REFRESH_INTERVAL_MS = 1000;
	private readonly ui = new TUI(new ProcessTerminal(), false);
	private readonly root = new Container();
	private readonly text = new Text("", 0, 0);
	private unsubs: Array<() => void> = [];
	private resolveRun: ((code: number) => void) | undefined;
	private autoRefreshTimer: ReturnType<typeof setInterval> | undefined;
	private stopped = false;
	private isShuttingDown = false;
	private logScrollOffsetFromBottom = 0;
	private viewMode: "status" | "logs" = "status";

	constructor(private readonly deps: HubTuiModeDeps) {
		this.root.addChild(this.text);
		this.ui.addChild(this.root);
	}

	async run(): Promise<number> {
		this.registerSignals();
		this.ui.start();
		this.unsubs.push(this.deps.subscribe(() => this.render()));
		this.unsubs.push(
			this.ui.addInputListener((data) => {
				if (data === "l") {
					this.viewMode = "logs";
					this.logScrollOffsetFromBottom = 0;
					this.render();
					return { consume: true };
				}
				if (data === "q" && this.viewMode === "logs") {
					this.viewMode = "status";
					this.render();
					return { consume: true };
				}
				if (data === "q" || getKeybindings().matches(data, "tui.input.copy")) {
					void this.shutdown();
					return { consume: true };
				}
				if (this.handleScrollInput(data)) {
					return { consume: true };
				}
				return undefined;
			}),
		);
		this.render();
		this.startAutoRefresh();
		return new Promise<number>((resolve) => {
			this.resolveRun = resolve;
		});
	}

	async stop(): Promise<void> {
		if (this.stopped) {
			return;
		}
		this.stopped = true;
		if (this.autoRefreshTimer) {
			clearInterval(this.autoRefreshTimer);
			this.autoRefreshTimer = undefined;
		}
		this.unregisterSignals();
		for (const unsub of this.unsubs.splice(0)) {
			unsub();
		}
		await this.ui.terminal.drainInput(1000);
		this.ui.stop();
	}

	private async shutdown(): Promise<void> {
		if (this.isShuttingDown) {
			return;
		}
		this.isShuttingDown = true;
		await this.stop();
		this.resolveRun?.(0);
	}

	private startAutoRefresh(): void {
		const intervalMs = this.deps.autoRefreshIntervalMs ?? HubTuiMode.DEFAULT_AUTO_REFRESH_INTERVAL_MS;
		if (intervalMs <= 0) {
			return;
		}
		this.autoRefreshTimer = setInterval(() => this.render(), intervalMs);
	}

	private render(): void {
		const size = this.getTerminalSize();
		this.text.setText(
			renderHubTuiLines(this.deps.getView(), size.columns ?? 100, size.rows, {
				mode: this.viewMode,
				logScrollOffsetFromBottom: this.logScrollOffsetFromBottom,
				color: true,
			}).join("\n"),
		);
		this.ui.requestRender();
	}

	private handleScrollInput(data: string): boolean {
		if (this.viewMode !== "logs") {
			return false;
		}
		const kb = getKeybindings();
		const view = this.deps.getView();
		const pageSize = this.getLogPageSize(view);
		if (kb.matches(data, "tui.editor.cursorUp")) {
			this.scrollLogs(1, view);
			return true;
		}
		if (kb.matches(data, "tui.editor.cursorDown")) {
			this.scrollLogs(-1, view);
			return true;
		}
		if (kb.matches(data, "tui.editor.pageUp")) {
			this.scrollLogs(pageSize, view);
			return true;
		}
		if (kb.matches(data, "tui.editor.pageDown")) {
			this.scrollLogs(-pageSize, view);
			return true;
		}
		if (kb.matches(data, "tui.editor.cursorLineEnd")) {
			this.logScrollOffsetFromBottom = 0;
			this.render();
			return true;
		}
		return false;
	}

	private scrollLogs(delta: number, view: HubTuiViewModel): void {
		this.logScrollOffsetFromBottom = Math.min(
			Math.max(0, this.logScrollOffsetFromBottom + delta),
			this.getMaxLogScrollOffset(view),
		);
		this.render();
	}

	private getMaxLogScrollOffset(view: HubTuiViewModel): number {
		return Math.max(0, renderHubLogLines(view).length - this.getLogPageSize(view));
	}

	private getLogPageSize(_view: HubTuiViewModel): number {
		const rows = this.getTerminalSize().rows;
		return Math.max(1, (rows ?? 24) - 5);
	}

	private getTerminalSize(): { columns?: number; rows?: number } {
		return this.deps.getTerminalSize?.() ?? { columns: process.stdout.columns || 100, rows: process.stdout.rows };
	}

	private readonly onSignal = () => {
		void this.shutdown();
	};

	private registerSignals(): void {
		process.on("SIGINT", this.onSignal);
		process.on("SIGTERM", this.onSignal);
	}

	private unregisterSignals(): void {
		process.off("SIGINT", this.onSignal);
		process.off("SIGTERM", this.onSignal);
	}
}
