import {
	buildDPiNativeFooterView,
	type DPiNativeFooterView,
	formatDPiNativeTokens,
} from "../native/components/footer.ts";
import { createDPiNativeTheme } from "../native/theme/theme.ts";
import type { DPiInteractiveSessionStateSnapshot } from "./agent-session-proxy.ts";
import type { DPiInteractiveStyleOptions } from "./style.ts";

export interface DPiInteractiveFooterView {
	lines: readonly string[];
	text: string;
}

export interface BuildDPiInteractiveFooterViewOptions extends DPiInteractiveStyleOptions {
	snapshot: DPiInteractiveSessionStateSnapshot;
	gitBranch?: string | null;
	width?: number;
}

export function formatDPiInteractiveTokens(count: number): string {
	return formatDPiNativeTokens(count);
}

export function buildDPiInteractiveFooterView(options: BuildDPiInteractiveFooterViewOptions): DPiInteractiveFooterView {
	const view: DPiNativeFooterView = buildDPiNativeFooterView({
		snapshot: normalizeFooterSnapshot(options.snapshot),
		gitBranch: options.gitBranch,
		width: options.width,
		theme: createDPiNativeTheme(options),
	});
	return { lines: view.lines, text: view.text };
}

function normalizeFooterSnapshot(snapshot: DPiInteractiveSessionStateSnapshot): DPiInteractiveSessionStateSnapshot {
	const displayModel = displayModelName(
		snapshot.modelInfo.provider,
		snapshot.modelInfo.id || snapshot.model || "no-model",
	);
	return {
		...snapshot,
		modelInfo: {
			...snapshot.modelInfo,
			id: displayModel.text,
			provider: displayModel.provider,
		},
	};
}

function displayModelName(provider: string, modelId: string): { provider: string; text: string } {
	const slashIndex = modelId.indexOf("/");
	if (provider === "openrouter" && slashIndex > 0) {
		return {
			provider: modelId.slice(0, slashIndex),
			text: modelId.slice(slashIndex + 1),
		};
	}
	return { provider, text: modelId };
}
