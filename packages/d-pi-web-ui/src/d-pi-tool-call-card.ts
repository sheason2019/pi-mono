import type { ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { html, LitElement, type TemplateResult } from "lit";
import { customElement, property } from "lit/decorators.js";
import {
	formatToolCallArguments,
	formatUnknown,
	getToolCallOutputText,
	getToolCallStatus,
	getToolCallStatusView,
	getToolCommandPreview,
} from "./tool-call-view.js";

@customElement("d-pi-tool-call-card")
export class DPiToolCallCard extends LitElement {
	@property({ type: Object }) toolCall!: ToolCall;
	@property({ type: Object }) result?: ToolResultMessage<unknown>;
	@property({ type: Boolean }) pending = false;
	@property({ type: Boolean }) aborted = false;

	protected override createRenderRoot(): HTMLElement | DocumentFragment {
		return this;
	}

	override connectedCallback(): void {
		super.connectedCallback();
		this.style.display = "block";
	}

	override render(): TemplateResult {
		const status = getToolCallStatus({ pending: this.pending, aborted: this.aborted, result: this.result });
		const statusView = getToolCallStatusView(status);
		const command = getToolCommandPreview(this.toolCall.name, this.toolCall.arguments);
		const output = getToolCallOutputText(this.result);
		const details = this.result?.details === undefined ? undefined : formatUnknown(this.result.details);

		return html`<article class="card border border-base-300 bg-base-200 shadow-sm">
			<div class="card-body gap-3 p-4">
				<div class="flex flex-wrap items-center justify-between gap-2">
					<div class="flex flex-wrap items-center gap-2">
						<span
							class="inline-flex items-center rounded-full border border-base-300 bg-base-100 px-2 py-0.5 font-mono text-[11px] font-medium text-base-content/70"
							>${this.toolCall.name}</span
						>
						<span class=${statusView.badgeClass}>
							${status === "pending" ? html`<span class="loading loading-spinner loading-xs"></span>` : ""}
							${statusView.label}
						</span>
					</div>
					<span class="text-xs text-base-content/60">${this.toolCall.id}</span>
				</div>

				${command ? this.renderCommand(command, status) : ""}
				${this.renderCollapse("Arguments", formatToolCallArguments(this.toolCall.arguments), "json", false)}
				${output ? this.renderCollapse("Output", output, "text", status === "error") : this.renderPendingOutput(status)}
				${details ? this.renderCollapse("Details", details, "json", false) : ""}
			</div>
		</article>`;
	}

	private renderCommand(command: string, status: string): TemplateResult {
		return html`<div class="rounded-box border border-base-300 bg-base-100 p-3">
			<div class="mb-2 flex items-center gap-2 text-sm font-medium">
				${status === "pending" ? html`<span class="loading loading-spinner loading-xs text-info"></span>` : ""}
				<span>${status === "pending" ? "Running Command" : "Command"}</span>
			</div>
			<pre class="overflow-x-auto whitespace-pre-wrap break-words text-sm"><code>${command}</code></pre>
		</div>`;
	}

	private renderPendingOutput(status: string): TemplateResult | string {
		if (status !== "pending") {
			return "";
		}
		return html`<div class="text-sm text-base-content/60">Waiting for tool result...</div>`;
	}

	private renderCollapse(title: string, content: string, language: string, open: boolean): TemplateResult {
		return html`<details class="collapse collapse-arrow border border-base-300 bg-base-100" .open=${open}>
			<summary class="collapse-title min-h-0 py-3 text-sm font-medium">${title}</summary>
			<div class="collapse-content">
				<pre class="max-h-96 overflow-auto rounded-box bg-base-300/50 p-3 text-xs"><code data-language=${language}>${content}</code></pre>
			</div>
		</details>`;
	}
}

declare global {
	interface HTMLElementTagNameMap {
		"d-pi-tool-call-card": DPiToolCallCard;
	}
}
