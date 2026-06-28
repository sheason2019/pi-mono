import type { DPiLocalToolExecutor } from "./dispatch-tools.ts";
import type { DPiHubActionsClient } from "./hub-actions.ts";
import type { DPiRemoteExecutor } from "./remote-executor.ts";
import type { DPiToolDetails } from "./tool-surface.ts";

export interface DPiPlanItem {
	id: string;
	content: string;
	summary?: string;
	status: "pending" | "in_progress" | "completed";
}

export interface DPiBuiltinContext {
	hubClient: DPiHubActionsClient;
	agentName: string;
	localExecutors: Record<string, DPiLocalToolExecutor>;
	remoteExecutor: DPiRemoteExecutor;
	getReloadFn: () => ((reason?: string) => Promise<void>) | undefined;
	getReloadDetails: () => DPiToolDetails;
	updatePlan: (plan: DPiPlanItem[]) => void;
	getPlan: () => DPiPlanItem[];
}

let _builtinContext: DPiBuiltinContext | null = null;

export function setBuiltinContext(ctx: DPiBuiltinContext): void {
	_builtinContext = ctx;
}

export function getBuiltinContext(): DPiBuiltinContext {
	if (!_builtinContext) {
		throw new Error("Built-in context not set. Call setBuiltinContext() before using built-in tools.");
	}
	return _builtinContext;
}
