import { useCallback, useEffect, useMemo } from "react";
import ReactFlow, {
	Background,
	Controls,
	ControlButton,
	useNodesState,
	useEdgesState,
	type Node,
	type Edge,
	type NodeProps,
	Handle,
	Position,
} from "reactflow";
import "reactflow/dist/style.css";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Cpu, RotateCcw, CheckCircle2, Circle, CircleDot } from "lucide-react";
import type { AgentPlanItem, PublicTeamAgentEntry, PublicTeamSnapshot } from "@/types";
import { cn } from "@/lib/utils";

const STATUS_COLORS: Record<string, { dot: string; text: string; bg: string }> = {
	starting: { dot: "bg-amber-500", text: "text-amber-700 dark:text-amber-400", bg: "bg-amber-50 dark:bg-amber-950/30" },
	ready: { dot: "bg-emerald-500", text: "text-emerald-700 dark:text-emerald-400", bg: "bg-emerald-50 dark:bg-emerald-950/30" },
	busy: { dot: "bg-blue-500", text: "text-blue-700 dark:text-blue-400", bg: "bg-blue-50 dark:bg-blue-950/30" },
	error: { dot: "bg-red-500", text: "text-red-700 dark:text-red-400", bg: "bg-red-50 dark:bg-red-950/30" },
	destroyed: { dot: "bg-gray-400", text: "text-gray-600 dark:text-gray-400", bg: "bg-gray-50 dark:bg-gray-900/30" },
};

function PlanItemIcon({ status }: { status: AgentPlanItem["status"] }) {
	if (status === "completed") {
		return <CheckCircle2 className="size-3.5 text-emerald-500 shrink-0" />;
	}
	if (status === "in_progress") {
		return <CircleDot className="size-3.5 text-amber-500 shrink-0" />;
	}
	return <Circle className="size-3.5 text-muted-foreground/60 shrink-0" />;
}

function AgentNode({ data }: NodeProps<{ agent: PublicTeamAgentEntry }>) {
	const { agent } = data;
	const status = STATUS_COLORS[agent.status] ?? STATUS_COLORS.destroyed;
	const plan = agent.plan ?? [];
	const planCount = plan.length;

	return (
		<div className="w-[220px] rounded-lg border bg-card text-card-foreground shadow-sm overflow-hidden">
			<Handle type="target" position={Position.Top} className="!size-2 !bg-muted-foreground" />
			<div className="p-3">
				<div className="flex items-center gap-2.5">
					<div className={cn("flex size-8 items-center justify-center rounded-md", status.bg)}>
						<Cpu className={cn("size-4", status.text)} />
					</div>
					<div className="flex flex-col min-w-0 flex-1">
						<span className="text-sm font-medium truncate">{agent.name}</span>
						<div className="flex items-center gap-1.5">
							<span className={cn("size-1.5 rounded-full", status.dot)} />
							<span className={cn("text-xs capitalize", status.text)}>{agent.status}</span>
						</div>
					</div>
				</div>
				{planCount > 0 && (
					<div className="mt-2.5 pt-2 border-t border-border/50">
						<div className="space-y-1">
							{plan.slice(0, 5).map((item) => (
								<div key={item.id} className="flex items-start gap-1.5">
									<div className="mt-0.5">
										<PlanItemIcon status={item.status} />
									</div>
									<span
										className={cn(
											"text-xs truncate flex-1",
											item.status === "completed" &&
												"line-through text-muted-foreground/70",
											item.status === "in_progress" && "text-foreground font-medium",
											item.status === "pending" && "text-muted-foreground",
										)}
									>
										{item.title}
									</span>
								</div>
							))}
							{planCount > 5 && (
								<span className="text-xs text-muted-foreground">...and {planCount - 5} more</span>
							)}
						</div>
					</div>
				)}
			</div>
			<Handle type="source" position={Position.Bottom} className="!size-2 !bg-muted-foreground" />
		</div>
	);
}

const nodeTypes = { agent: AgentNode };

function ResetControl({ onReset }: { onReset: () => void }) {
	return (
		<ControlButton onClick={onReset} title="Reset layout">
			<RotateCcw className="size-4" />
		</ControlButton>
	);
}

function buildTree(agents: PublicTeamAgentEntry[]) {
	const agentMap = new Map(agents.map((a) => [a.name, a]));
	const roots = agents.filter((a) => !a.parentName);
	return { agentMap, roots };
}

// Estimate the rendered height of an agent node so the tree layout can
// offset children by the parent's actual height instead of a fixed gap.
// A node with a plan section is far taller than one without, and the old
// fixed ySpacing made children overlap a plan-bearing parent — the
// parent's bottom items looked clipped by the child's top edge.
function estimateNodeHeight(agent: PublicTeamAgentEntry): number {
	const base = 64; // p-3 padding + header row (size-8 icon) + border
	const plan = agent.plan ?? [];
	if (plan.length === 0) return base;
	const visibleItems = Math.min(plan.length, 5);
	const moreRow = plan.length > 5 ? 20 : 0;
	// plan section: top margin + padding + header row + gap + item rows
	return base + 44 + visibleItems * 24 + moreRow;
}

function layoutTree(
	agentMap: Map<string, PublicTeamAgentEntry>,
	nodeName: string,
	startX: number,
	y: number,
	xSpacing: number,
	verticalGap: number,
): { nodes: Node[]; edges: Edge[]; width: number } {
	const agent = agentMap.get(nodeName);
	if (!agent) return { nodes: [], edges: [], width: 0 };

	const children = agent.children || [];

	if (children.length === 0) {
		const node: Node = {
			id: nodeName,
			type: "agent",
			position: { x: startX, y },
			data: { agent },
		};
		return { nodes: [node], edges: [], width: xSpacing };
	}

	const childY = y + estimateNodeHeight(agent) + verticalGap;
	let currentX = startX;
	const allNodes: Node[] = [];
	const allEdges: Edge[] = [];
	let totalWidth = 0;

	children.forEach((childName, i) => {
		const { nodes, edges, width } = layoutTree(
			agentMap,
			childName,
			currentX,
			childY,
			xSpacing,
			verticalGap,
		);
		allNodes.push(...nodes);
		allEdges.push(...edges);
		allEdges.push({
			id: `${nodeName}-${childName}`,
			source: nodeName,
			target: childName,
		});
		currentX += width;
		totalWidth += width;
		if (i < children.length - 1) {
			totalWidth += xSpacing / 2;
			currentX += xSpacing / 2;
		}
	});

	const rootX = startX + totalWidth / 2 - xSpacing / 2;
	const rootNode: Node = {
		id: nodeName,
		type: "agent",
		position: { x: rootX, y },
		data: { agent },
	};

	return { nodes: [rootNode, ...allNodes], edges: allEdges, width: totalWidth };
}

interface TeamStatusProps {
	snapshot: PublicTeamSnapshot;
}

export function TeamStatus({ snapshot }: TeamStatusProps) {
	const [nodes, setNodes, onNodesChange] = useNodesState([]);
	const [edges, setEdges, onEdgesChange] = useEdgesState([]);

	const layout = useMemo(() => {
		if (!snapshot?.agents?.length) return null;
		const { agentMap, roots } = buildTree(snapshot.agents);
		const rootName = roots[0]?.name || snapshot.rootName;
		if (!rootName) return null;
		return layoutTree(agentMap, rootName, 50, 50, 240, 40);
	}, [snapshot]);

	useEffect(() => {
		if (!layout) return;

		setNodes((prevNodes) => {
			const prevPositions = new Map(prevNodes.map((n) => [n.id, n.position]));
			return layout.nodes.map((node) => {
				const prevPos = prevPositions.get(node.id);
				if (prevPos) {
					return { ...node, position: prevPos };
				}
				return node;
			});
		});
		setEdges(layout.edges);
	}, [layout, setNodes, setEdges]);

	const handleReset = useCallback(() => {
		if (!layout) return;
		setNodes(layout.nodes.map((n) => ({ ...n })));
	}, [layout, setNodes]);

	return (
		<Card>
			<CardHeader>
				<CardTitle>Team Status</CardTitle>
				<CardDescription>Real-time view of agent hierarchy and status</CardDescription>
			</CardHeader>
			<CardContent>
				<div className="relative h-[500px] w-full rounded-md border bg-muted/20">
					<ReactFlow
						nodes={nodes}
						edges={edges}
						onNodesChange={onNodesChange}
						onEdgesChange={onEdgesChange}
						nodeTypes={nodeTypes}
						fitView
						fitViewOptions={{ padding: 0.2 }}
						proOptions={{ hideAttribution: true }}
						nodesConnectable={false}
					>
						<Background gap={16} />
						<Controls showInteractive={false}>
							<ResetControl onReset={handleReset} />
						</Controls>
					</ReactFlow>
				</div>
			</CardContent>
		</Card>
	);
}
