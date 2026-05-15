import { type Component, truncateToWidth, visibleWidth } from "@sheason/pi-tui";
import { theme } from "../../components/index.js";
import type { RemoteInteractiveView } from "../../interactive/remote-interactive-view.js";
import { keyText } from "./keybinding-hints.js";

function sanitizeStatusText(text: string): string {
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

function formatConnectionMessage(view: RemoteInteractiveView): string | undefined {
	const message = view.status.connectionMessage;
	if (!message) {
		return undefined;
	}
	if (view.connection.state === "reconnecting") {
		return `${message} ${keyText("app.connection.retry")} to retry now`;
	}
	return message;
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

function formatContextUsage(
	contextWindow: number | undefined,
	contextUsage: RemoteInteractiveView["footer"]["contextUsage"],
): string | undefined {
	if (!contextWindow || contextWindow <= 0) {
		return undefined;
	}

	const autoIndicator = " (auto)";
	const percentValue = contextUsage?.percent ?? 0;
	const contextDisplay =
		contextUsage?.percent === null || contextUsage?.percent === undefined
			? `?/${formatTokens(contextWindow)}${autoIndicator}`
			: `${contextUsage.percent.toFixed(1)}%/${formatTokens(contextWindow)}${autoIndicator}`;

	if (percentValue > 90) {
		return theme.fg("error", contextDisplay);
	}
	if (percentValue > 70) {
		return theme.fg("warning", contextDisplay);
	}
	return contextDisplay;
}

export class ForkedFooterComponent implements Component {
	private view: RemoteInteractiveView = {
		connection: { state: "idle" },
		peers: [],
		footer: {
			cwd: "",
			modelLabel: "no-model",
			queueSummary: "queued 0",
			pendingToolCount: 0,
			peerCount: 0,
			isRunning: false,
			peerId: "unknown-peer",
			boundAgentId: "root",
		},
		status: { diagnostics: [] },
		commands: [],
	};
	private cachedSignature = "";
	private cachedWidth = 0;
	private cachedLines: string[] | undefined;

	setView(view: RemoteInteractiveView): void {
		this.view = view;
		const signature = getFooterRenderSignature(view);
		if (this.cachedSignature !== signature) {
			this.cachedSignature = signature;
			this.cachedLines = undefined;
		}
	}

	invalidate(): void {
		this.cachedLines = undefined;
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}
		const { footer, status } = this.view;
		const sessionId = footer.sessionId ? footer.sessionId.slice(0, 8) : "no-session";
		const pwdLine = truncateToWidth(theme.fg("dim", `${footer.cwd} • ${sessionId}`), width, theme.fg("dim", "..."));

		const statsParts = [
			this.view.connection.state,
			footer.isRunning ? "running" : "idle",
			`agent ${footer.boundAgentId}`,
			`${footer.peerCount} peers`,
		];
		if (footer.pendingToolCount > 0) {
			statsParts.push(`${footer.pendingToolCount} pending`);
		}
		const contextDisplay = formatContextUsage(footer.contextWindow, footer.contextUsage);
		if (contextDisplay) {
			statsParts.push(contextDisplay);
		}

		const bottom = joinLeftRight(statsParts.join(" • "), footer.modelLabel, width);
		const lines = [pwdLine, theme.fg("dim", bottom)];

		const extraStatuses = [formatConnectionMessage(this.view), ...status.diagnostics, status.lastError]
			.filter((value): value is string => typeof value === "string" && value.length > 0)
			.map((value) => sanitizeStatusText(value));
		if (extraStatuses.length > 0) {
			lines.push(truncateToWidth(extraStatuses.join(" • "), width, theme.fg("dim", "...")));
		}

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}
}

function getFooterRenderSignature(view: RemoteInteractiveView): string {
	const footer = view.footer;
	return [
		view.connection.state,
		view.status.connectionMessage,
		view.status.lastError,
		view.status.diagnostics.join("\u0001"),
		footer.cwd,
		footer.modelLabel,
		footer.pendingToolCount,
		footer.peerCount,
		footer.isRunning,
		footer.boundAgentId,
		footer.sessionId,
		footer.contextWindow,
		footer.contextUsage?.percent,
	].join("\u0002");
}

function joinLeftRight(left: string, right: string, width: number): string {
	const safeLeft = truncateToWidth(left, width, "");
	const leftWidth = visibleWidth(safeLeft);
	const rightWidth = visibleWidth(right);
	if (leftWidth + 2 + rightWidth <= width) {
		return `${safeLeft}${" ".repeat(width - leftWidth - rightWidth)}${right}`;
	}
	const availableForRight = Math.max(0, width - leftWidth - 2);
	if (availableForRight === 0) {
		return safeLeft;
	}
	return `${safeLeft}  ${truncateToWidth(right, availableForRight, "")}`;
}
