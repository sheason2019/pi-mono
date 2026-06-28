import * as path from "node:path";
import { type Component, Container, Text, truncateToWidth } from "@earendil-works/pi-tui";
import hljs from "highlight.js";
import { z } from "zod";
import type { DPiNativeTheme } from "../theme/theme.ts";

export interface DPiNativeToolRenderResultOptions {
	expanded: boolean;
	isPartial: boolean;
}

export interface DPiNativeToolRenderContext {
	args: unknown;
	toolCallId: string;
	invalidate: () => void;
	lastComponent: Component | undefined;
	state: Record<string, unknown>;
	cwd: string;
	executionStarted: boolean;
	argsComplete: boolean;
	isPartial: boolean;
	expanded: boolean;
	showImages: boolean;
	isError: boolean;
	onCleanup: (fn: () => void) => void;
}

export interface DPiNativeToolRendererDefinition {
	renderShell?: "default" | "self";
	renderCall?: (args: unknown, theme: DPiNativeTheme, context: DPiNativeToolRenderContext) => Component;
	renderResult?: (
		result: DPiNativeToolResultLike,
		options: DPiNativeToolRenderResultOptions,
		theme: DPiNativeTheme,
		context: DPiNativeToolRenderContext,
	) => Component;
}

export interface DPiNativeToolResultLike {
	content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
	details?: unknown;
	isError?: boolean;
}

const truncationDetailsSchema = z.object({
	truncated: z.boolean().optional(),
	maxBytes: z.number().optional(),
	outputLines: z.number().optional(),
	totalLines: z.number().optional(),
	truncatedBy: z.string().optional(),
	firstLineExceedsLimit: z.boolean().optional(),
	maxLines: z.number().optional(),
});

const bashResultDetailsSchema = z.object({
	truncation: truncationDetailsSchema.optional(),
	fullOutputPath: z.string().optional(),
});

const readResultDetailsSchema = z.object({
	truncation: truncationDetailsSchema.optional(),
});

const readCallArgsSchema = z.object({
	path: z
		.string()
		.optional()
		.catch(() => undefined),
	offset: z
		.number()
		.optional()
		.catch(() => undefined),
	limit: z
		.number()
		.optional()
		.catch(() => undefined),
});

const bashCallArgsSchema = z.object({
	command: z
		.string()
		.optional()
		.catch(() => undefined),
	timeout_ms: z
		.number()
		.optional()
		.catch(() => undefined),
});

interface ParsedReadArgs {
	filePath: string | undefined;
	offset: number | undefined;
	limit: number | undefined;
}

function parseCallArgs<T extends z.ZodObject<z.ZodRawShape>>(schema: T, args: unknown): z.infer<T> {
	return schema.safeParse(args).data ?? {};
}

function parseReadArgs(args: unknown): ParsedReadArgs {
	const data = parseCallArgs(readCallArgsSchema, args);
	return { filePath: data.path, offset: data.offset, limit: data.limit };
}

type TruncationDetails = z.infer<typeof truncationDetailsSchema>;

export function createDPiNativeToolRendererDefinition(toolName: string): DPiNativeToolRendererDefinition | undefined {
	const nativeName = nativeToolName(toolName);
	switch (nativeName) {
		case "read":
			return textToolRenderer(
				(args, theme, context) => {
					const parsed = parseReadArgs(args);
					if (!context.expanded) {
						const classification = getCompactReadClassification(parsed, context.cwd);
						if (classification) return formatCompactReadCall(classification, parsed, theme);
					}
					return formatReadCall(parsed, theme, context.cwd);
				},
				(result, options, theme, context) => {
					const args = parseReadArgs(context.args);
					const output = getTextOutput(result, context.showImages);
					const truncation = readResultDetailsSchema.safeParse(result.details).data?.truncation;
					const lang = args.filePath ? getLanguageFromPath(args.filePath) : undefined;
					return formatReadResult(output, truncation, options, theme, lang, context.isError);
				},
			);
		case "bash":
			return createBashRenderer();
		default:
			return undefined;
	}
}

function textToolRenderer(
	formatCall: (args: unknown, theme: DPiNativeTheme, context: DPiNativeToolRenderContext) => string,
	formatResult: (
		result: DPiNativeToolResultLike,
		options: DPiNativeToolRenderResultOptions,
		theme: DPiNativeTheme,
		context: DPiNativeToolRenderContext,
	) => string | undefined,
): DPiNativeToolRendererDefinition {
	return {
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatCall(args, theme, context));
			return text;
		},
		renderResult(result, options, theme, context) {
			const output = formatResult(result, options, theme, context);
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(output ?? "");
			return text;
		},
	};
}

function nativeToolName(toolName: string): string {
	return toolName.startsWith("dispatch_") ? toolName.slice("dispatch_".length) : toolName;
}

function formatReadCall(data: ParsedReadArgs, theme: DPiNativeTheme, cwd: string): string {
	return `${theme.fg("toolTitle", theme.bold("read"))} ${renderToolPath(data.filePath, theme, cwd)}${formatLineRange(data, theme)}`;
}

function formatBashCall(data: z.infer<typeof bashCallArgsSchema>, theme: DPiNativeTheme): string {
	const timeoutSuffix = data.timeout_ms ? theme.fg("muted", ` (timeout ${data.timeout_ms}s)`) : "";
	const commandDisplay =
		data.command === undefined
			? invalidArgText(theme)
			: data.command.length > 0
				? data.command
				: theme.fg("toolOutput", "...");
	return `${theme.fg("toolTitle", theme.bold(`$ ${commandDisplay}`))}${timeoutSuffix}`;
}

function createBashRenderer(): DPiNativeToolRendererDefinition {
	return {
		renderCall(args, theme, context) {
			const state = context.state as BashRenderState;
			if (context.executionStarted && state.startedAt === undefined) {
				state.startedAt = Date.now();
				state.endedAt = undefined;
			}
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatBashCall(parseCallArgs(bashCallArgsSchema, args), theme));
			return text;
		},
		renderResult(result, options, theme, context) {
			const state = context.state as BashRenderState;
			if (!options.isPartial || context.isError) {
				state.endedAt ??= Date.now();
				if (state.interval) {
					clearInterval(state.interval);
					state.interval = undefined;
				}
			} else if (!state.interval) {
				state.interval = setInterval(() => context.invalidate(), 1000);
				context.onCleanup(() => {
					if (state.interval) {
						clearInterval(state.interval);
						state.interval = undefined;
					}
				});
			}
			const component =
				(context.lastComponent as BashResultRenderComponent | undefined) ?? new BashResultRenderComponent();
			const details = bashResultDetailsSchema.safeParse(result.details).data;
			rebuildBashResultRenderComponent(
				component,
				getTextOutput(result, context.showImages).trim(),
				details,
				options,
				theme,
				state.startedAt,
				state.endedAt,
			);
			component.invalidate();
			return component;
		},
	};
}

function formatLineRange(data: { offset?: number; limit?: number }, theme: DPiNativeTheme): string {
	if (data.offset === undefined && data.limit === undefined) {
		return "";
	}
	const startLine = data.offset ?? 1;
	const endLine = data.limit !== undefined ? startLine + data.limit - 1 : "";
	return theme.fg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
}

function formatReadResult(
	output: string,
	truncation: TruncationDetails | undefined,
	options: DPiNativeToolRenderResultOptions,
	theme: DPiNativeTheme,
	lang: string | undefined,
	isError: boolean,
): string {
	if (!options.expanded && !isError) {
		return "";
	}
	const renderedLines = lang ? highlightCode(replaceTabs(output), lang, theme) : output.split("\n");
	const lines = trimTrailingEmptyLines(renderedLines);
	const maxLines = options.expanded ? lines.length : 10;
	const displayLines = lines.slice(0, maxLines);
	const remaining = lines.length - maxLines;
	let text = `\n${displayLines.map((line) => (lang ? replaceTabs(line) : theme.fg("toolOutput", replaceTabs(line)))).join("\n")}`;
	if (remaining > 0) {
		text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint(theme)}${theme.fg("muted", ")")}`;
	}
	if (truncation?.truncated === true) {
		if (truncation.firstLineExceedsLimit === true) {
			text += `\n${theme.fg("warning", `[First line exceeds ${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit]`)}`;
		} else if (truncation.truncatedBy === "lines") {
			text += `\n${theme.fg("warning", `[Truncated: showing ${truncation.outputLines ?? "?"} of ${truncation.totalLines ?? "?"} lines (${truncation.maxLines ?? DEFAULT_MAX_LINES} line limit)]`)}`;
		} else {
			text += `\n${theme.fg("warning", `[Truncated: ${truncation.outputLines ?? "?"} lines shown (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)]`)}`;
		}
	}
	return text;
}

function rebuildBashResultRenderComponent(
	component: Container,
	output: string,
	details: z.infer<typeof bashResultDetailsSchema> | undefined,
	options: DPiNativeToolRenderResultOptions,
	theme: DPiNativeTheme,
	startedAt: number | undefined,
	endedAt: number | undefined,
): void {
	const state = (component as BashResultRenderComponent).state;
	component.clear();
	const truncation = details?.truncation;
	const fullOutputPath = details?.fullOutputPath;
	let displayOutput = output;
	if (!options.isPartial && truncation?.truncated === true && fullOutputPath && displayOutput.endsWith("]")) {
		const footerStart = displayOutput.lastIndexOf("\n\n[");
		if (footerStart !== -1 && displayOutput.slice(footerStart).includes(fullOutputPath)) {
			displayOutput = displayOutput.slice(0, footerStart).trimEnd();
		}
	}
	if (displayOutput) {
		const styledOutput = displayOutput
			.split("\n")
			.map((line) => theme.fg("toolOutput", line))
			.join("\n");
		if (options.expanded) {
			component.addChild(new Text(`\n${styledOutput}`, 0, 0));
		} else {
			component.addChild({
				render: (width: number) => {
					if (state.cachedLines === undefined || state.cachedWidth !== width) {
						const preview = truncateToVisualLines(styledOutput, BASH_PREVIEW_LINES, width);
						state.cachedLines = preview.visualLines;
						state.cachedSkipped = preview.skippedCount;
						state.cachedWidth = width;
					}
					if ((state.cachedSkipped ?? 0) > 0) {
						const hint = `${theme.fg("muted", `... (${state.cachedSkipped} earlier lines,`)} ${keyHint(theme)}${theme.fg("muted", ")")}`;
						return ["", truncateToWidth(hint, width, "..."), ...(state.cachedLines ?? [])];
					}
					return ["", ...(state.cachedLines ?? [])];
				},
				invalidate: () => {
					state.cachedWidth = undefined;
					state.cachedLines = undefined;
					state.cachedSkipped = undefined;
				},
			});
		}
	}
	const warnings: string[] = [];
	if (fullOutputPath) {
		warnings.push(`Full output: ${fullOutputPath}`);
	}
	if (truncation?.truncated === true) {
		if (truncation.truncatedBy === "lines") {
			warnings.push(`Truncated: showing ${truncation.outputLines ?? "?"} of ${truncation.totalLines ?? "?"} lines`);
		} else {
			warnings.push(
				`Truncated: ${truncation.outputLines ?? "?"} lines shown (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)`,
			);
		}
	}
	if (warnings.length > 0) {
		component.addChild(new Text(`\n${theme.fg("warning", `[${warnings.join(". ")}]`)}`, 0, 0));
	}
	if (startedAt !== undefined) {
		const label = options.isPartial ? "Elapsed" : "Took";
		const endTime = endedAt ?? Date.now();
		component.addChild(new Text(`\n${theme.fg("muted", `${label} ${formatDuration(endTime - startedAt)}`)}`, 0, 0));
	}
}

function getTextOutput(result: DPiNativeToolResultLike | undefined, showImages: boolean): string {
	if (!result) {
		return "";
	}
	const text = result.content
		.filter((part) => part.type === "text")
		.map((part) => (part.text ?? "").replace(/\r/g, ""))
		.join("\n");
	const images = result.content.filter((part) => part.type === "image");
	if (showImages || images.length === 0) {
		return text;
	}
	const imageText = images.map((part) => `[image:${part.mimeType ?? "image/unknown"}]`).join("\n");
	return text ? `${text}\n${imageText}` : imageText;
}

function renderToolPath(
	rawPath: string | undefined,
	theme: DPiNativeTheme,
	_cwd: string,
	emptyFallback?: string,
): string {
	if (rawPath === undefined && !emptyFallback) {
		return theme.fg("toolOutput", "...");
	}
	const value = rawPath || emptyFallback;
	if (!value) {
		return invalidArgText(theme);
	}
	return theme.fg("accent", shortenPath(value));
}

interface CompactReadClassification {
	kind: "docs" | "resource" | "skill";
	label: string;
}

const COMPACT_RESOURCE_FILE_NAMES = new Set(["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"]);

function getCompactReadClassification(data: ParsedReadArgs, cwd: string): CompactReadClassification | undefined {
	if (!data.filePath) {
		return undefined;
	}
	const absolutePath = path.resolve(cwd, data.filePath);
	const fileName = path.basename(absolutePath);
	if (fileName === "SKILL.md") {
		return { kind: "skill", label: path.basename(path.dirname(absolutePath)) || fileName };
	}
	if (COMPACT_RESOURCE_FILE_NAMES.has(fileName)) {
		return { kind: "resource", label: formatPathRelativeToCwdOrAbsolute(absolutePath, cwd) };
	}
	return undefined;
}

function formatCompactReadCall(
	classification: CompactReadClassification,
	data: ParsedReadArgs,
	theme: DPiNativeTheme,
): string {
	const expandHint = theme.fg("dim", " (ctrl+o to expand)");
	if (classification.kind === "skill") {
		return (
			theme.fg("customMessageLabel", `${theme.bold("[skill]")} `) +
			theme.fg("customMessageText", classification.label) +
			formatLineRange(data, theme) +
			expandHint
		);
	}
	return `${theme.fg("toolTitle", theme.bold(`read ${classification.kind}`))} ${theme.fg("accent", classification.label)}${formatLineRange(data, theme)}${expandHint}`;
}

function truncateToVisualLines(
	text: string,
	maxVisualLines: number,
	width: number,
): { visualLines: string[]; skippedCount: number } {
	if (!text) {
		return { visualLines: [], skippedCount: 0 };
	}
	const allVisualLines = new Text(text, 0, 0).render(width);
	if (allVisualLines.length <= maxVisualLines) {
		return { visualLines: allVisualLines, skippedCount: 0 };
	}
	return { visualLines: allVisualLines.slice(-maxVisualLines), skippedCount: allVisualLines.length - maxVisualLines };
}

class BashResultRenderComponent extends Container {
	state: BashResultRenderState = {
		cachedWidth: undefined,
		cachedLines: undefined,
		cachedSkipped: undefined,
	};
}

type BashRenderState = { startedAt?: number; endedAt?: number; interval?: NodeJS.Timeout };
type BashResultRenderState = { cachedWidth?: number; cachedLines?: string[]; cachedSkipped?: number };

const BASH_PREVIEW_LINES = 5;
const DEFAULT_MAX_BYTES = 128 * 1024;
const DEFAULT_MAX_LINES = 2000;

function highlightCode(code: string, lang: string | undefined, theme: DPiNativeTheme): string[] {
	if (!lang || !hljs.getLanguage(lang)) {
		return code.split("\n").map((line) => theme.fg("mdCodeBlock", line));
	}
	try {
		const html = hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
		return renderHighlightedHtml(html, theme).split("\n");
	} catch {
		return code.split("\n");
	}
}

function renderHighlightedHtml(html: string, theme: DPiNativeTheme): string {
	return html
		.replace(/<span class="hljs-(keyword|built_in|literal)">([^<]*)<\/span>/g, (_, _scope, text: string) =>
			theme.fg("syntaxKeyword", decodeHtml(text)),
		)
		.replace(/<span class="hljs-(string|regexp)">([^<]*)<\/span>/g, (_, _scope, text: string) =>
			theme.fg("syntaxString", decodeHtml(text)),
		)
		.replace(/<span class="hljs-(number)">([^<]*)<\/span>/g, (_, _scope, text: string) =>
			theme.fg("syntaxNumber", decodeHtml(text)),
		)
		.replace(/<span class="hljs-(comment)">([^<]*)<\/span>/g, (_, _scope, text: string) =>
			theme.fg("syntaxComment", decodeHtml(text)),
		)
		.replace(/<[^>]+>/g, "")
		.replace(/&(?:amp|lt|gt|quot|#39);/g, (entity) => decodeHtml(entity));
}

function decodeHtml(text: string): string {
	return text
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'");
}

function getLanguageFromPath(filePath: string): string | undefined {
	const ext = filePath.split(".").pop()?.toLowerCase();
	if (!ext) return undefined;
	const extToLang: Record<string, string> = {
		ts: "typescript",
		tsx: "typescript",
		js: "javascript",
		jsx: "javascript",
		mjs: "javascript",
		cjs: "javascript",
		py: "python",
		rb: "ruby",
		rs: "rust",
		go: "go",
		java: "java",
		sh: "bash",
		bash: "bash",
		json: "json",
		md: "markdown",
		yml: "yaml",
		yaml: "yaml",
	};
	return extToLang[ext];
}

function trimTrailingEmptyLines(lines: string[]): string[] {
	let end = lines.length;
	while (end > 0 && lines[end - 1] === "") {
		end--;
	}
	return lines.slice(0, end);
}

function replaceTabs(text: string): string {
	return text.replace(/\t/g, "   ");
}

function formatPathRelativeToCwdOrAbsolute(absolutePath: string, cwd: string): string {
	const relativePath = path.relative(cwd, absolutePath);
	return relativePath && !relativePath.startsWith("..") && !path.isAbsolute(relativePath)
		? relativePath
		: absolutePath;
}

function formatDuration(ms: number): string {
	return `${(ms / 1000).toFixed(1)}s`;
}

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function invalidArgText(theme: DPiNativeTheme): string {
	return theme.fg("error", "[invalid arg]");
}

function shortenPath(pathValue: string): string {
	const home = process.env.HOME;
	return home && pathValue.startsWith(home) ? `~${pathValue.slice(home.length)}` : pathValue;
}

function keyHint(theme: DPiNativeTheme): string {
	return `${theme.fg("dim", "ctrl+o")}${theme.fg("muted", " to expand")}`;
}
