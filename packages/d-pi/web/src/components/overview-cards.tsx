import { Users, Play, CheckCircle, AlertCircle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { PublicTeamSnapshot } from "@/types";

interface OverviewCardsProps {
	snapshot: PublicTeamSnapshot;
}

export function OverviewCards({ snapshot }: OverviewCardsProps) {
	const agents = snapshot.agents;
	const total = agents.length;
	const busy = agents.filter((a) => a.status === "busy").length;
	const ready = agents.filter((a) => a.status === "ready").length;
	const error = agents.filter((a) => a.status === "error").length;

	const cards = [
		{
			title: "Total Agents",
			value: total,
			icon: Users,
			description: "Active agents in team",
			variant: "default" as const,
		},
		{
			title: "Working",
			value: busy,
			icon: Play,
			description: "Currently processing",
			variant: "default" as const,
		},
		{
			title: "Ready",
			value: ready,
			icon: CheckCircle,
			description: "Idle and available",
			variant: "default" as const,
		},
		{
			title: "Error",
			value: error,
			icon: AlertCircle,
			description: "Needs attention",
			variant: error > 0 ? ("destructive" as const) : ("default" as const),
		},
	];

	return (
		<div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
			{cards.map((card) => {
				const Icon = card.icon;
				return (
					<Card key={card.title}>
						<CardHeader className="flex flex-row items-center justify-between pb-2">
							<CardTitle className="text-sm font-medium text-muted-foreground">{card.title}</CardTitle>
							<Icon className="size-4 text-muted-foreground" />
						</CardHeader>
						<CardContent>
							<div className="text-2xl font-bold">{card.value}</div>
							<p className="text-xs text-muted-foreground">{card.description}</p>
						</CardContent>
					</Card>
				);
			})}
		</div>
	);
}
