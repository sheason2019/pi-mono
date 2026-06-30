import { useCallback, useEffect, useState } from "react";
import { AppHeader } from "@/components/app-header";
import { OverviewCards } from "@/components/overview-cards";
import { TeamStatus } from "@/components/team-status";
import type { PublicTeamSnapshot } from "@/types";

function useTeamSnapshot(pollIntervalMs = 2000) {
	const [snapshot, setSnapshot] = useState<PublicTeamSnapshot | null>(null);
	const [error, setError] = useState<string | null>(null);

	const fetchSnapshot = useCallback(async () => {
		try {
			const res = await fetch("/api/team/public");
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = (await res.json()) as PublicTeamSnapshot;
			setSnapshot(data);
			setError(null);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to fetch");
		}
	}, []);

	useEffect(() => {
		fetchSnapshot();
		const timer = setInterval(fetchSnapshot, pollIntervalMs);
		return () => clearInterval(timer);
	}, [fetchSnapshot, pollIntervalMs]);

	return { snapshot, error, refetch: fetchSnapshot };
}

export default function App() {
	const { snapshot, error } = useTeamSnapshot(2000);
	const connected = !!snapshot && !error;

	return (
		<div className="flex min-h-screen flex-col bg-background">
			<AppHeader connected={connected} />
			<main className="flex-1">
				<div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
					<div className="flex flex-col gap-6">
						<section>
							<h2 className="text-lg font-semibold mb-4">Overview</h2>
							{snapshot && <OverviewCards snapshot={snapshot} />}
						</section>
						<section>
							<h2 className="text-lg font-semibold mb-4">Team Status</h2>
							{snapshot && <TeamStatus snapshot={snapshot} />}
						</section>
						{error && (
							<div className="rounded-md border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">
								Connection error: {error}
							</div>
						)}
						{!snapshot && !error && (
							<div className="rounded-md border bg-muted/30 p-8 text-center text-sm text-muted-foreground">
								Loading...
							</div>
						)}
					</div>
				</div>
			</main>
		</div>
	);
}
