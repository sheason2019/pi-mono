import { Type } from "@earendil-works/pi-ai";
import type { DPiRuntimeHooks } from "./runtime-hooks.ts";
import type { DPiTool, DPiToolDetails } from "./tool-surface.ts";
import { defineDPiTool, dPiToolJsonDetails, dPiToolTextResult } from "./tool-surface.ts";

export interface DPiReloadToolSnapshot {
	snapshot: DPiToolDetails;
	details?: DPiToolDetails;
}

export interface CreateDPiReloadToolOptions {
	runtimeHooks?: Pick<DPiRuntimeHooks, "reloadContext">;
	getSnapshot: () => DPiReloadToolSnapshot | Promise<DPiReloadToolSnapshot>;
}

export function createDPiReloadTool(options: CreateDPiReloadToolOptions): DPiTool {
	return defineDPiTool({
		name: "reload",
		label: "Reload Resources",
		description:
			"Reload d-pi resources at runtime without restarting the hub or worker. Returns a JSON snapshot of the post-reload state so the caller can verify what changed. This does NOT re-parse agent.ts for hub wiring changes, does NOT re-read team-template role directories, and those wiring changes still require a hub restart.",
		parameters: Type.Object({}),
		async execute() {
			if (!options.runtimeHooks) {
				return dPiToolErrorResult("Reload not available: d-pi session is not initialized yet.");
			}
			try {
				await options.runtimeHooks.reloadContext({ reason: "tool" });
			} catch (err) {
				return dPiToolErrorResult(`Failed to reload resources: ${errorMessage(err)}`);
			}
			try {
				const snapshot = await options.getSnapshot();
				return dPiToolTextResult(
					JSON.stringify(snapshot.snapshot, null, 2),
					dPiToolJsonDetails(snapshot.details ?? snapshot.snapshot),
				);
			} catch (err) {
				return dPiToolErrorResult(`Failed to read reload snapshot: ${errorMessage(err)}`);
			}
		},
	});
}

function dPiToolErrorResult(text: string, details: DPiToolDetails = {}) {
	return {
		content: [{ type: "text" as const, text }],
		details,
		isError: true,
	};
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
