import type { DPiInteractiveBannerData } from "./agent-session-proxy.ts";
import { createDPiInteractiveStyle, type DPiInteractiveStyleOptions } from "./style.ts";

export interface DPiInteractiveBannerView {
	text: string;
}

export interface DPiInteractiveBannerViewOptions extends DPiInteractiveStyleOptions {
	expanded?: boolean;
}

export function buildDPiInteractiveBannerView(
	banner: DPiInteractiveBannerData | undefined,
	options: DPiInteractiveBannerViewOptions = {},
): DPiInteractiveBannerView {
	if (!banner) {
		return { text: "" };
	}
	const style = createDPiInteractiveStyle(options);
	const hints = options.expanded
		? style.dim(banner.expandedHints.map((hint) => `${hint.key} ${hint.description}`).join("\n "))
		: style.dim(banner.compactHints.map((hint) => `${hint.key} ${hint.description}`).join(" · "));
	const resources = banner.loadedResources.flatMap((section) => [
		style.heading(`[${section.name}]`),
		style.dim(`  ${section.compactList}`),
		"",
	]);
	const diagnostics = banner.diagnostics.flatMap((section) => [
		style.warning(`[${section.label}]`),
		...section.entries.flatMap((entry) => diagnosticLines(entry, options)),
		"",
	]);
	return {
		text: [
			"",
			` ${style.accent(banner.appName)}${style.dim(` v${banner.version}`)}`,
			` ${hints}`,
			options.expanded ? undefined : ` ${style.dim(banner.compactOnboarding)}`,
			"",
			` ${style.dim(banner.onboarding)}`,
			"",
			"",
			...resources,
			...diagnostics,
			banner.changelogMarkdown ? styleStartupNotices(banner.changelogMarkdown, options) : undefined,
		]
			.filter((line): line is string => typeof line === "string")
			.join("\n"),
	};
}

function diagnosticLines(
	entry: DPiInteractiveBannerData["diagnostics"][number]["entries"][number],
	options: DPiInteractiveStyleOptions,
): string[] {
	const style = createDPiInteractiveStyle(options);
	if (entry.type === "collision" && entry.collision) {
		const collision = entry.collision;
		return [
			style.warning(`  "${collision.name}" collision:`),
			`    ${style.success("✓")} ${style.dim(`auto (${collision.winnerSource ?? "local"}) ${collision.winnerPath}`)}`,
			`    ${style.warning("✗")} ${style.dim(`${collision.loserPath} (skipped)`)}`,
		];
	}
	return [style.warning(`  ${entry.message}`)];
}

function styleStartupNotices(text: string, options: DPiInteractiveStyleOptions): string {
	const style = createDPiInteractiveStyle(options);
	return text
		.split("\n")
		.map((line) => {
			if (line.includes("Update Available") || line.startsWith("─")) {
				return style.warning(line);
			}
			if (line.includes("Warning:")) {
				return style.warning(line);
			}
			return style.dim(line);
		})
		.join("\n");
}
