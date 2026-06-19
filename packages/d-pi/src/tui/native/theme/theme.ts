import { type EditorTheme, getCapabilities, type MarkdownTheme, type SelectListTheme } from "@earendil-works/pi-tui";

export type DPiNativeColorMode = "truecolor" | "256color";

export type DPiNativeThemeColor =
	| "accent"
	| "border"
	| "borderAccent"
	| "borderMuted"
	| "success"
	| "error"
	| "warning"
	| "muted"
	| "dim"
	| "text"
	| "thinkingText"
	| "userMessageText"
	| "customMessageText"
	| "customMessageLabel"
	| "toolTitle"
	| "toolOutput"
	| "mdHeading"
	| "mdLink"
	| "mdLinkUrl"
	| "mdCode"
	| "mdCodeBlock"
	| "mdCodeBlockBorder"
	| "mdQuote"
	| "mdQuoteBorder"
	| "mdHr"
	| "mdListBullet"
	| "toolDiffAdded"
	| "toolDiffRemoved"
	| "toolDiffContext"
	| "syntaxComment"
	| "syntaxKeyword"
	| "syntaxFunction"
	| "syntaxVariable"
	| "syntaxString"
	| "syntaxNumber"
	| "syntaxType"
	| "syntaxOperator"
	| "syntaxPunctuation";

export type DPiNativeThemeBg = "selectedBg" | "userMessageBg" | "toolPendingBg" | "toolSuccessBg" | "toolErrorBg";

export interface DPiNativeThemeOptions {
	color?: boolean;
	colorMode?: DPiNativeColorMode;
}

export interface DPiNativeTheme {
	fg(color: DPiNativeThemeColor, text: string): string;
	bg(color: DPiNativeThemeBg, text: string): string;
	bold(text: string): string;
	italic(text: string): string;
	underline(text: string): string;
	strikethrough(text: string): string;
	inverse(text: string): string;
	getColorMode(): DPiNativeColorMode;
}

const FG_COLORS: Record<DPiNativeThemeColor, string> = {
	accent: "#8abeb7",
	border: "#5f87ff",
	borderAccent: "#00d7ff",
	borderMuted: "#505050",
	success: "#b5bd68",
	error: "#cc6666",
	warning: "#ffff00",
	muted: "#808080",
	dim: "#666666",
	text: "#d4d4d4",
	thinkingText: "#808080",
	userMessageText: "#d4d4d4",
	customMessageText: "#d4d4d4",
	customMessageLabel: "#8abeb7",
	toolTitle: "#d4d4d4",
	toolOutput: "#808080",
	mdHeading: "#f0c674",
	mdLink: "#81a2be",
	mdLinkUrl: "#666666",
	mdCode: "#8abeb7",
	mdCodeBlock: "#b5bd68",
	mdCodeBlockBorder: "#808080",
	mdQuote: "#808080",
	mdQuoteBorder: "#808080",
	mdHr: "#808080",
	mdListBullet: "#8abeb7",
	toolDiffAdded: "#b5bd68",
	toolDiffRemoved: "#cc6666",
	toolDiffContext: "#808080",
	syntaxComment: "#666666",
	syntaxKeyword: "#b294bb",
	syntaxFunction: "#81a2be",
	syntaxVariable: "#d4d4d4",
	syntaxString: "#b5bd68",
	syntaxNumber: "#de935f",
	syntaxType: "#f0c674",
	syntaxOperator: "#8abeb7",
	syntaxPunctuation: "#d4d4d4",
};

const BG_COLORS: Record<DPiNativeThemeBg, string> = {
	selectedBg: "#3a3a4a",
	userMessageBg: "#343541",
	toolPendingBg: "#282832",
	toolSuccessBg: "#283228",
	toolErrorBg: "#3c2828",
};

class DPiNativeThemeImpl implements DPiNativeTheme {
	private readonly enabled: boolean;
	private readonly mode: DPiNativeColorMode;

	constructor(options: DPiNativeThemeOptions = {}) {
		this.enabled = options.color === true;
		this.mode = options.colorMode ?? (getCapabilities().trueColor ? "truecolor" : "256color");
	}

	fg(color: DPiNativeThemeColor, text: string): string {
		if (!this.enabled || text.length === 0) {
			return text;
		}
		return `${fgAnsi(FG_COLORS[color], this.mode)}${text}\x1b[39m`;
	}

	bg(color: DPiNativeThemeBg, text: string): string {
		if (!this.enabled || text.length === 0) {
			return text;
		}
		return `${bgAnsi(BG_COLORS[color], this.mode)}${text}\x1b[49m`;
	}

	bold(text: string): string {
		return this.enabled && text.length > 0 ? `\x1b[1m${text}\x1b[22m` : text;
	}

	italic(text: string): string {
		return this.enabled && text.length > 0 ? `\x1b[3m${text}\x1b[23m` : text;
	}

	underline(text: string): string {
		return this.enabled && text.length > 0 ? `\x1b[4m${text}\x1b[24m` : text;
	}

	strikethrough(text: string): string {
		return this.enabled && text.length > 0 ? `\x1b[9m${text}\x1b[29m` : text;
	}

	inverse(text: string): string {
		return this.enabled && text.length > 0 ? `\x1b[7m${text}\x1b[27m` : text;
	}

	getColorMode(): DPiNativeColorMode {
		return this.mode;
	}
}

export function createDPiNativeTheme(options: DPiNativeThemeOptions = {}): DPiNativeTheme {
	return new DPiNativeThemeImpl(options);
}

export function getDPiNativeMarkdownTheme(theme: DPiNativeTheme = createDPiNativeTheme()): MarkdownTheme {
	return {
		heading: (text) => theme.fg("mdHeading", text),
		link: (text) => theme.fg("mdLink", text),
		linkUrl: (text) => theme.fg("mdLinkUrl", text),
		code: (text) => theme.fg("mdCode", text),
		codeBlock: (text) => theme.fg("mdCodeBlock", text),
		codeBlockBorder: (text) => theme.fg("mdCodeBlockBorder", text),
		quote: (text) => theme.fg("mdQuote", text),
		quoteBorder: (text) => theme.fg("mdQuoteBorder", text),
		hr: (text) => theme.fg("mdHr", text),
		listBullet: (text) => theme.fg("mdListBullet", text),
		bold: (text) => theme.bold(text),
		italic: (text) => theme.italic(text),
		underline: (text) => theme.underline(text),
		strikethrough: (text) => theme.strikethrough(text),
	};
}

export function getDPiNativeEditorTheme(theme: DPiNativeTheme = createDPiNativeTheme()): EditorTheme {
	return {
		borderColor: (text) => theme.fg("borderMuted", text),
		selectList: getDPiNativeSelectListTheme(theme),
	};
}

export function getDPiNativeSelectListTheme(theme: DPiNativeTheme = createDPiNativeTheme()): SelectListTheme {
	return {
		selectedPrefix: (text) => theme.fg("accent", text),
		selectedText: (text) => theme.fg("accent", text),
		description: (text) => theme.fg("muted", text),
		scrollInfo: (text) => theme.fg("muted", text),
		noMatch: (text) => theme.fg("muted", text),
	};
}

function fgAnsi(hex: string, mode: DPiNativeColorMode): string {
	if (mode === "256color") {
		return `\x1b[38;5;${hexTo256(hex)}m`;
	}
	const { r, g, b } = hexToRgb(hex);
	return `\x1b[38;2;${r};${g};${b}m`;
}

function bgAnsi(hex: string, mode: DPiNativeColorMode): string {
	if (mode === "256color") {
		return `\x1b[48;5;${hexTo256(hex)}m`;
	}
	const { r, g, b } = hexToRgb(hex);
	return `\x1b[48;2;${r};${g};${b}m`;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
	return {
		r: Number.parseInt(hex.slice(1, 3), 16),
		g: Number.parseInt(hex.slice(3, 5), 16),
		b: Number.parseInt(hex.slice(5, 7), 16),
	};
}

function hexTo256(hex: string): number {
	const { r, g, b } = hexToRgb(hex);
	return rgbTo256(r, g, b);
}

const CUBE_VALUES = [0, 95, 135, 175, 215, 255];
const GRAY_VALUES = Array.from({ length: 24 }, (_, i) => 8 + i * 10);

function rgbTo256(r: number, g: number, b: number): number {
	const rIndex = closestIndex(CUBE_VALUES, r);
	const gIndex = closestIndex(CUBE_VALUES, g);
	const bIndex = closestIndex(CUBE_VALUES, b);
	const cubeIndex = 16 + 36 * rIndex + 6 * gIndex + bIndex;
	const cubeDistance = colorDistance(r, g, b, CUBE_VALUES[rIndex]!, CUBE_VALUES[gIndex]!, CUBE_VALUES[bIndex]!);
	const gray = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
	const grayIndex = closestIndex(GRAY_VALUES, gray);
	const grayValue = GRAY_VALUES[grayIndex]!;
	const grayDistance = colorDistance(r, g, b, grayValue, grayValue, grayValue);
	return Math.max(r, g, b) - Math.min(r, g, b) < 10 && grayDistance < cubeDistance ? 232 + grayIndex : cubeIndex;
}

function closestIndex(values: readonly number[], target: number): number {
	let bestIndex = 0;
	let bestDistance = Infinity;
	for (let i = 0; i < values.length; i++) {
		const distance = Math.abs(values[i]! - target);
		if (distance < bestDistance) {
			bestDistance = distance;
			bestIndex = i;
		}
	}
	return bestIndex;
}

function colorDistance(r1: number, g1: number, b1: number, r2: number, g2: number, b2: number): number {
	const dr = r1 - r2;
	const dg = g1 - g2;
	const db = b1 - b2;
	return dr * dr * 0.299 + dg * dg * 0.587 + db * db * 0.114;
}
