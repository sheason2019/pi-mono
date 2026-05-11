import { html, LitElement, type TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import { PUBLIC_ORG_ENDPOINT } from "./app-router.js";
import type { PublicOrgAgent, PublicOrgSnapshot } from "./d-pi-hub-protocol.js";

@customElement("d-pi-public-org")
export class DPiPublicOrg extends LitElement {
	@state() private snapshot: PublicOrgSnapshot | undefined;
	@state() private error: string | undefined;
	private refreshTimer: ReturnType<typeof setInterval> | undefined;

	protected override createRenderRoot(): HTMLElement | DocumentFragment {
		return this;
	}

	override connectedCallback(): void {
		super.connectedCallback();
		void this.refresh();
		this.refreshTimer = setInterval(() => {
			void this.refresh();
		}, 5000);
	}

	override disconnectedCallback(): void {
		if (this.refreshTimer) {
			clearInterval(this.refreshTimer);
			this.refreshTimer = undefined;
		}
		super.disconnectedCallback();
	}

	override render(): TemplateResult {
		const snapshot = this.snapshot;
		return html`<main class="h-screen overflow-y-auto bg-base-200 px-4 py-6 text-base-content md:px-8">
			<section class="mx-auto flex max-w-6xl flex-col gap-6">
				<header class="flex flex-col gap-4 rounded-box border border-base-300 bg-base-100 p-5 shadow-sm md:flex-row md:items-end md:justify-between">
					<div>
						<div class="badge badge-outline">D-Pi Public</div>
						<h1 class="mt-3 text-2xl font-semibold">Organization Architecture</h1>
						<p class="mt-2 max-w-2xl text-sm text-base-content/60">
							Public, sanitized agent topology and activation status. Control surfaces remain token protected.
						</p>
					</div>
					<a class="btn btn-primary btn-sm" href=${this.getAgentUiHref("root")}>Open agent UI</a>
				</header>
				${this.renderSummary(snapshot)} ${this.error ? this.renderError(this.error) : ""}
				${snapshot ? this.renderTree(snapshot.agents) : this.renderLoading()}
			</section>
		</main>`;
	}

	private renderSummary(snapshot: PublicOrgSnapshot | undefined): TemplateResult {
		const agents = snapshot?.agents ?? [];
		const activeCount = agents.filter((agent) => agent.activationStatus === "running" || agent.isRunning).length;
		const peerCount = agents.reduce((sum, agent) => sum + agent.peerCount, 0);
		const errorCount = agents.filter((agent) => agent.hasError || agent.activationStatus === "error").length;
		return html`<section class="grid gap-3 md:grid-cols-4">
			${this.renderStat("Agents", String(agents.length))}
			${this.renderStat("Active", String(activeCount))}
			${this.renderStat("Peers", String(peerCount))}
			${this.renderStat("Errors", String(errorCount))}
		</section>`;
	}

	private renderStat(label: string, value: string): TemplateResult {
		return html`<div class="rounded-box border border-base-300 bg-base-100 p-4 shadow-sm">
			<div class="text-xs uppercase tracking-wide text-base-content/50">${label}</div>
			<div class="mt-1 text-2xl font-semibold">${value}</div>
		</div>`;
	}

	private renderTree(agents: PublicOrgAgent[]): TemplateResult {
		if (agents.length === 0) {
			return html`<section class="rounded-box border border-base-300 bg-base-100 p-8 text-center text-base-content/60">
				No agents registered.
			</section>`;
		}
		const tree = buildAgentTree(agents);
		return html`<section class="rounded-box border border-base-300 bg-base-100 p-4 shadow-sm md:p-6">
			<div class="mb-4 flex items-center justify-between gap-3">
				<h2 class="text-lg font-semibold">Agent Tree</h2>
				<div class="text-xs text-base-content/50">Updated ${this.snapshot?.generatedAt ?? "unknown"}</div>
			</div>
			<div class="flex flex-col gap-3">
				${repeat(
					tree.roots,
					(agent) => agent.id,
					(agent) => this.renderAgentNode(agent, tree.childrenByParent, 0),
				)}
			</div>
		</section>`;
	}

	private renderAgentNode(
		agent: PublicOrgAgent,
		childrenByParent: Map<string, PublicOrgAgent[]>,
		depth: number,
	): TemplateResult {
		const children = childrenByParent.get(agent.id) ?? [];
		const statusClass = getStatusClass(agent);
		const label = agent.name ? `${agent.name} (${agent.id})` : agent.id;
		return html`<article class="rounded-box border border-base-300 bg-base-100">
			<div class="flex flex-col gap-3 p-4 md:flex-row md:items-center md:justify-between" style=${`margin-left: ${depth * 1.25}rem`}>
				<div class="min-w-0">
					<div class="flex flex-wrap items-center gap-2">
						<h3 class="truncate font-semibold">${label}</h3>
						<span class=${statusClass}>${formatActivationStatus(agent)}</span>
					</div>
					<p class="mt-1 text-sm text-base-content/60">Public status only. Agent details require token access.</p>
					<div class="mt-2 flex flex-wrap gap-2 text-xs text-base-content/50">
						<span>${agent.kind ?? "agent"}</span>
						<span>${agent.lifecycle ?? "unknown"}</span>
						<span>${agent.peerCount} peers</span>
					</div>
				</div>
				<a class="btn btn-ghost btn-xs" href=${this.getAgentUiHref(agent.id)}>Control</a>
			</div>
			${
				children.length > 0
					? html`<div class="flex flex-col gap-3 border-t border-base-200 p-3">
							${repeat(
								children,
								(child) => child.id,
								(child) => this.renderAgentNode(child, childrenByParent, depth + 1),
							)}
						</div>`
					: ""
			}
		</article>`;
	}

	private renderLoading(): TemplateResult {
		return html`<section class="rounded-box border border-base-300 bg-base-100 p-8 text-center text-base-content/60">
			Loading public organization status...
		</section>`;
	}

	private renderError(error: string): TemplateResult {
		return html`<div class="alert alert-error">
			<span>${error}</span>
		</div>`;
	}

	private async refresh(): Promise<void> {
		try {
			const response = await fetch(PUBLIC_ORG_ENDPOINT, { cache: "no-store" });
			if (!response.ok) {
				throw new Error(`Public org request failed with HTTP ${response.status}`);
			}
			this.snapshot = (await response.json()) as PublicOrgSnapshot;
			this.error = undefined;
		} catch (error) {
			this.error = error instanceof Error ? error.message : String(error);
		}
	}

	private getAgentUiHref(agentId: string): string {
		const search = globalThis.location?.search ?? "";
		return `/agents/${encodeURIComponent(agentId)}${search}`;
	}
}

function buildAgentTree(agents: PublicOrgAgent[]): {
	roots: PublicOrgAgent[];
	childrenByParent: Map<string, PublicOrgAgent[]>;
} {
	const ids = new Set(agents.map((agent) => agent.id));
	const roots: PublicOrgAgent[] = [];
	const childrenByParent = new Map<string, PublicOrgAgent[]>();
	for (const agent of agents) {
		if (!agent.parentId || !ids.has(agent.parentId)) {
			roots.push(agent);
			continue;
		}
		const children = childrenByParent.get(agent.parentId) ?? [];
		children.push(agent);
		childrenByParent.set(agent.parentId, children);
	}
	return { roots, childrenByParent };
}

function getStatusClass(agent: PublicOrgAgent): string {
	if (agent.hasError || agent.activationStatus === "error") {
		return "badge badge-error badge-sm";
	}
	if (agent.isRunning) {
		return "badge badge-info badge-sm";
	}
	if (agent.activationStatus === "running") {
		return "badge badge-success badge-sm";
	}
	if (agent.activationStatus === "loading") {
		return "badge badge-warning badge-sm";
	}
	return "badge badge-ghost badge-sm";
}

function formatActivationStatus(agent: PublicOrgAgent): string {
	if (agent.isRunning) {
		return "working";
	}
	return agent.activationStatus.replace("_", " ");
}
