import { html, LitElement, svg, type TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import { PUBLIC_ORG_ENDPOINT } from "./app-router.js";
import type { PublicOrgAgent, PublicOrgSnapshot } from "./d-pi-hub-protocol.js";

const TREE_CARD_WIDTH = 260;
const TREE_CARD_HEIGHT = 128;
const TREE_GAP_X = 132;
const TREE_GAP_Y = 28;
const TREE_PADDING = 28;
const TREE_MIN_HEIGHT = 420;
const TREE_ZOOM_MIN = 0.5;
const TREE_ZOOM_MAX = 1.8;
const TREE_ZOOM_STEP = 0.1;

export interface PublicOrgTreeLayout {
	width: number;
	height: number;
	card: {
		width: number;
		height: number;
	};
	gap: {
		x: number;
		y: number;
	};
	nodes: PublicOrgTreeLayoutNode[];
	edges: PublicOrgTreeLayoutEdge[];
}

export interface PublicOrgTreeLayoutNode {
	agent: PublicOrgAgent;
	x: number;
	y: number;
}

export interface PublicOrgTreeLayoutEdge {
	parentId: string;
	childId: string;
	from: TreePoint;
	to: TreePoint;
}

export interface TreePoint {
	x: number;
	y: number;
}

interface LayoutBranch {
	agent: PublicOrgAgent;
	children: LayoutBranch[];
	subtreeHeight: number;
	depth: number;
}

@customElement("d-pi-public-org")
export class DPiPublicOrg extends LitElement {
	@state() private snapshot: PublicOrgSnapshot | undefined;
	@state() private error: string | undefined;
	@state() private treeZoom = 1;
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
						<div class="badge badge-outline">D-Pi 公开视图</div>
						<h1 class="mt-3 text-2xl font-semibold">组织架构</h1>
						<p class="mt-2 max-w-2xl text-sm text-base-content/60">
							这里展示经过脱敏的智能体拓扑、运行状态和模型信息。控制台仍需要访问令牌。
						</p>
					</div>
					<a class="btn btn-primary btn-sm" href=${this.getAgentUiHref("root")}>打开控制台</a>
				</header>
				${this.renderSummary(snapshot)} ${this.error ? this.renderError(this.error) : ""}
				${snapshot ? this.renderOrg(snapshot) : this.renderLoading()}
			</section>
		</main>`;
	}

	private renderSummary(snapshot: PublicOrgSnapshot | undefined): TemplateResult {
		const agents = snapshot?.agents ?? [];
		const activeCount = agents.filter((agent) => agent.activationStatus === "running" || agent.isRunning).length;
		const peerCount = agents.reduce((sum, agent) => sum + agent.peerCount, 0);
		const errorCount = agents.filter((agent) => agent.hasError || agent.activationStatus === "error").length;
		return html`<section class="grid gap-3 md:grid-cols-4">
			${this.renderStat("智能体数", String(agents.length))}
			${this.renderStat("活跃中", String(activeCount))}
			${this.renderStat("连接端数", String(peerCount))}
			${this.renderStat("异常数", String(errorCount))}
		</section>`;
	}

	private renderStat(label: string, value: string): TemplateResult {
		return html`<div class="rounded-box border border-base-300 bg-base-100 p-4 shadow-sm">
			<div class="text-xs uppercase tracking-wide text-base-content/50">${label}</div>
			<div class="mt-1 text-2xl font-semibold">${value}</div>
		</div>`;
	}

	private renderOrg(snapshot: PublicOrgSnapshot): TemplateResult {
		const agents = snapshot.agents;
		if (agents.length === 0) {
			return html`<section class="rounded-box border border-base-300 bg-base-100 p-8 text-center text-base-content/60">
				暂无已注册的智能体。
			</section>`;
		}
		return html`${this.renderTreeChart(snapshot)} ${this.renderAgentCards(agents)}`;
	}

	private renderTreeChart(snapshot: PublicOrgSnapshot): TemplateResult {
		const layout = createPublicOrgTreeLayout(snapshot.agents);
		const zoom = this.treeZoom;
		return html`<section class="rounded-box border border-base-300 bg-base-100 p-4 shadow-sm md:p-6">
			<div class="mb-4 flex items-center justify-between gap-3">
				<div>
					<h2 class="text-lg font-semibold">智能体拓扑图</h2>
					<p class="mt-1 text-sm text-base-content/60">卡片展示父子关系，节点内包含当前模型。</p>
				</div>
				<div class="flex flex-col items-end gap-2">
					<div class="join">
						<button
							class="btn btn-ghost btn-xs join-item"
							title="缩小"
							?disabled=${zoom <= TREE_ZOOM_MIN}
							@click=${() => this.setTreeZoom(zoom - TREE_ZOOM_STEP)}
						>
							-
						</button>
						<button class="btn btn-ghost btn-xs join-item min-w-14" title="重置缩放" @click=${() => this.setTreeZoom(1)}>
							${Math.round(zoom * 100)}%
						</button>
						<button
							class="btn btn-ghost btn-xs join-item"
							title="放大"
							?disabled=${zoom >= TREE_ZOOM_MAX}
							@click=${() => this.setTreeZoom(zoom + TREE_ZOOM_STEP)}
						>
							+
						</button>
					</div>
					<div class="text-xs text-base-content/50">更新时间 ${snapshot.generatedAt}</div>
				</div>
			</div>
			<div class="rounded-box border border-base-300 bg-base-200/30">
				<div class="relative overflow-auto" style=${`min-height:${TREE_MIN_HEIGHT}px;`}>
					<div class="relative mx-auto" style=${getPublicOrgTreeScaledViewportStyle(layout, zoom)}>
						<div class="relative" style=${getPublicOrgTreePlaneStyle(layout, zoom)}>
							<svg
								class="pointer-events-none absolute inset-0 h-full w-full overflow-visible"
								viewBox=${`0 0 ${layout.width} ${layout.height}`}
								fill="none"
								aria-hidden="true"
							>
								${layout.edges.map(
									(edge) => svg`<path
										d=${formatTreeEdgePath(edge)}
										stroke=${getTreeEdgeColor(edge, layout.nodes)}
										stroke-width="1.8"
										stroke-linecap="round"
									/>`,
								)}
							</svg>
							${repeat(
								layout.nodes,
								(node) => node.agent.id,
								(node) => this.renderTreeCard(node, layout.card),
							)}
						</div>
					</div>
				</div>
			</div>
		</section>`;
	}

	private renderAgentCards(agents: PublicOrgAgent[]): TemplateResult {
		return html`<section class="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
			${repeat(
				agents,
				(agent) => agent.id,
				(agent) => this.renderAgentCard(agent),
			)}
		</section>`;
	}

	private renderAgentCard(agent: PublicOrgAgent): TemplateResult {
		const label = agent.name ? `${agent.name} (${agent.id})` : agent.id;
		return html`<article class="rounded-box border border-base-300 bg-base-100 p-4 shadow-sm">
			<div class="flex items-start justify-between gap-3">
				<div class="min-w-0">
					<h3 class="truncate font-semibold">${label}</h3>
					<div class="mt-2 flex flex-wrap gap-2">
						<span class=${getModelClass(agent)}>模型：${formatModel(agent)}</span>
					</div>
				</div>
				<span class=${getStatusClass(agent)}>${formatActivationStatus(agent)}</span>
			</div>
			<div class="mt-3 grid grid-cols-2 gap-2 text-xs text-base-content/60">
				<div>类型：${formatKind(agent.kind)}</div>
				<div>生命周期：${formatLifecycle(agent.lifecycle)}</div>
				<div>连接端：${agent.peerCount}</div>
				<div>父级：${agent.parentId ?? "无"}</div>
			</div>
			<a class="btn btn-ghost btn-xs mt-4" href=${this.getAgentUiHref(agent.id)}>进入控制台</a>
		</article>`;
	}

	private renderTreeCard(node: PublicOrgTreeLayoutNode, card: PublicOrgTreeLayout["card"]): TemplateResult {
		const agent = node.agent;
		const title = agent.name ?? agent.id;
		return html`<article
			class=${getTreeCardClass(agent)}
			style=${`left:${node.x}px;top:${node.y}px;width:${card.width}px;height:${card.height}px;`}
		>
			<div class="card-body gap-2 overflow-hidden p-4">
				<div class="flex items-start justify-between gap-3">
					<div class="min-w-0">
						<h3 class="truncate text-sm font-semibold" title=${title}>${title}</h3>
						<div class="truncate text-xs text-base-content/50" title=${agent.id}>${agent.id}</div>
					</div>
					<span class=${getStatusClass(agent)}>${formatActivationStatus(agent)}</span>
				</div>
				<div class="min-w-0">
					<span class=${getTreeModelClass(agent)} title=${formatModel(agent)}>模型：${formatModel(agent)}</span>
				</div>
				<div class="truncate text-xs text-base-content/50">
					连接端 ${agent.peerCount} · ${formatKind(agent.kind)} · 父级 ${agent.parentId ?? "无"}
				</div>
			</div>
		</article>`;
	}

	private renderLoading(): TemplateResult {
		return html`<section class="rounded-box border border-base-300 bg-base-100 p-8 text-center text-base-content/60">
			正在加载公开组织状态...
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
				throw new Error(`公开组织信息请求失败，HTTP ${response.status}`);
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

	private setTreeZoom(nextZoom: number): void {
		this.treeZoom = normalizePublicOrgTreeZoom(nextZoom);
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

export function createPublicOrgTreeLayout(agents: PublicOrgAgent[]): PublicOrgTreeLayout {
	const tree = buildAgentTree(agents);
	const roots = tree.roots.map((agent) => createLayoutBranch(agent, tree.childrenByParent, 0));
	const nodes: PublicOrgTreeLayoutNode[] = [];
	const edges: PublicOrgTreeLayoutEdge[] = [];
	let y = TREE_PADDING;
	for (const root of roots) {
		placeLayoutBranch(root, y, nodes, edges);
		y += root.subtreeHeight + TREE_GAP_Y;
	}
	const maxDepth = roots.reduce((max, root) => Math.max(max, getMaxDepth(root)), 0);
	const contentHeight =
		roots.length === 0
			? TREE_MIN_HEIGHT
			: TREE_PADDING * 2 +
				roots.reduce((sum, root) => sum + root.subtreeHeight, 0) +
				TREE_GAP_Y * (roots.length - 1);
	return {
		width: TREE_PADDING * 2 + (maxDepth + 1) * TREE_CARD_WIDTH + maxDepth * TREE_GAP_X,
		height: Math.max(TREE_MIN_HEIGHT, contentHeight),
		card: {
			width: TREE_CARD_WIDTH,
			height: TREE_CARD_HEIGHT,
		},
		gap: {
			x: TREE_GAP_X,
			y: TREE_GAP_Y,
		},
		nodes,
		edges,
	};
}

export function getPublicOrgTreePlaneStyle(layout: PublicOrgTreeLayout, zoom = 1): string {
	return getPublicOrgTreePlaneStyleForZoom(layout, zoom);
}

export function getPublicOrgTreeScaledViewportStyle(layout: PublicOrgTreeLayout, zoom: number): string {
	const normalizedZoom = normalizePublicOrgTreeZoom(zoom);
	return `width:${layout.width * normalizedZoom}px;height:${layout.height * normalizedZoom}px;`;
}

export function normalizePublicOrgTreeZoom(zoom: number): number {
	const clamped = Math.min(TREE_ZOOM_MAX, Math.max(TREE_ZOOM_MIN, zoom));
	return Math.round(clamped * 10) / 10;
}

function getPublicOrgTreePlaneStyleForZoom(layout: PublicOrgTreeLayout, zoom: number): string {
	const normalizedZoom = normalizePublicOrgTreeZoom(zoom);
	const base = `width:${layout.width}px;height:${layout.height}px;`;
	if (normalizedZoom === 1) {
		return base;
	}
	return `${base}transform:scale(${normalizedZoom});transform-origin:top left;`;
}

function createLayoutBranch(
	agent: PublicOrgAgent,
	childrenByParent: Map<string, PublicOrgAgent[]>,
	depth: number,
): LayoutBranch {
	const children = (childrenByParent.get(agent.id) ?? []).map((child) =>
		createLayoutBranch(child, childrenByParent, depth + 1),
	);
	const childrenHeight =
		children.length === 0
			? 0
			: children.reduce((sum, child) => sum + child.subtreeHeight, 0) + TREE_GAP_Y * (children.length - 1);
	return {
		agent,
		children,
		depth,
		subtreeHeight: Math.max(TREE_CARD_HEIGHT, childrenHeight),
	};
}

function placeLayoutBranch(
	branch: LayoutBranch,
	top: number,
	nodes: PublicOrgTreeLayoutNode[],
	edges: PublicOrgTreeLayoutEdge[],
): PublicOrgTreeLayoutNode {
	const node = {
		agent: branch.agent,
		x: TREE_PADDING + branch.depth * (TREE_CARD_WIDTH + TREE_GAP_X),
		y: top + (branch.subtreeHeight - TREE_CARD_HEIGHT) / 2,
	};
	nodes.push(node);
	let childTop = top;
	for (const child of branch.children) {
		const childNode = placeLayoutBranch(child, childTop, nodes, edges);
		edges.push({
			parentId: branch.agent.id,
			childId: child.agent.id,
			from: {
				x: node.x + TREE_CARD_WIDTH,
				y: node.y + TREE_CARD_HEIGHT / 2,
			},
			to: {
				x: childNode.x,
				y: childNode.y + TREE_CARD_HEIGHT / 2,
			},
		});
		childTop += child.subtreeHeight + TREE_GAP_Y;
	}
	return node;
}

function getMaxDepth(branch: LayoutBranch): number {
	return branch.children.reduce((max, child) => Math.max(max, getMaxDepth(child)), branch.depth);
}

function formatTreeEdgePath(edge: PublicOrgTreeLayoutEdge): string {
	const midX = edge.from.x + Math.max(40, (edge.to.x - edge.from.x) / 2);
	return `M ${edge.from.x} ${edge.from.y} H ${midX} V ${edge.to.y} H ${edge.to.x}`;
}

function getTreeEdgeColor(edge: PublicOrgTreeLayoutEdge, nodes: PublicOrgTreeLayoutNode[]): string {
	const child = nodes.find((node) => node.agent.id === edge.childId)?.agent;
	return child && hasAgentError(child) ? "#f43f5e" : "#cbd5e1";
}

function getStatusClass(agent: PublicOrgAgent): string {
	if (hasAgentError(agent)) {
		return "badge badge-error badge-outline shrink-0 whitespace-nowrap";
	}
	if (agent.isRunning) {
		return "badge badge-info badge-outline shrink-0 whitespace-nowrap";
	}
	if (agent.activationStatus === "running") {
		return "badge badge-success badge-outline shrink-0 whitespace-nowrap";
	}
	if (agent.activationStatus === "loading") {
		return "badge badge-warning badge-outline shrink-0 whitespace-nowrap";
	}
	return "badge badge-neutral badge-outline shrink-0 whitespace-nowrap";
}

function formatActivationStatus(agent: PublicOrgAgent): string {
	if (hasAgentError(agent)) {
		return agent.hasProviderError ? "Provider 异常" : "异常";
	}
	if (agent.isRunning) {
		return "工作中";
	}
	switch (agent.activationStatus) {
		case "running":
			return "已就绪";
		case "loading":
			return "加载中";
		case "not_hydrated":
			return "未加载";
		case "error":
			return "异常";
	}
}

function hasAgentError(agent: PublicOrgAgent): boolean {
	return agent.hasProviderError || agent.hasError || agent.activationStatus === "error";
}

function getTreeCardClass(agent: PublicOrgAgent): string {
	if (hasAgentError(agent)) {
		return "card absolute border border-error bg-error/5 shadow-md transition-shadow hover:shadow-lg";
	}
	if (agent.isRunning) {
		return "card absolute border border-info/40 bg-base-100 shadow-md transition-shadow hover:shadow-lg";
	}
	if (agent.activationStatus === "loading") {
		return "card absolute border border-warning/40 bg-base-100 shadow-md transition-shadow hover:shadow-lg";
	}
	return "card absolute border border-base-300 bg-base-100 shadow-md transition-shadow hover:shadow-lg";
}

function getTreeModelClass(agent: PublicOrgAgent): string {
	return agent.model
		? "badge badge-primary badge-outline inline-flex max-w-full justify-start truncate whitespace-nowrap"
		: "badge badge-neutral badge-outline inline-flex max-w-full justify-start truncate whitespace-nowrap";
}

function getModelClass(agent: PublicOrgAgent): string {
	return agent.model
		? "badge badge-primary badge-outline whitespace-nowrap"
		: "badge badge-neutral badge-outline whitespace-nowrap";
}

function formatKind(kind: PublicOrgAgent["kind"]): string {
	switch (kind) {
		case "root":
			return "根智能体";
		case "child":
			return "子智能体";
		default:
			return "智能体";
	}
}

function formatLifecycle(lifecycle: PublicOrgAgent["lifecycle"]): string {
	switch (lifecycle) {
		case "persistent":
			return "持久";
		case "temporary":
			return "临时";
		default:
			return "未知";
	}
}

function formatModel(agent: PublicOrgAgent): string {
	if (!agent.model) {
		return "未配置";
	}
	const label = agent.model.label ?? agent.model.modelId;
	return `${agent.model.provider}/${label}`;
}
