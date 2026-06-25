import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { DPiInteractiveSessionStateSnapshot } from "../../interactive/agent-session-proxy.ts";
import { createDPiNativeTheme, type DPiNativeTheme } from "../theme/theme.ts";

export interface DPiNativeFooterView {
	lines: readonly string[];
	text: string;
}

export interface BuildDPiNativeFooterViewOptions {
	snapshot: DPiInteractiveSessionStateSnapshot;
	gitBranch?: string | null;
	width?: number;
	theme?: DPiNativeTheme;
}

export function formatDPiNativeTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

export function buildDPiNativeFooterView(options: BuildDPiNativeFooterViewOptions): DPiNativeFooterView {
	const { snapshot } = options;
	const theme = options.theme ?? createDPiNativeTheme();
	const width = options.width ?? Number.POSITIVE_INFINITY;
	let pwdDisplay = options.gitBranch ? `${snapshot.cwd} (${options.gitBranch})` : snapshot.cwd;
	if (snapshot.sessionName) {
		pwdDisplay = `${pwdDisplay} • ${snapshot.sessionName}`;
	}

	const statsParts = buildStatsParts(snapshot, theme);
	let statsLeft = statsParts.join(" ");
	let statsLeftWidth = visibleWidth(statsLeft);
	if (statsLeftWidth > width) {
		statsLeft = truncateToWidth(statsLeft, width, "...");
		statsLeftWidth = visibleWidth(statsLeft);
	}

	const minPadding = 2;
	const rightSideWithoutProvider = snapshot.modelInfo.id || "no-model";

	let rightSide = rightSideWithoutProvider;
	if (snapshot.availableProviderCount > 1 && snapshot.modelInfo.provider) {
		rightSide = `(${snapshot.modelInfo.provider}) ${rightSideWithoutProvider}`;
		if (statsLeftWidth + minPadding + visibleWidth(rightSide) > width) {
			rightSide = rightSideWithoutProvider;
		}
	}

	const statsLine = alignStatsLine(statsLeft, rightSide, width);
	const dimStatsLeft = theme.fg("dim", statsLeft);
	const remainder = statsLine.slice(statsLeft.length);
	const dimRemainder = theme.fg("dim", remainder);
	const pwdLine = truncateToWidth(theme.fg("dim", pwdDisplay), width, theme.fg("dim", "..."));
	const lines = [pwdLine, dimStatsLeft + dimRemainder];
	return { lines, text: lines.join("\n") };
}

function buildStatsParts(snapshot: DPiInteractiveSessionStateSnapshot, theme: DPiNativeTheme): string[] {
	const { tokenUsage, contextUsage } = snapshot;
	const statsParts: string[] = [];
	if (tokenUsage.input) statsParts.push(`↑${formatDPiNativeTokens(tokenUsage.input)}`);
	if (tokenUsage.output) statsParts.push(`↓${formatDPiNativeTokens(tokenUsage.output)}`);
	if (tokenUsage.cacheRead) statsParts.push(`R${formatDPiNativeTokens(tokenUsage.cacheRead)}`);
	if (tokenUsage.cacheWrite) statsParts.push(`W${formatDPiNativeTokens(tokenUsage.cacheWrite)}`);
	if ((tokenUsage.cacheRead > 0 || tokenUsage.cacheWrite > 0) && tokenUsage.latestCacheHitRate !== undefined) {
		statsParts.push(`CH${tokenUsage.latestCacheHitRate.toFixed(1)}%`);
	}
	if (tokenUsage.cost || tokenUsage.usingSubscription) {
		statsParts.push(`$${tokenUsage.cost.toFixed(3)}${tokenUsage.usingSubscription ? " (sub)" : ""}`);
	}

	const contextPercentValue = contextUsage.percent ?? 0;
	const contextPercent = contextUsage.percent !== null ? contextPercentValue.toFixed(1) : "?";
	const autoIndicator = snapshot.autoCompactEnabled ? " (auto)" : "";
	const contextPercentDisplay =
		contextPercent === "?"
			? `?/${formatDPiNativeTokens(contextUsage.contextWindow)}${autoIndicator}`
			: `${contextPercent}%/${formatDPiNativeTokens(contextUsage.contextWindow)}${autoIndicator}`;
	if (contextPercentValue > 90) {
		statsParts.push(theme.fg("error", contextPercentDisplay));
	} else if (contextPercentValue > 70) {
		statsParts.push(theme.fg("warning", contextPercentDisplay));
	} else {
		statsParts.push(contextPercentDisplay);
	}
	return statsParts;
}

function alignStatsLine(left: string, right: string, width: number): string {
	const leftWidth = visibleWidth(left);
	const minPadding = 2;
	const rightWidth = visibleWidth(right);
	const totalNeeded = leftWidth + minPadding + rightWidth;
	if (totalNeeded <= width) {
		return left + " ".repeat(width - leftWidth - rightWidth) + right;
	}

	const availableForRight = width - leftWidth - minPadding;
	if (availableForRight <= 0) {
		return left;
	}
	const truncatedRight = truncateToWidth(right, availableForRight, "");
	const truncatedRightWidth = visibleWidth(truncatedRight);
	return left + " ".repeat(Math.max(0, width - leftWidth - truncatedRightWidth)) + truncatedRight;
}
