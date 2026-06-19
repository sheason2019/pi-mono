import { createDPiNativeTheme } from "../native/theme/theme.ts";

export interface DPiInteractiveStyleOptions {
	color?: boolean;
	colorMode?: "truecolor" | "256color";
}

export interface DPiInteractiveStyle {
	accent(text: string): string;
	heading(text: string): string;
	dim(text: string): string;
	muted(text: string): string;
	text(text: string): string;
	warning(text: string): string;
	error(text: string): string;
	success(text: string): string;
	borderMuted(text: string): string;
	thinking(text: string): string;
	userMessage(text: string): string;
	userMessageBg(text: string): string;
	userMessageText(text: string): string;
	markdownLink(text: string): string;
	markdownLinkUrl(text: string): string;
	markdownCode(text: string): string;
	markdownCodeBlock(text: string): string;
	markdownCodeBlockBorder(text: string): string;
	markdownQuote(text: string): string;
	markdownQuoteBorder(text: string): string;
	markdownHr(text: string): string;
	markdownListBullet(text: string): string;
}

export function createDPiInteractiveStyle(options: DPiInteractiveStyleOptions = {}): DPiInteractiveStyle {
	const theme = createDPiNativeTheme(options);
	return {
		accent: (text) => theme.fg("accent", text),
		heading: (text) => theme.fg("mdHeading", text),
		dim: (text) => theme.fg("dim", text),
		muted: (text) => theme.fg("muted", text),
		text: (text) => theme.fg("text", text),
		warning: (text) => theme.fg("warning", text),
		error: (text) => theme.fg("error", text),
		success: (text) => theme.fg("success", text),
		borderMuted: (text) => theme.fg("borderMuted", text),
		thinking: (text) => theme.italic(theme.fg("thinkingText", text)),
		userMessage: (text) => theme.bg("userMessageBg", theme.fg("userMessageText", text)),
		userMessageBg: (text) => theme.bg("userMessageBg", text),
		userMessageText: (text) => theme.fg("userMessageText", text),
		markdownLink: (text) => theme.fg("mdLink", text),
		markdownLinkUrl: (text) => theme.fg("mdLinkUrl", text),
		markdownCode: (text) => theme.fg("mdCode", text),
		markdownCodeBlock: (text) => theme.fg("mdCodeBlock", text),
		markdownCodeBlockBorder: (text) => theme.fg("mdCodeBlockBorder", text),
		markdownQuote: (text) => theme.fg("mdQuote", text),
		markdownQuoteBorder: (text) => theme.fg("mdQuoteBorder", text),
		markdownHr: (text) => theme.fg("mdHr", text),
		markdownListBullet: (text) => theme.fg("mdListBullet", text),
	};
}
