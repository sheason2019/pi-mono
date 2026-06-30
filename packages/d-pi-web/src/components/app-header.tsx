import { Cpu } from "lucide-react";
import { Badge } from "@/components/ui/badge";

interface AppHeaderProps {
	connected: boolean;
}

export function AppHeader({ connected }: AppHeaderProps) {
	return (
		<header className="sticky top-0 z-50 w-full border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
			<div className="mx-auto flex h-14 w-full max-w-7xl items-center px-4 sm:px-6 lg:px-8">
				<div className="flex items-center gap-3">
					<div className="flex size-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
						<Cpu className="size-5" />
					</div>
					<div className="flex flex-col">
						<span className="text-sm font-semibold leading-none">D-Pi</span>
						<span className="text-xs text-muted-foreground">Agent Orchestration</span>
					</div>
				</div>
				<div className="ml-auto flex items-center gap-4">
					<Badge variant={connected ? "default" : "secondary"} className="gap-1.5">
						<span
							className={`size-1.5 rounded-full ${connected ? "bg-primary-foreground" : "bg-muted-foreground"}`}
						/>
						{connected ? "Connected" : "Disconnected"}
					</Badge>
				</div>
			</div>
		</header>
	);
}
