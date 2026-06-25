import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { readLoadedAgentDefinitionFromTs } from "./agent-loader.ts";
import { isWorkspaceRoot } from "./workspace/workspace.ts";
import { readWorkspaceDefinitionFromTs } from "./workspace-definition.ts";

export type DoctorStatus = "ok" | "warn" | "error" | "info";

export interface DoctorCheck {
	name: string;
	status: DoctorStatus;
	message: string;
	details?: string[];
}

export interface DoctorReport {
	workspaceRoot: string;
	isWorkspace: boolean;
	checks: DoctorCheck[];
	summary: {
		ok: number;
		warn: number;
		error: number;
		info: number;
	};
}

const AGENTS_DIR = "agents";
const DPI_TS = "d-pi.ts";

export async function runDoctor(workspaceRoot: string): Promise<DoctorReport> {
	const root = resolve(workspaceRoot);
	const checks: DoctorCheck[] = [];

	// 1. Workspace root check
	const isWorkspace = isWorkspaceRoot(root);
	checks.push({
		name: "workspace",
		status: isWorkspace ? "ok" : "error",
		message: isWorkspace
			? `Valid d-pi workspace (${root})`
			: `Not a d-pi workspace: missing .dpi directory. Run 'd-pi init' first.`,
	});

	if (!isWorkspace) {
		return buildReport(root, false, checks);
	}

	// 2. d-pi.ts configuration
	await checkDPiTs(root, checks);

	// 3. Agents
	await checkAgents(root, checks);

	// 4. Serve readiness (structural check only, no actual start)
	checkServeReadiness(root, checks);

	return buildReport(root, true, checks);
}

function buildReport(workspaceRoot: string, isWorkspace: boolean, checks: DoctorCheck[]): DoctorReport {
	const summary = { ok: 0, warn: 0, error: 0, info: 0 };
	for (const check of checks) {
		summary[check.status]++;
	}
	return { workspaceRoot, isWorkspace, checks, summary };
}

async function checkDPiTs(root: string, checks: DoctorCheck[]): Promise<void> {
	const dpiTsPath = join(root, DPI_TS);
	if (!existsSync(dpiTsPath)) {
		checks.push({
			name: "d-pi.ts",
			status: "warn",
			message: "No d-pi.ts found at workspace root.",
			details: [
				"d-pi.ts is optional but recommended for shared model and source definitions.",
				"Create it with 'defineWorkspace({ models: {...}, sources: {...} })' to share config across agents.",
			],
		});
		return;
	}

	try {
		const definition = await readWorkspaceDefinitionFromTs(root);
		if (!definition) {
			checks.push({
				name: "d-pi.ts",
				status: "warn",
				message: "d-pi.ts exists but could not be loaded.",
			});
			return;
		}
		const modelCount = Object.keys(definition.models).length;
		const sourceCount = Object.keys(definition.sources).length;
		const details: string[] = [];
		if (modelCount > 0) {
			details.push(`Models (${modelCount}): ${Object.keys(definition.models).join(", ")}`);
		} else {
			details.push("No shared models defined (agents must define their own).");
		}
		if (sourceCount > 0) {
			details.push(`Sources (${sourceCount}): ${Object.keys(definition.sources).join(", ")}`);
		} else {
			details.push("No shared sources defined.");
		}
		checks.push({
			name: "d-pi.ts",
			status: modelCount > 0 ? "ok" : "warn",
			message:
				modelCount > 0
					? `d-pi.ts loaded successfully (${modelCount} model${modelCount === 1 ? "" : "s"}, ${sourceCount} source${sourceCount === 1 ? "" : "s"})`
					: `d-pi.ts loaded but has no shared models`,
			details,
		});
	} catch (err) {
		checks.push({
			name: "d-pi.ts",
			status: "error",
			message: `Failed to load d-pi.ts: ${err instanceof Error ? err.message : String(err)}`,
		});
	}
}

async function checkAgents(root: string, checks: DoctorCheck[]): Promise<void> {
	const agentsDir = join(root, AGENTS_DIR);
	if (!existsSync(agentsDir)) {
		checks.push({
			name: "agents",
			status: "error",
			message: `No agents directory found at ${agentsDir}`,
		});
		return;
	}

	const entries = readdirSync(agentsDir, { withFileTypes: true });
	const agentDirs = entries.filter((e) => e.isDirectory() || e.isSymbolicLink()).map((e) => e.name);

	if (agentDirs.length === 0) {
		checks.push({
			name: "agents",
			status: "error",
			message: "No agents found in agents/ directory.",
			details: ["Create at least one agent with 'd-pi init' or manually in agents/<name>/agent.ts."],
		});
		return;
	}

	const agentDetails: string[] = [];
	let hasRoot = false;
	let errorCount = 0;

	for (const agentName of agentDirs.sort()) {
		const agentDir = join(agentsDir, agentName);
		const agentTsPath = join(agentDir, "agent.ts");
		if (!existsSync(agentTsPath)) {
			agentDetails.push(`- ${agentName}: missing agent.ts`);
			errorCount++;
			continue;
		}
		try {
			const agent = await readLoadedAgentDefinitionFromTs(agentDir);
			if (!agent) {
				agentDetails.push(`- ${agentName}: agent.ts not loadable`);
				errorCount++;
				continue;
			}
			hasRoot = hasRoot || agentName === "root";
			const parts: string[] = [];
			parts.push(`tools:${agent.tools.length}`);
			parts.push(agent.model ? "model:set" : "model:unset");
			parts.push(agent.skills ? "skills:yes" : "skills:no");
			parts.push(`ctxFiles:${agent.contextFiles.length}`);
			if (agent.sources) parts.push(`sources:${Object.keys(agent.sources).length}`);
			agentDetails.push(`- ${agentName}: ${parts.join(", ")}`);
		} catch (err) {
			agentDetails.push(`- ${agentName}: error - ${err instanceof Error ? err.message : String(err)}`);
			errorCount++;
		}
	}

	let status: DoctorStatus = "ok";
	if (errorCount > 0) status = "error";
	else if (!hasRoot) status = "warn";

	checks.push({
		name: "agents",
		status,
		message:
			errorCount > 0
				? `${agentDirs.length} agent${agentDirs.length === 1 ? "" : "s"} found, ${errorCount} with errors`
				: !hasRoot
					? `${agentDirs.length} agent${agentDirs.length === 1 ? "" : "s"} found (no 'root' agent)`
					: `${agentDirs.length} agent${agentDirs.length === 1 ? "" : "s"} found`,
		details: agentDetails,
	});
}

function checkServeReadiness(root: string, checks: DoctorCheck[]): void {
	const issues: string[] = [];

	// Check that .dpi/config.json exists and is valid JSON
	const configPath = join(root, ".dpi", "config.json");
	if (!existsSync(configPath)) {
		issues.push(".dpi/config.json missing");
	} else {
		try {
			JSON.parse(readFileSync(configPath, "utf-8"));
		} catch {
			issues.push(".dpi/config.json is not valid JSON");
		}
	}

	// Check package.json exists (needed for TS imports of @sheason/d-pi)
	const pkgJsonPath = join(root, "package.json");
	if (!existsSync(pkgJsonPath)) {
		issues.push("package.json missing");
	}

	// Check node_modules/@sheason/d-pi is linked
	const dpiPkgPath = join(root, "node_modules", "@sheason", "d-pi");
	if (!existsSync(dpiPkgPath)) {
		issues.push("node_modules/@sheason/d-pi not found (run 'npm install')");
	}

	checks.push({
		name: "serve readiness",
		status: issues.length === 0 ? "ok" : "warn",
		message:
			issues.length === 0
				? "Workspace should be ready for 'd-pi serve'"
				: `${issues.length} issue${issues.length === 1 ? "" : "s"} may prevent 'd-pi serve' from starting`,
		details: issues.length > 0 ? issues : ["All structural prerequisites present."],
	});
}

export function formatReport(report: DoctorReport): string {
	const lines: string[] = [];
	lines.push(`d-pi doctor — workspace: ${report.workspaceRoot}`);
	lines.push("");

	for (const check of report.checks) {
		const icon = statusIcon(check.status);
		lines.push(`${icon} ${check.name}: ${check.message}`);
		if (check.details && check.details.length > 0) {
			for (const detail of check.details) {
				lines.push(`     ${detail}`);
			}
		}
	}

	lines.push("");
	const s = report.summary;
	lines.push(`Summary: ${s.ok} ok, ${s.warn} warn, ${s.error} error${s.error === 1 ? "" : "s"}, ${s.info} info`);

	return lines.join("\n");
}

function statusIcon(status: DoctorStatus): string {
	switch (status) {
		case "ok":
			return "[OK]";
		case "warn":
			return "[WARN]";
		case "error":
			return "[ERROR]";
		case "info":
			return "[INFO]";
	}
}
