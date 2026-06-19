import type { ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { Box, type Component, Container, Spacer, Text } from "@earendil-works/pi-tui";
import { createDPiNativeTheme, type DPiNativeTheme } from "../theme/theme.ts";
import {
	createDPiNativeToolRendererDefinition,
	type DPiNativeToolRenderContext,
	type DPiNativeToolRendererDefinition,
	type DPiNativeToolResultLike,
} from "./tool-renderers.ts";

export interface DPiNativeToolExecutionComponentOptions {
	theme?: DPiNativeTheme;
	cwd?: string;
	expanded?: boolean;
	showImages?: boolean;
	imageWidthCells?: number;
}

export class DPiNativeToolExecutionComponent extends Container {
	private readonly contentBox: Box;
	private readonly theme: DPiNativeTheme;
	private readonly toolCall: ToolCall;
	private readonly result: ToolResultMessage | undefined;
	private readonly contentText: Text;
	private readonly selfRenderContainer: Container;
	private readonly rendererState: Record<string, unknown> = {};
	private readonly toolDefinition: DPiNativeToolRendererDefinition | undefined;
	private readonly cwd: string;
	private callRendererComponent: Component | undefined;
	private resultRendererComponent: Component | undefined;
	private expanded: boolean;
	private showImages: boolean;
	private isPartial = true;
	private hideComponent = false;

	constructor(
		toolCall: ToolCall,
		result: ToolResultMessage | undefined,
		options: DPiNativeToolExecutionComponentOptions = {},
	) {
		super();
		this.toolCall = toolCall;
		this.result = result;
		this.theme = options.theme ?? createDPiNativeTheme();
		this.cwd = options.cwd ?? process.cwd();
		this.expanded = options.expanded ?? false;
		this.showImages = options.showImages ?? true;
		this.isPartial = result === undefined;
		this.toolDefinition = createDPiNativeToolRendererDefinition(toolCall.name);

		this.addChild(new Spacer(1));
		this.contentBox = new Box(1, 1, (text) => this.toolBg(text));
		this.contentText = new Text("", 1, 1, (text) => this.toolBg(text));
		this.selfRenderContainer = new Container();
		if (this.toolDefinition) {
			this.addChild(this.getRenderShell() === "self" ? this.selfRenderContainer : this.contentBox);
		} else {
			this.addChild(this.contentText);
		}
		this.updateContent();
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.updateContent();
	}

	override render(width: number): string[] {
		if (this.hideComponent) {
			return [];
		}
		if (this.toolDefinition && this.getRenderShell() === "self") {
			const contentLines = this.selfRenderContainer.render(width);
			return contentLines.length > 0 ? ["", ...contentLines] : [];
		}
		return super.render(width);
	}

	private updateContent(): void {
		this.hideComponent = false;
		if (this.toolDefinition) {
			const renderContainer = this.getRenderShell() === "self" ? this.selfRenderContainer : this.contentBox;
			if (renderContainer instanceof Box) {
				renderContainer.setBgFn((text) => this.toolBg(text));
			}
			renderContainer.clear();
			let hasContent = false;
			const callRenderer = this.toolDefinition.renderCall;
			if (callRenderer) {
				try {
					const component = callRenderer(
						this.toolCall.arguments,
						this.theme,
						this.getRenderContext(this.callRendererComponent),
					);
					this.callRendererComponent = component;
					renderContainer.addChild(component);
					hasContent = true;
				} catch {
					this.callRendererComponent = undefined;
					renderContainer.addChild(this.createCallFallback());
					hasContent = true;
				}
			} else {
				renderContainer.addChild(this.createCallFallback());
				hasContent = true;
			}
			if (this.result) {
				const resultRenderer = this.toolDefinition.renderResult;
				if (resultRenderer) {
					try {
						const component = resultRenderer(
							toToolResultLike(this.result),
							{ expanded: this.expanded, isPartial: this.isPartial },
							this.theme,
							this.getRenderContext(this.resultRendererComponent),
						);
						this.resultRendererComponent = component;
						renderContainer.addChild(component);
						hasContent = true;
					} catch {
						this.resultRendererComponent = undefined;
						const component = this.createResultFallback();
						if (component) {
							renderContainer.addChild(component);
							hasContent = true;
						}
					}
				} else {
					const component = this.createResultFallback();
					if (component) {
						renderContainer.addChild(component);
						hasContent = true;
					}
				}
			}
			this.hideComponent = !hasContent;
			return;
		}
		this.contentText.setCustomBgFn((text) => this.toolBg(text));
		this.contentText.setText(this.formatFallbackToolExecution());
	}

	private toolBg(text: string): string {
		if (this.isPartial) {
			return this.theme.bg("toolPendingBg", text);
		}
		return this.theme.bg(this.result?.isError ? "toolErrorBg" : "toolSuccessBg", text);
	}

	private getRenderShell(): "default" | "self" {
		return this.toolDefinition?.renderShell ?? "default";
	}

	private getRenderContext(lastComponent: Component | undefined): DPiNativeToolRenderContext {
		return {
			args: this.toolCall.arguments,
			toolCallId: this.toolCall.id,
			invalidate: () => this.invalidate(),
			lastComponent,
			state: this.rendererState,
			cwd: this.cwd,
			executionStarted: this.result !== undefined,
			argsComplete: true,
			isPartial: this.isPartial,
			expanded: this.expanded,
			showImages: this.showImages,
			isError: this.result?.isError ?? false,
		};
	}

	private createCallFallback(): Component {
		return new Text(this.theme.fg("toolTitle", this.theme.bold(this.toolCall.name)), 0, 0);
	}

	private createResultFallback(): Component | undefined {
		if (!this.result) {
			return undefined;
		}
		const output = toolResultText(this.result);
		return output ? new Text(this.theme.fg("toolOutput", output), 0, 0) : undefined;
	}

	private formatFallbackToolExecution(): string {
		let text = this.theme.fg("toolTitle", this.theme.bold(this.toolCall.name));
		const args = formatJson(this.toolCall.arguments);
		if (args) {
			text += `\n\n${args}`;
		}
		const output = this.result ? toolResultText(this.result) : "";
		if (output) {
			text += `\n${this.theme.fg("toolOutput", output)}`;
		}
		return text;
	}
}

function toToolResultLike(result: ToolResultMessage): DPiNativeToolResultLike {
	return {
		content: result.content,
		...("details" in result ? { details: result.details } : {}),
		...(result.isError ? { isError: true } : {}),
	} as DPiNativeToolResultLike;
}

function toolResultText(result: ToolResultMessage): string {
	return result.content
		.map((part) => {
			if (part.type === "text") {
				return part.text;
			}
			return `[image:${part.mimeType}]`;
		})
		.filter((text) => text.length > 0)
		.join("\n");
}

function formatJson(value: unknown): string {
	try {
		const text = JSON.stringify(value);
		return text === "{}" ? "" : text;
	} catch {
		return "";
	}
}
