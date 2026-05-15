import type { AgentMessage } from "@earendil-works/pi-agent-core";
import "@mariozechner/mini-lit/dist/MarkdownBlock.js";
import type { AssistantMessage, ToolResultMessage } from "@sheason/pi-ai";
import { html, LitElement, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { keyed } from "lit/directives/keyed.js";
import { live } from "lit/directives/live.js";
import { repeat } from "lit/directives/repeat.js";
import "../../web-ui/src/components/Messages.js";
import "./d-pi-tool-call-card.js";
import { formatRunDuration } from "./message-metrics.js";
import {
	clearBrowserToken,
	DPiWebClient,
	type DPiWebClientSnapshot,
	readBrowserToken,
	resolveAgentIdFromPath,
	resolveDefaultAgentIdFromWelcome,
	saveBrowserToken,
} from "./remote-client.js";
import {
	type ComposerActionIcon,
	createAgentPath,
	formatMessageSourceLabel,
	formatMessageSourceTooltip,
	getComposerActionView,
	getHeaderAgentId,
	getMessageSource,
	getSelectableAgentIds,
	getSelectedAgentIsRunning,
} from "./view-helpers.js";

type WebAgentItem = NonNullable<DPiWebClientSnapshot["agent"]>["items"][number];
type WebAgentModel = NonNullable<DPiWebClientSnapshot["agent"]>["context"]["model"];
type WebRunTiming = Extract<WebAgentItem, { type: "run_timing" }>["timing"];
type LockState = "locked" | "unlocking" | "unlocked";

@customElement("d-pi-web-app")
export class DPiWebApp extends LitElement {
	private readonly initialAgentId = resolveAgentIdFromPath(globalThis.location?.pathname);
	@property({ attribute: false }) client = new DPiWebClient({
		agentId: this.initialAgentId,
	});
	@state() private snapshot: DPiWebClientSnapshot = this.client.snapshot;
	@state() private selectedAgentId = this.initialAgentId;
	@state() private inputValue = "";
	@state() private lockState: LockState = "locked";
	@state() private tokenValue = readBrowserToken();
	@state() private lockError: string | undefined;
	private unsubscribeClient: (() => void) | undefined;
	private readonly peerId = createWebHostId();
	private authToken = "";

	protected override createRenderRoot(): HTMLElement | DocumentFragment {
		return this;
	}

	override connectedCallback(): void {
		super.connectedCallback();
		globalThis.addEventListener?.("popstate", this.handlePopState);
	}

	override disconnectedCallback(): void {
		globalThis.removeEventListener?.("popstate", this.handlePopState);
		this.disconnectClient();
		super.disconnectedCallback();
	}

	override render(): TemplateResult {
		if (this.lockState !== "unlocked") {
			return this.renderLockPage();
		}
		const agent = this.snapshot.agent;
		const items = agent?.items ?? [];
		const pendingToolCalls = new Set<string>(agent?.context.pendingToolCallIds ?? []);
		const isRunning = this.isSelectedAgentRunning();
		return html`<main class="flex h-screen flex-col bg-base-100 text-base-content">
			${this.renderHeader(isRunning)}
			<section class="min-h-0 flex-1 overflow-y-auto px-4 py-4 md:px-8" data-message-scroll>
				<div class="mx-auto flex max-w-5xl flex-col gap-4">
					${this.renderConnectionNotice()} ${this.renderLiveStatus()} ${this.renderQueue()}
					${items.length === 0 ? this.renderEmptyState() : ""}
					${this.renderItems(items, pendingToolCalls, isRunning)}
				</div>
			</section>
			<footer class="border-t border-base-300 bg-base-100 px-4 py-3 md:px-8">
				<div class="mx-auto max-w-5xl">
					${this.renderInput(isRunning)}
				</div>
			</footer>
		</main>`;
	}

	private renderHeader(isRunning: boolean): TemplateResult {
		const state = this.snapshot.connectionState;
		const connected = state === "connected";
		const statusText = connected ? (isRunning ? "工作中" : "空闲") : formatConnectionState(state);
		const agentId = getHeaderAgentId(this.selectedAgentId, this.snapshot.agentId);
		const agentIds = getSelectableAgentIds(this.snapshot.view, agentId);
		const identity = this.snapshot.welcome?.identity;
		const identityText =
			identity === undefined ? "未认证" : `${identity.name} · 范围 ${this.snapshot.welcome?.scopeRootAgentId}`;
		const modelText = formatModel(this.snapshot.agent?.context.model);
		const statusClass = connected
			? isRunning
				? "inline-flex items-center gap-1.5 rounded-full border border-info/25 bg-info/10 px-2 py-1 text-xs font-medium text-info"
				: "inline-flex items-center gap-1.5 rounded-full border border-success/25 bg-success/10 px-2 py-1 text-xs font-medium text-success"
			: "inline-flex items-center gap-1.5 rounded-full border border-base-300 bg-base-200 px-2 py-1 text-xs font-medium text-base-content/60";
		const statusDotClass = connected
			? isRunning
				? "size-1.5 rounded-full bg-info"
				: "size-1.5 rounded-full bg-success"
			: "size-1.5 rounded-full bg-base-content/40";
		return html`<header class="navbar border-b border-base-300 bg-base-100 px-4 shadow-sm md:px-8">
			<div class="mx-auto flex w-full max-w-5xl items-center justify-between gap-4">
				<div class="min-w-0">
					<h1 class="text-lg font-semibold">D-Pi 网页控制台</h1>
					<p class="truncate text-sm text-base-content/60">
						${agentId} 智能体 · ${identityText} · 模型 ${modelText}
					</p>
				</div>
				<div class="flex items-center gap-3">
					<label class="flex items-center gap-2 text-sm text-base-content/70">
						<span>智能体</span>
						${keyed(
							agentId,
							html`<select
								class="select select-sm bg-base-100"
								.value=${live(agentId)}
								@change=${this.handleAgentChange}
							>
								${repeat(
									agentIds,
									(id) => id,
									(id) => html`<option value=${id} .selected=${id === agentId}>${id}</option>`,
								)}
							</select>`,
						)}
					</label>
					<div class=${statusClass}><span class=${statusDotClass}></span>${statusText}</div>
					<button type="button" class="btn btn-ghost btn-sm" @click=${this.handleLock}>锁定</button>
				</div>
			</div>
		</header>`;
	}

	private renderLockPage(): TemplateResult {
		const isUnlocking = this.lockState === "unlocking";
		return html`<main class="flex h-screen items-center justify-center bg-base-200 px-4 text-base-content">
			<section class="card w-full max-w-md border border-base-300 bg-base-100 shadow-xl">
				<form class="card-body gap-5" @submit=${this.handleUnlock}>
					<div class="space-y-2">
						<div class="badge badge-outline">D-Pi 网页控制台</div>
						<h1 class="text-2xl font-semibold">解锁 Hub 访问</h1>
						<p class="text-sm text-base-content/60">
							输入 root 或智能体范围的访问令牌。验证通过后，控制台会打开到创建该令牌的智能体。
						</p>
					</div>
					<label class="flex flex-col gap-2">
						<span class="label">访问令牌</span>
						<input
							class="input w-full font-mono"
							type="password"
							autocomplete="current-password"
							placeholder="dpi_..."
							.value=${live(this.tokenValue)}
							?disabled=${isUnlocking}
							@input=${this.handleTokenInput}
						/>
					</label>
					${
						this.lockError
							? html`<div class="alert alert-error py-3 text-sm">
								<span>${this.lockError}</span>
							</div>`
							: ""
					}
					<button
						type="submit"
						class="btn btn-primary w-full"
						?disabled=${isUnlocking || this.tokenValue.trim().length === 0}
					>
						${isUnlocking ? "正在解锁..." : "解锁"}
					</button>
				</form>
			</section>
		</main>`;
	}

	private renderConnectionNotice(): TemplateResult | string {
		if (this.snapshot.connectionState !== "error" && !this.snapshot.error) {
			return "";
		}
		return html`<div class="alert alert-error">
			${this.snapshot.error ?? "连接 D-Pi 枢纽失败。"}
		</div>`;
	}

	private renderLiveStatus(): TemplateResult | string {
		const statusMessage = this.snapshot.agent?.live.statusMessage;
		if (!statusMessage) {
			return "";
		}
		return html`<div class="alert alert-info">
			${statusMessage}
		</div>`;
	}

	private renderQueue(): TemplateResult | string {
		const queue = this.snapshot.agent?.queue;
		if (!queue || queue.size === 0) {
			return "";
		}
		return html`<div class="card border border-base-300 bg-base-200 shadow-sm">
			<div class="card-body gap-3 p-4">
				<div class="flex items-center gap-2 text-sm font-medium">
					<span>队列消息</span>
					<span class="badge badge-neutral">${queue.size}</span>
				</div>
				<div class="flex flex-col gap-2">
					${queue.messages.map(
						(
							message: (typeof queue.messages)[number],
						) => html`<div class="rounded-box border border-base-300 bg-base-100 px-3 py-2 text-sm">
							<span class="font-medium text-base-content/70">${formatMessageSourceLabel(message.messageSource)}</span>:
							${message.text}
						</div>`,
					)}
				</div>
			</div>
		</div>`;
	}

	private renderItems(
		items: NonNullable<DPiWebClientSnapshot["agent"]>["items"],
		pendingToolCalls: ReadonlySet<string>,
		isRunning: boolean,
	): TemplateResult {
		const toolResultsById = new Map<string, ToolResultMessage<unknown>>();
		for (const item of items) {
			if (item.type === "message" && item.message.role === "toolResult") {
				toolResultsById.set(item.message.toolCallId, item.message);
			}
		}
		return html`<div class="flex flex-col gap-3">
			${items.map((item: WebAgentItem) =>
				item.type === "message"
					? this.renderMessage(item.message, pendingToolCalls, isRunning, toolResultsById)
					: this.renderRunTiming(item.timing),
			)}
		</div>`;
	}

	private renderMessage(
		message: AgentMessage,
		pendingToolCalls: ReadonlySet<string>,
		isRunning: boolean,
		toolResultsById: Map<string, ToolResultMessage<unknown>>,
	): TemplateResult | string {
		if (message.role === "artifact" || message.role === "toolResult") {
			return "";
		}
		if (message.role === "user" || message.role === "user-with-attachments") {
			const sourceLabel = formatMessageSourceLabel(getMessageSource(message));
			const sourceTooltip = formatMessageSourceTooltip(sourceLabel);
			return html`<div class="flex flex-col gap-1">
				${
					sourceLabel
						? html`<div class="tooltip tooltip-right mx-4 w-fit text-xs font-medium text-orange-500" data-tip=${sourceTooltip}>
							${sourceLabel}
						</div>`
						: ""
				}
				<user-message .message=${message}></user-message>
			</div>`;
		}
		if (message.role === "assistant") {
			return this.renderAssistantMessage(message as AssistantMessage, pendingToolCalls, isRunning, toolResultsById);
		}
		return "";
	}

	private renderRunTiming(timing: WebRunTiming): TemplateResult {
		return html`<div class="px-4 text-xs text-base-content/60">${formatRunDuration(timing.durationMs, timing.endReason)}</div>`;
	}

	private renderEmptyState(): TemplateResult {
		return html`<div class="hero min-h-80 rounded-box border border-dashed border-base-300 bg-base-200/40">
			<div class="max-w-md px-6 text-center">
				<div class="mb-2 text-lg font-medium">连接到 ${this.snapshot.agentId} 智能体</div>
				<p class="text-sm text-base-content/60">
					从下方开始对话。消息会通过 D-Pi 枢纽排队，并从 CRDT 视图中渲染。
				</p>
			</div>
		</div>`;
	}

	private renderInput(isRunning: boolean): TemplateResult {
		const action = getComposerActionView({
			isConnected: this.snapshot.connectionState === "connected",
			isRunning,
			inputValue: this.inputValue,
		});
		return html`<div class="card border border-base-300 bg-base-100 shadow-sm">
			<div class="card-body gap-3 p-3">
			<textarea
				class="textarea textarea-bordered min-h-24 w-full resize-none"
				placeholder=${`发送消息给 ${this.selectedAgentId} 智能体...`}
				.value=${this.inputValue}
				?disabled=${this.snapshot.connectionState !== "connected"}
				@input=${this.handleInput}
				@keydown=${this.handleInputKeyDown}
			></textarea>
			<div class="flex items-center justify-between">
				<div class="text-xs text-base-content/60">${action.hint}</div>
				<button
					type="button"
					class=${action.buttonClass}
					aria-label=${action.ariaLabel}
					title=${action.title}
					?disabled=${action.disabled}
					@click=${action.kind === "interrupt" ? this.handleAbort : this.handleSend}
				>
					${this.renderComposerActionIcon(action.icon)}
				</button>
			</div>
			</div>
		</div>`;
	}

	private renderComposerActionIcon(icon: ComposerActionIcon): TemplateResult {
		if (icon === "stop") {
			return html`<svg
				xmlns="http://www.w3.org/2000/svg"
				viewBox="0 0 20 20"
				fill="currentColor"
				class="size-4"
				aria-hidden="true"
			>
				<path d="M5.75 5.75h8.5v8.5h-8.5z" />
			</svg>`;
		}
		return html`<svg
			xmlns="http://www.w3.org/2000/svg"
			viewBox="0 0 20 20"
			fill="currentColor"
			class="size-4"
			aria-hidden="true"
		>
			<path
				d="M3.105 3.105a.75.75 0 0 1 .814-.164l13 6.25a.75.75 0 0 1 0 1.352l-13 6.25A.75.75 0 0 1 2.864 16l1.662-5.238H10a.75.75 0 0 0 0-1.5H4.526L2.864 4a.75.75 0 0 1 .241-.895Z"
			/>
		</svg>`;
	}

	private renderAssistantMessage(
		message: AssistantMessage,
		pendingToolCalls: ReadonlySet<string>,
		_isRunning: boolean,
		toolResultsById: Map<string, ToolResultMessage<unknown>>,
	): TemplateResult {
		return html`<div class="px-4">
			<div class="flex flex-col gap-3">
				${message.content.map((chunk) => {
					if (chunk.type === "text" && chunk.text.trim() !== "") {
						return html`<markdown-block .content=${chunk.text}></markdown-block>`;
					}
					if (chunk.type === "thinking" && chunk.thinking.trim() !== "") {
						return html`<thinking-block .content=${chunk.thinking} .isStreaming=${false}></thinking-block>`;
					}
					if (chunk.type === "toolCall") {
						const result = toolResultsById.get(chunk.id);
						const aborted = message.stopReason === "aborted" && !result;
						return html`<d-pi-tool-call-card
							.toolCall=${chunk}
							.result=${result}
							.pending=${pendingToolCalls.has(chunk.id)}
							.aborted=${aborted}
						></d-pi-tool-call-card>`;
					}
					return "";
				})}
			</div>
			${
				message.stopReason === "error" && message.errorMessage
					? html`<div class="alert alert-error mt-3 text-sm"><strong>错误：</strong> ${message.errorMessage}</div>`
					: ""
			}
			${message.stopReason === "aborted" ? html`<div class="alert alert-warning mt-3 text-sm">请求已中断</div>` : ""}
		</div>`;
	}

	private handleInput = (event: Event): void => {
		this.inputValue = (event.target as HTMLTextAreaElement).value;
	};

	private handleInputKeyDown = (event: KeyboardEvent): void => {
		if (event.isComposing || event.key !== "Enter" || event.shiftKey) {
			return;
		}
		event.preventDefault();
		if (this.isSelectedAgentRunning()) {
			return;
		}
		void this.handleSend();
	};

	private handleSend = async (): Promise<void> => {
		if (this.isSelectedAgentRunning()) {
			return;
		}
		const message = this.inputValue;
		this.inputValue = "";
		await this.client.sendMessage(message);
	};

	private handleAbort = async (): Promise<void> => {
		await this.client.abort();
	};

	private handleAgentChange = (event: Event): void => {
		const agentId = (event.target as HTMLSelectElement).value;
		if (!agentId || agentId === this.selectedAgentId) {
			return;
		}
		this.switchAgent(agentId, true);
	};

	private handlePopState = (): void => {
		if (this.lockState !== "unlocked") {
			return;
		}
		this.switchAgent(resolveAgentIdFromPath(globalThis.location?.pathname), false);
	};

	private handleTokenInput = (event: Event): void => {
		this.tokenValue = (event.target as HTMLInputElement).value;
		this.lockError = undefined;
	};

	private handleUnlock = async (event: Event): Promise<void> => {
		event.preventDefault();
		const token = this.tokenValue.trim();
		if (!token) {
			this.lockError = "必须输入访问令牌。";
			return;
		}
		this.lockState = "unlocking";
		this.lockError = undefined;
		this.disconnectClient();
		const client = new DPiWebClient({ peerId: this.peerId, token });
		this.client = client;
		this.snapshot = client.snapshot;
		try {
			await this.connectClient(client);
			await this.waitForWelcome(client);
			this.authToken = token;
			saveBrowserToken(token);
			const defaultAgentId = resolveDefaultAgentIdFromWelcome(client.snapshot.welcome);
			this.selectedAgentId = defaultAgentId;
			this.inputValue = "";
			this.lockState = "unlocked";
			globalThis.history?.replaceState({}, "", createAgentPath(defaultAgentId));
		} catch (error) {
			this.lockError = error instanceof Error ? error.message : String(error);
			this.lockState = "locked";
			this.disconnectClient();
			this.client = new DPiWebClient();
			this.snapshot = this.client.snapshot;
		}
	};

	private handleLock = (): void => {
		clearBrowserToken();
		this.authToken = "";
		this.lockError = undefined;
		this.lockState = "locked";
		this.disconnectClient();
		this.client = new DPiWebClient();
		this.snapshot = this.client.snapshot;
	};

	private switchAgent(agentId: string, pushPath: boolean): void {
		if (agentId === this.selectedAgentId) {
			return;
		}
		this.selectedAgentId = agentId;
		if (pushPath) {
			globalThis.history?.pushState({}, "", createAgentPath(agentId));
		}
		this.disconnectClient();
		this.client = new DPiWebClient({ agentId, peerId: this.peerId, token: this.authToken });
		this.snapshot = this.client.snapshot;
		this.inputValue = "";
		void this.connectClient(this.client).catch(() => undefined);
	}

	private connectClient(client: DPiWebClient): Promise<void> {
		this.unsubscribeClient = client.subscribe((snapshot) => {
			this.snapshot = snapshot;
			this.updateComplete.then(() => this.scrollMessagesToBottom()).catch(() => undefined);
		});
		return client.connect();
	}

	private waitForWelcome(client: DPiWebClient): Promise<void> {
		if (client.snapshot.welcome) {
			return Promise.resolve();
		}
		return new Promise((resolve) => {
			const unsubscribe = client.subscribe((snapshot) => {
				if (snapshot.welcome) {
					unsubscribe();
					resolve();
				}
			});
		});
	}

	private disconnectClient(): void {
		this.unsubscribeClient?.();
		this.unsubscribeClient = undefined;
		this.client.disconnect();
	}

	private isSelectedAgentRunning(): boolean {
		return getSelectedAgentIsRunning(this.snapshot.view, this.selectedAgentId);
	}

	private scrollMessagesToBottom(): void {
		const scroll = this.querySelector("[data-message-scroll]");
		if (scroll) {
			scroll.scrollTop = scroll.scrollHeight;
		}
	}
}

function createWebHostId(): string {
	return `web-${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
}

function formatConnectionState(state: DPiWebClientSnapshot["connectionState"]): string {
	switch (state) {
		case "connected":
			return "已连接";
		case "connecting":
			return "连接中";
		case "disconnected":
			return "未连接";
		case "error":
			return "连接异常";
	}
}

function formatModel(model: WebAgentModel | undefined): string {
	if (!model) {
		return "未配置";
	}
	return `${model.provider}/${model.modelId}`;
}

declare global {
	interface HTMLElementTagNameMap {
		"d-pi-web-app": DPiWebApp;
	}
}
