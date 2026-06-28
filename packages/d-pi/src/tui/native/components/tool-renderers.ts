import * as path from "node:path";
import { Box, type Component, Container, Spacer, Text, truncateToWidth } from "@earendil-works/pi-tui";
import * as Diff from "diff";
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

export function createDPiNativeToolRendererDefinition(toolName: string): DPiNativeToolRendererDefinition | undefined {
	const nativeName = nativeToolName(toolName);
	switch (nativeName) {
		case "ls":
			return textToolRenderer(
				(args, theme, context) => formatLsCall(args, theme, context.cwd),
				formatListResult(20, "lines"),
			);
		case "find":
			return textToolRenderer(formatFindCall, formatListResult(20, "lines"));
		case "grep":
			return textToolRenderer(formatGrepCall, formatListResult(15, "lines"));
		case "read":
			return textToolRenderer(
				(args, theme, context) => {
					const classification = !context.expanded ? getCompactReadClassification(args, context.cwd) : undefined;
					return classification
						? formatCompactReadCall(classification, args, theme)
						: formatReadCall(args, theme, context.cwd);
				},
				(result, options, theme, context) =>
					formatReadResult(context.args, result, options, theme, context.showImages, context.cwd, context.isError),
			);
		case "write":
			return createWriteRenderer();
		case "bash":
			return createBashRenderer();
		case "edit":
			return createEditRenderer();
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

function formatLsCall(args: unknown, theme: DPiNativeTheme, cwd: string): string {
	const record = toRecord(args);
	const limit = typeof record.limit === "number" ? record.limit : undefined;
	let text = `${theme.fg("toolTitle", theme.bold("ls"))} ${renderToolPath(str(record.path), theme, cwd, ".")}`;
	if (limit !== undefined) {
		text += theme.fg("toolOutput", ` (limit ${limit})`);
	}
	return text;
}

function formatFindCall(args: unknown, theme: DPiNativeTheme): string {
	const record = toRecord(args);
	const pattern = str(record.pattern);
	const rawPath = str(record.path);
	const pathValue = rawPath !== null ? shortenPath(rawPath || ".") : null;
	const limit = typeof record.limit === "number" ? record.limit : undefined;
	const invalidArg = invalidArgText(theme);
	let text =
		theme.fg("toolTitle", theme.bold("find")) +
		" " +
		(pattern === null ? invalidArg : theme.fg("accent", pattern || "")) +
		theme.fg("toolOutput", ` in ${pathValue === null ? invalidArg : pathValue}`);
	if (limit !== undefined) {
		text += theme.fg("toolOutput", ` (limit ${limit})`);
	}
	return text;
}

function formatGrepCall(args: unknown, theme: DPiNativeTheme): string {
	const record = toRecord(args);
	const pattern = str(record.pattern);
	const rawPath = str(record.path);
	const pathValue = rawPath !== null ? shortenPath(rawPath || ".") : null;
	const glob = str(record.glob);
	const limit = typeof record.limit === "number" ? record.limit : undefined;
	const invalidArg = invalidArgText(theme);
	let text =
		theme.fg("toolTitle", theme.bold("grep")) +
		" " +
		(pattern === null ? invalidArg : theme.fg("accent", `/${pattern || ""}/`)) +
		theme.fg("toolOutput", ` in ${pathValue === null ? invalidArg : pathValue}`);
	if (glob) {
		text += theme.fg("toolOutput", ` (${glob})`);
	}
	if (limit !== undefined) {
		text += theme.fg("toolOutput", ` limit ${limit}`);
	}
	return text;
}

function formatReadCall(args: unknown, theme: DPiNativeTheme, cwd: string): string {
	const record = toRecord(args);
	const path = str(record.file_path ?? record.path);
	return `${theme.fg("toolTitle", theme.bold("read"))} ${renderToolPath(path, theme, cwd)}${formatLineRange(record, theme)}`;
}

function formatWriteCall(
	args: unknown,
	options: DPiNativeToolRenderResultOptions,
	theme: DPiNativeTheme,
	context: DPiNativeToolRenderContext,
	cache: WriteHighlightCache | undefined,
): string {
	const record = toRecord(args);
	const rawPath = str(record.file_path ?? record.path);
	const content = str(record.content);
	const pathDisplay = renderToolPath(rawPath, theme, context.cwd);
	let text = `${theme.fg("toolTitle", theme.bold("write"))} ${pathDisplay}`;
	if (content === null) {
		text += `\n\n${theme.fg("error", "[invalid content arg - expected string]")}`;
		return text;
	}
	if (content) {
		const lang = rawPath ? getLanguageFromPath(rawPath) : undefined;
		const renderedLines = lang
			? (cache?.highlightedLines ?? highlightCode(replaceTabs(normalizeDisplayText(content)), lang, theme))
			: normalizeDisplayText(content).split("\n");
		const lines = trimTrailingEmptyLines(renderedLines);
		const totalLines = lines.length;
		const maxLines = options.expanded ? lines.length : 10;
		const displayLines = lines.slice(0, maxLines);
		const remaining = lines.length - maxLines;
		text += `\n\n${displayLines.map((line) => (lang ? line : theme.fg("toolOutput", replaceTabs(line)))).join("\n")}`;
		if (remaining > 0) {
			text += `${theme.fg("muted", `\n... (${remaining} more lines, ${totalLines} total,`)} ${keyHint(theme)}${theme.fg("muted", ")")}`;
		}
	}
	return text;
}

function formatBashCall(args: unknown, theme: DPiNativeTheme): string {
	const record = toRecord(args);
	const command = str(record.command);
	const timeout = typeof record.timeout === "number" ? record.timeout : undefined;
	const timeoutSuffix = timeout ? theme.fg("muted", ` (timeout ${timeout}s)`) : "";
	const commandDisplay = command === null ? invalidArgText(theme) : command ? command : theme.fg("toolOutput", "...");
	return theme.fg("toolTitle", theme.bold(`$ ${commandDisplay}`)) + timeoutSuffix;
}

function formatEditCall(args: unknown, theme: DPiNativeTheme, cwd: string): string {
	const record = toRecord(args);
	const editPath = str(record.file_path ?? record.path);
	return `${theme.fg("toolTitle", theme.bold("edit"))} ${renderToolPath(editPath, theme, cwd)}`;
}

function createWriteRenderer(): DPiNativeToolRendererDefinition {
	return {
		renderCall(args, theme, context) {
			const component =
				(context.lastComponent as WriteCallRenderComponent | undefined) ?? new WriteCallRenderComponent();
			const record = toRecord(args);
			const rawPath = str(record.file_path ?? record.path);
			const fileContent = str(record.content);
			if (fileContent !== null) {
				component.cache = context.argsComplete
					? rebuildWriteHighlightCacheFull(rawPath, fileContent)
					: updateWriteHighlightCacheIncremental(component.cache, rawPath, fileContent);
			} else {
				component.cache = undefined;
			}
			component.setText(
				formatWriteCall(
					args,
					{ expanded: context.expanded, isPartial: context.isPartial },
					theme,
					context,
					component.cache,
				),
			);
			return component;
		},
		renderResult(result, _options, theme, context) {
			const output = formatErrorOnlyResult({ ...result, isError: context.isError }, _options, theme, context);
			if (!output) {
				const component = (context.lastComponent as Container | undefined) ?? new Container();
				component.clear();
				return component;
			}
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(output);
			return text;
		},
	};
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
			text.setText(formatBashCall(args, theme));
			return text;
		},
		renderResult(result, options, theme, context) {
			const state = context.state as BashRenderState;
			if (state.startedAt !== undefined && options.isPartial && !state.interval) {
				state.interval = setInterval(() => context.invalidate(), 1000);
			}
			if (!options.isPartial || context.isError) {
				state.endedAt ??= Date.now();
				if (state.interval) {
					clearInterval(state.interval);
					state.interval = undefined;
				}
			}
			const component =
				(context.lastComponent as BashResultRenderComponent | undefined) ?? new BashResultRenderComponent();
			rebuildBashResultRenderComponent(
				component,
				result,
				options,
				theme,
				context.showImages,
				state.startedAt,
				state.endedAt,
			);
			component.invalidate();
			return component;
		},
	};
}

function createEditRenderer(): DPiNativeToolRendererDefinition {
	return {
		renderShell: "self",
		renderCall(args, theme, context) {
			const state = context.state as EditRenderState;
			const component = getEditCallRenderComponent(state, context.lastComponent);
			return buildEditCallComponent(component, args, theme, context.cwd);
		},
		renderResult(result, _options, theme, context) {
			const state = context.state as EditRenderState;
			const callComponent = state.callComponent;
			const resultDiff = !context.isError ? getDetailsRecord(result.details).diff : undefined;
			if (callComponent && typeof resultDiff === "string") {
				callComponent.preview = {
					diff: resultDiff,
					firstChangedLine: asNumber(getDetailsRecord(result.details).firstChangedLine),
				};
				callComponent.settledError = false;
				buildEditCallComponent(callComponent, context.args, theme, context.cwd);
			} else if (callComponent) {
				callComponent.settledError = context.isError;
				buildEditCallComponent(callComponent, context.args, theme, context.cwd);
			}
			const output = formatEditResult(context.args, callComponent?.preview, result, theme, context.isError);
			const component = (context.lastComponent as Container | undefined) ?? new Container();
			component.clear();
			if (!output) {
				return component;
			}
			component.addChild(new Spacer(1));
			component.addChild(new Text(output, 1, 0));
			return component;
		},
	};
}

function formatLineRange(record: Record<string, unknown>, theme: DPiNativeTheme): string {
	if (record.offset === undefined && record.limit === undefined) {
		return "";
	}
	const startLine = typeof record.offset === "number" ? record.offset : 1;
	const endLine = typeof record.limit === "number" ? startLine + record.limit - 1 : "";
	return theme.fg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
}

function formatListResult(maxCollapsedLines: number, unit: string) {
	return (
		result: DPiNativeToolResultLike,
		options: DPiNativeToolRenderResultOptions,
		theme: DPiNativeTheme,
		context: DPiNativeToolRenderContext,
	): string => {
		const output = getTextOutput(result, context.showImages).trim();
		let text = output
			? `\n${formatOutputLines(output, options.expanded ? Number.POSITIVE_INFINITY : maxCollapsedLines, theme, unit)}`
			: "";
		const details = getDetailsRecord(result.details);
		const warnings: string[] = [];
		for (const key of ["entryLimitReached", "resultLimitReached", "matchLimitReached"] as const) {
			if (typeof details[key] === "number") {
				const label =
					key === "entryLimitReached" ? "entries" : key === "resultLimitReached" ? "results" : "matches";
				warnings.push(`${details[key]} ${label} limit`);
			}
		}
		const truncation = getDetailsRecord(details.truncation);
		if (truncation.truncated === true) {
			warnings.push(`${formatSize(asNumber(truncation.maxBytes) ?? DEFAULT_MAX_BYTES)} limit`);
		}
		if (details.linesTruncated === true) {
			warnings.push("some lines truncated");
		}
		if (warnings.length > 0) {
			text += `\n${theme.fg("warning", `[Truncated: ${warnings.join(", ")}]`)}`;
		}
		return text;
	};
}

function formatReadResult(
	args: unknown,
	result: DPiNativeToolResultLike,
	options: DPiNativeToolRenderResultOptions,
	theme: DPiNativeTheme,
	showImages: boolean,
	_cwd: string,
	isError: boolean,
): string {
	if (!options.expanded && !isError) {
		return "";
	}
	const record = toRecord(args);
	const rawPath = str(record.file_path ?? record.path);
	const output = getTextOutput(result, showImages);
	const lang = rawPath ? getLanguageFromPath(rawPath) : undefined;
	const renderedLines = lang ? highlightCode(replaceTabs(output), lang, theme) : output.split("\n");
	const lines = trimTrailingEmptyLines(renderedLines);
	const maxLines = options.expanded ? lines.length : 10;
	const displayLines = lines.slice(0, maxLines);
	const remaining = lines.length - maxLines;
	let text = `\n${displayLines.map((line) => (lang ? replaceTabs(line) : theme.fg("toolOutput", replaceTabs(line)))).join("\n")}`;
	if (remaining > 0) {
		text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint(theme)}${theme.fg("muted", ")")}`;
	}
	const truncation = getDetailsRecord(getDetailsRecord(result.details).truncation);
	if (truncation.truncated === true) {
		if (truncation.firstLineExceedsLimit === true) {
			text += `\n${theme.fg("warning", `[First line exceeds ${formatSize(asNumber(truncation.maxBytes) ?? DEFAULT_MAX_BYTES)} limit]`)}`;
		} else if (truncation.truncatedBy === "lines") {
			text += `\n${theme.fg("warning", `[Truncated: showing ${asNumber(truncation.outputLines) ?? "?"} of ${asNumber(truncation.totalLines) ?? "?"} lines (${asNumber(truncation.maxLines) ?? DEFAULT_MAX_LINES} line limit)]`)}`;
		} else {
			text += `\n${theme.fg("warning", `[Truncated: ${asNumber(truncation.outputLines) ?? "?"} lines shown (${formatSize(asNumber(truncation.maxBytes) ?? DEFAULT_MAX_BYTES)} limit)]`)}`;
		}
	}
	return text;
}

function rebuildBashResultRenderComponent(
	component: BashResultRenderComponent,
	result: DPiNativeToolResultLike,
	options: DPiNativeToolRenderResultOptions,
	theme: DPiNativeTheme,
	showImages: boolean,
	startedAt: number | undefined,
	endedAt: number | undefined,
): void {
	const state = component.state;
	component.clear();
	let output = getTextOutput(result, showImages).trim();
	const details = getDetailsRecord(result.details);
	const truncation = getDetailsRecord(details.truncation);
	const fullOutputPath = str(details.fullOutputPath);
	if (!options.isPartial && truncation.truncated === true && fullOutputPath && output.endsWith("]")) {
		const footerStart = output.lastIndexOf("\n\n[");
		if (footerStart !== -1 && output.slice(footerStart).includes(fullOutputPath)) {
			output = output.slice(0, footerStart).trimEnd();
		}
	}
	if (output) {
		const styledOutput = output
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
					if (state.cachedSkipped && state.cachedSkipped > 0) {
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
	if (truncation.truncated === true) {
		if (truncation.truncatedBy === "lines") {
			warnings.push(
				`Truncated: showing ${asNumber(truncation.outputLines) ?? "?"} of ${asNumber(truncation.totalLines) ?? "?"} lines`,
			);
		} else {
			warnings.push(
				`Truncated: ${asNumber(truncation.outputLines) ?? "?"} lines shown (${formatSize(asNumber(truncation.maxBytes) ?? DEFAULT_MAX_BYTES)} limit)`,
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

function formatErrorOnlyResult(
	result: DPiNativeToolResultLike,
	_options: DPiNativeToolRenderResultOptions,
	theme: DPiNativeTheme,
	_context: DPiNativeToolRenderContext,
): string | undefined {
	if (!result.isError) {
		return undefined;
	}
	const output = getTextOutput(result, true);
	return output ? `\n${theme.fg("error", output)}` : undefined;
}

function formatEditResult(
	args: unknown,
	preview: EditPreview | undefined,
	result: DPiNativeToolResultLike,
	theme: DPiNativeTheme,
	isError: boolean,
): string | undefined {
	const record = toRecord(args);
	const rawPath = str(record.file_path ?? record.path);
	const previewDiff = preview && !("error" in preview) ? preview.diff : undefined;
	const previewError = preview && "error" in preview ? preview.error : undefined;
	if (isError) {
		const errorText = getTextOutput(result, true);
		if (!errorText || errorText === previewError) {
			return undefined;
		}
		return theme.fg("error", errorText);
	}
	const resultDiff = str(getDetailsRecord(result.details).diff);
	if (resultDiff && resultDiff !== previewDiff) {
		return renderDiff(resultDiff, theme, { filePath: rawPath ?? undefined });
	}
	return undefined;
}

function buildEditCallComponent(
	component: EditCallRenderComponent,
	args: unknown,
	theme: DPiNativeTheme,
	cwd: string,
): EditCallRenderComponent {
	component.setBgFn(getEditHeaderBg(component.preview, component.settledError, theme));
	component.clear();
	component.addChild(new Text(formatEditCall(args, theme, cwd), 0, 0));
	if (!component.preview) {
		return component;
	}
	const body =
		"error" in component.preview
			? theme.fg("error", component.preview.error)
			: renderDiff(component.preview.diff, theme);
	component.addChild(new Spacer(1));
	component.addChild(new Text(body, 0, 0));
	return component;
}

function getEditHeaderBg(
	preview: EditPreview | undefined,
	settledError: boolean | undefined,
	theme: DPiNativeTheme,
): (text: string) => string {
	if (preview) {
		return "error" in preview ? (text) => theme.bg("toolErrorBg", text) : (text) => theme.bg("toolSuccessBg", text);
	}
	if (settledError) {
		return (text) => theme.bg("toolErrorBg", text);
	}
	return (text) => theme.bg("toolPendingBg", text);
}

function getEditCallRenderComponent(
	state: EditRenderState,
	lastComponent: Component | undefined,
): EditCallRenderComponent {
	if (lastComponent instanceof Box) {
		const component = lastComponent as EditCallRenderComponent;
		state.callComponent = component;
		return component;
	}
	if (state.callComponent) {
		return state.callComponent;
	}
	const component = Object.assign(new Box(1, 1, (text: string) => text), {
		preview: undefined as EditPreview | undefined,
		settledError: false,
	});
	state.callComponent = component;
	return component;
}

function formatOutputLines(output: string, maxLines: number, theme: DPiNativeTheme, unit: string): string {
	const lines = output.split("\n");
	const finiteMax = Number.isFinite(maxLines) ? maxLines : lines.length;
	const displayLines = lines.slice(0, finiteMax);
	const remaining = lines.length - displayLines.length;
	let text = displayLines.map((line) => theme.fg("toolOutput", line)).join("\n");
	if (remaining > 0) {
		text += `${theme.fg("muted", `\n... (${remaining} more ${unit},`)} ${keyHint(theme)}${theme.fg("muted", ")")}`;
	}
	return text;
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

function renderToolPath(rawPath: string | null, theme: DPiNativeTheme, _cwd: string, emptyFallback?: string): string {
	if (rawPath === null) {
		return invalidArgText(theme);
	}
	const value = rawPath || emptyFallback;
	if (!value) {
		return theme.fg("toolOutput", "...");
	}
	return theme.fg("accent", shortenPath(value));
}

interface CompactReadClassification {
	kind: "docs" | "resource" | "skill";
	label: string;
}

const COMPACT_RESOURCE_FILE_NAMES = new Set(["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"]);

function getCompactReadClassification(args: unknown, cwd: string): CompactReadClassification | undefined {
	const record = toRecord(args);
	const rawPath = str(record.file_path ?? record.path);
	if (!rawPath) {
		return undefined;
	}
	const absolutePath = path.resolve(cwd, rawPath);
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
	args: unknown,
	theme: DPiNativeTheme,
): string {
	const expandHint = theme.fg("dim", ` (ctrl+o to expand)`);
	if (classification.kind === "skill") {
		return (
			theme.fg("customMessageLabel", `${theme.bold("[skill]")} `) +
			theme.fg("customMessageText", classification.label) +
			formatLineRange(toRecord(args), theme) +
			expandHint
		);
	}
	return (
		theme.fg("toolTitle", theme.bold(`read ${classification.kind}`)) +
		" " +
		theme.fg("accent", classification.label) +
		formatLineRange(toRecord(args), theme) +
		expandHint
	);
}

function renderDiff(diffText: string, theme: DPiNativeTheme, _options: { filePath?: string } = {}): string {
	const lines = diffText.split("\n");
	const result: string[] = [];
	let i = 0;
	while (i < lines.length) {
		const line = lines[i] ?? "";
		const parsed = parseDiffLine(line);
		if (!parsed) {
			result.push(theme.fg("toolDiffContext", line));
			i++;
			continue;
		}
		if (parsed.prefix === "-") {
			const removedLines: { lineNum: string; content: string }[] = [];
			while (i < lines.length) {
				const next = parseDiffLine(lines[i] ?? "");
				if (!next || next.prefix !== "-") break;
				removedLines.push({ lineNum: next.lineNum, content: next.content });
				i++;
			}
			const addedLines: { lineNum: string; content: string }[] = [];
			while (i < lines.length) {
				const next = parseDiffLine(lines[i] ?? "");
				if (!next || next.prefix !== "+") break;
				addedLines.push({ lineNum: next.lineNum, content: next.content });
				i++;
			}
			if (removedLines.length === 1 && addedLines.length === 1) {
				const removed = removedLines[0]!;
				const added = addedLines[0]!;
				const intra = renderIntraLineDiff(replaceTabs(removed.content), replaceTabs(added.content), theme);
				result.push(theme.fg("toolDiffRemoved", `-${removed.lineNum} ${intra.removedLine}`));
				result.push(theme.fg("toolDiffAdded", `+${added.lineNum} ${intra.addedLine}`));
			} else {
				for (const removed of removedLines)
					result.push(theme.fg("toolDiffRemoved", `-${removed.lineNum} ${replaceTabs(removed.content)}`));
				for (const added of addedLines)
					result.push(theme.fg("toolDiffAdded", `+${added.lineNum} ${replaceTabs(added.content)}`));
			}
		} else if (parsed.prefix === "+") {
			result.push(theme.fg("toolDiffAdded", `+${parsed.lineNum} ${replaceTabs(parsed.content)}`));
			i++;
		} else {
			result.push(theme.fg("toolDiffContext", ` ${parsed.lineNum} ${replaceTabs(parsed.content)}`));
			i++;
		}
	}
	return result.join("\n");
}

function parseDiffLine(line: string): { prefix: string; lineNum: string; content: string } | null {
	const match = line.match(/^([+-\s])(\s*\d*)\s(.*)$/);
	if (!match) return null;
	return { prefix: match[1]!, lineNum: match[2]!, content: match[3]! };
}

function renderIntraLineDiff(
	oldContent: string,
	newContent: string,
	theme: DPiNativeTheme,
): { removedLine: string; addedLine: string } {
	const wordDiff = Diff.diffWords(oldContent, newContent);
	let removedLine = "";
	let addedLine = "";
	let isFirstRemoved = true;
	let isFirstAdded = true;
	for (const part of wordDiff) {
		if (part.removed) {
			let value = part.value;
			if (isFirstRemoved) {
				const leadingWs = value.match(/^(\s*)/)?.[1] || "";
				value = value.slice(leadingWs.length);
				removedLine += leadingWs;
				isFirstRemoved = false;
			}
			if (value) removedLine += theme.inverse(value);
		} else if (part.added) {
			let value = part.value;
			if (isFirstAdded) {
				const leadingWs = value.match(/^(\s*)/)?.[1] || "";
				value = value.slice(leadingWs.length);
				addedLine += leadingWs;
				isFirstAdded = false;
			}
			if (value) addedLine += theme.inverse(value);
		} else {
			removedLine += part.value;
			addedLine += part.value;
		}
	}
	return { removedLine, addedLine };
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

class WriteCallRenderComponent extends Text {
	cache?: WriteHighlightCache;
	constructor() {
		super("", 0, 0);
	}
}

type EditCallRenderComponent = Box & {
	preview?: EditPreview;
	settledError?: boolean;
};

type EditPreview = { diff: string; firstChangedLine?: number } | { error: string };
type EditRenderState = { callComponent?: EditCallRenderComponent };
type BashRenderState = { startedAt?: number; endedAt?: number; interval?: NodeJS.Timeout };
type BashResultRenderState = { cachedWidth?: number; cachedLines?: string[]; cachedSkipped?: number };
type WriteHighlightCache = {
	rawPath: string | null;
	lang: string;
	rawContent: string;
	normalizedLines: string[];
	highlightedLines: string[];
};

const BASH_PREVIEW_LINES = 5;
const DEFAULT_MAX_BYTES = 128 * 1024;
const DEFAULT_MAX_LINES = 2000;

function rebuildWriteHighlightCacheFull(rawPath: string | null, fileContent: string): WriteHighlightCache | undefined {
	const lang = rawPath ? getLanguageFromPath(rawPath) : undefined;
	if (!lang) return undefined;
	const displayContent = normalizeDisplayText(fileContent);
	const normalized = replaceTabs(displayContent);
	return {
		rawPath,
		lang,
		rawContent: fileContent,
		normalizedLines: normalized.split("\n"),
		highlightedLines: highlightCode(normalized, lang, createNoColorTheme()),
	};
}

function updateWriteHighlightCacheIncremental(
	cache: WriteHighlightCache | undefined,
	rawPath: string | null,
	fileContent: string,
): WriteHighlightCache | undefined {
	return cache && cache.rawPath === rawPath && fileContent.startsWith(cache.rawContent)
		? rebuildWriteHighlightCacheFull(rawPath, fileContent)
		: rebuildWriteHighlightCacheFull(rawPath, fileContent);
}

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

function createNoColorTheme(): DPiNativeTheme {
	return {
		fg: (_color, text) => text,
		bg: (_color, text) => text,
		bold: (text) => text,
		italic: (text) => text,
		underline: (text) => text,
		strikethrough: (text) => text,
		inverse: (text) => text,
		getColorMode: () => "truecolor",
	};
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

function normalizeDisplayText(text: string): string {
	return text.replace(/\r/g, "");
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

const recordSchema = z.record(z.string(), z.unknown());

function getDetailsRecord(value: unknown): Record<string, unknown> {
	const parsed = recordSchema.safeParse(value);
	return parsed.success ? parsed.data : {};
}

function toRecord(value: unknown): Record<string, unknown> {
	const parsed = recordSchema.safeParse(value);
	return parsed.success ? parsed.data : {};
}

function str(value: unknown): string | null {
	if (typeof value === "string") return value;
	if (value == null) return "";
	return null;
}

function asNumber(value: unknown): number | undefined {
	return typeof value === "number" ? value : undefined;
}
