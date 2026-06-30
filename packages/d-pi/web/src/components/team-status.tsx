import { useEffect, useMemo } from "react";
import ReactFlow, {
	Background,
	Controls,
	MiniMap,
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
import { Badge } from "@/components/ui/badge";
import type { PublicTeamAgentEntry, PublicTeamSnapshot } from "@/types";
import { cn } from "@/lib/utils";

const STATUS_VARIANTS: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
	starting: "secondary",
	ready: "default",
	busy: "default",
	error: "destructive",
	destroyed: "outline",
};

function AgentNode({ data }: NodeProps<{ agent: PublicTeamAgentEntry }>) {
	const { agent } = data;
	const variant = STATUS_VARIANTS[agent.status] ?? "outline";

	return (
		<div className="rounded-lg border bg-card p-3 text-card-foreground shadow-sm w-[160px]">
			<Handle type="target" position={Position.Top} className="!size-2 !bg-muted-foreground" />
			<div className="flex items-center gap-2">
				<div
					className={cn(
						"size-2 rounded-full shrink-0",
						agent.status === "ready" && "bg-emerald-500",
						agent.status === "busy" && "bg-blue-500",
						agent.status === "starting" && "bg-amber-500",
						agent.status === "error" && "bg-red-500",
						agent.status === "destroyed" && "bg-gray-400",
					)}
				/>
				<span className="text-sm font-medium truncate">{agent.name}</span>
			</div>
			<div className="mt-2">
				<Badge variant={variant} className="text-[10px] h-5">
					{agent.status}
				</Badge>
			</div>
			<Handle type="source" position={Position.Bottom} className="!size-2 !bg-muted-foreground" />
		</div>
	);
}

const nodeTypes = { agent: AgentNode };

function buildTree(agents: PublicTeamAgentEntry[]) {
	const agentMap = new Map(agents.map((a) => [a.name, a]));
	const roots = agents.filter((a) => !a.parentName);
	return { agentMap, roots };
}

function layoutTree(
	agentMap: Map<string, PublicTeamAgentEntry>,
	nodeName: string,
	startX: number,
	y: number,
	xSpacing: number,
	ySpacing: number,
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

	let currentX = startX;
	const allNodes: Node[] = [];
	const allEdges: Edge[] = [];
	let totalWidth = 0;

	children.forEach((childName, i) => {
		const { nodes, edges, width } = layoutTree(
			agentMap,
			childName,
			currentX,
			y + ySpacing,
			xSpacing,
			ySpacing,
		);
		allNodes.push(...nodes);
		allEdges.push(...edges);
		allEdges.push({
			id: `${nodeName}-${childName}`,
			source: nodeName,
			target: childName,
			animated: agent.status === "busy",
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
		return layoutTree(agentMap, rootName, 50, 50, 220, 120);
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

	return (
		<Card>
			<CardHeader>
				<CardTitle>Team Status</CardTitle>
				<CardDescription>Real-time view of agent hierarchy and status</CardDescription>
			</CardHeader>
			<CardContent>
				<div className="h-[500px] w-full rounded-md border bg-muted/20">
					<ReactFlow
						nodes={nodes}
						edges={edges}
						onNodesChange={onNodesChange}
						onEdgesChange={onEdgesChange}
						nodeTypes={nodeTypes}
						fitView
						fitViewOptions={{ padding: 0.2 }}
						proOptions={{ hideAttribution: true }}
					>
						<Background gap={16} />
						<Controls />
						<MiniMap pannable zoomable />
					</ReactFlow>
				</div>
			</CardContent>
		</Card>
	);
}
