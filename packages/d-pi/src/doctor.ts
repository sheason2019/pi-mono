import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Api, Context, Model } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai";
import { DEFAULT_BUILTIN_TOOL_NAMES } from "./agent-config.ts";
import type { AgentModelDefinition, AgentModelSpec, AgentProviderDefinition } from "./agent-definition.ts";
import { discoverAgentConventionResources, readLoadedAgentDefinitionFromTs } from "./agent-loader.ts";
import { isWorkspaceRoot } from "./workspace/workspace.ts";
import {
	discoverWorkspaceContextFiles,
	discoverWorkspaceModelPaths,
	discoverWorkspaceSourcePaths,
	loadWorkspaceModelDefinition,
} from "./workspace/workspace-resources.ts";

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

export interface DoctorOptions {
	verifyModels?: boolean;
	modelVerifyTimeoutMs?: number;
	recentInputsPerAgent?: number;
	fetchImpl?: typeof fetch;
	onCheckStart?: (name: string) => void;
	onCheckComplete?: (check: DoctorCheck) => void;
}

const AGENTS_DIR = "agents";
const SKILL_MD = "SKILL.md";
const SESSION_DIR = "session";

export async function runDoctor(workspaceRoot: string, options: DoctorOptions = {}): Promise<DoctorReport> {
	const root = resolve(workspaceRoot);
	const checks: DoctorCheck[] = [];

	const { onCheckStart, onCheckComplete } = options;

	onCheckStart?.("workspace");
	const isWorkspace = isWorkspaceRoot(root);
	checks.push({
		name: "workspace",
		status: isWorkspace ? "ok" : "error",
		message: isWorkspace
			? `Valid d-pi workspace (${root})`
			: `Not a d-pi workspace: missing .dpi directory. Run 'd-pi init' first.`,
	});
	onCheckComplete?.(checks[checks.length - 1]);

	if (!isWorkspace) {
		return buildReport(root, false, checks);
	}

	onCheckStart?.("agents");
	const agentResults = await checkAgents(root, checks, options);
	onCheckComplete?.(checks[checks.length - 1]);

	onCheckStart?.("models");
	await checkModels(root, checks, agentResults, options);
	onCheckComplete?.(checks[checks.length - 1]);

	onCheckStart?.("skills");
	checkSkills(root, checks, agentResults);
	onCheckComplete?.(checks[checks.length - 1]);

	onCheckStart?.("context");
	checkWorkspaceContext(root, checks);
	onCheckComplete?.(checks[checks.length - 1]);

	onCheckStart?.("sources");
	checkWorkspaceSources(root, checks, agentResults);
	onCheckComplete?.(checks[checks.length - 1]);

	onCheckStart?.("recent inputs");
	checkRecentInputs(root, checks, agentResults, options.recentInputsPerAgent ?? 5);
	onCheckComplete?.(checks[checks.length - 1]);

	onCheckStart?.("serve readiness");
	checkServeReadiness(root, checks);
	onCheckComplete?.(checks[checks.length - 1]);

	return buildReport(root, true, checks);
}

function buildReport(workspaceRoot: string, isWorkspace: boolean, checks: DoctorCheck[]): DoctorReport {
	const summary = { ok: 0, warn: 0, error: 0, info: 0 };
	for (const check of checks) {
		summary[check.status]++;
	}
	return { workspaceRoot, isWorkspace, checks, summary };
}

// ---------- Agents ----------

interface AgentResult {
	name: string;
	agentDir: string;
	loaded: boolean;
	error?: string;
	model?: AgentModelSpec;
	hasSkills: boolean;
	skillDir?: string;
	hasToolsDir: boolean;
	hasCommandsDir: boolean;
	hasAgentsMd: boolean;
	contextFileCount: number;
	contextFileNames: string[];
	customToolCount: number;
	customCommandCount: number;
	sources: string[];
	disableDefaultTools: boolean;
	availableToolNames: string[];
}

async function checkAgents(root: string, checks: DoctorCheck[], _options: DoctorOptions): Promise<AgentResult[]> {
	const agentsDir = join(root, AGENTS_DIR);
	const results: AgentResult[] = [];

	if (!existsSync(agentsDir)) {
		checks.push({
			name: "agents",
			status: "error",
			message: `No agents directory found at ${agentsDir}`,
		});
		return results;
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
		return results;
	}

	const agentDetails: string[] = [];
	let hasRoot = false;
	let errorCount = 0;

	for (const agentName of agentDirs.sort()) {
		const agentDir = join(agentsDir, agentName);
		const agentTsPath = join(agentDir, "agent.ts");
		if (!existsSync(agentTsPath)) {
			agentDetails.push(`- ${agentName}: missing agent.ts`);
			results.push({
				name: agentName,
				agentDir,
				loaded: false,
				error: "missing agent.ts",
				hasSkills: false,
				hasToolsDir: false,
				hasCommandsDir: false,
				hasAgentsMd: false,
				contextFileCount: 0,
				contextFileNames: [],
				customToolCount: 0,
				customCommandCount: 0,
				sources: [],
				disableDefaultTools: false,
				availableToolNames: [],
			});
			errorCount++;
			continue;
		}
		try {
			const agent = await readLoadedAgentDefinitionFromTs(agentDir);
			if (!agent) {
				agentDetails.push(`- ${agentName}: agent.ts not loadable`);
				results.push({
					name: agentName,
					agentDir,
					loaded: false,
					error: "not loadable",
					hasSkills: false,
					hasToolsDir: false,
					hasCommandsDir: false,
					hasAgentsMd: false,
					contextFileCount: 0,
					contextFileNames: [],
					customToolCount: 0,
					customCommandCount: 0,
					sources: [],
					disableDefaultTools: false,
					availableToolNames: [],
				});
				errorCount++;
				continue;
			}
			hasRoot = hasRoot || agentName === "root";
			const discovered = discoverAgentConventionResources(agentDir);
			const customToolNames = agent.tools.map((t) => t.name);
			const builtinNames: string[] = [...DEFAULT_BUILTIN_TOOL_NAMES];
			const availableToolNames = agent.disableDefaultTools
				? [...customToolNames]
				: [...builtinNames, ...customToolNames.filter((n) => !builtinNames.includes(n))];
			const contextFileNames = agent.contextFiles.map((cf) => cf.path);
			const parts: string[] = [];
			parts.push(`model:${agent.model ? (typeof agent.model === "string" ? agent.model : "set") : "unset"}`);
			parts.push(`skills:${discovered.hasSkillsDir ? "yes" : "no"}`);
			parts.push(`ctx:${agent.contextFiles.length}`);
			parts.push(`tools:${availableToolNames.length}${agent.disableDefaultTools ? " (no defaults)" : ""}`);
			if (discovered.hasToolsDir) parts.push("tools/");
			if (discovered.hasCommandsDir) parts.push("cmds/");
			if (agent.sources.length > 0) parts.push(`sources:${agent.sources.length}`);
			agentDetails.push(`- ${agentName}: ${parts.join(", ")}`);
			agentDetails.push(`    tools: ${availableToolNames.join(", ")}`);
			if (contextFileNames.length > 0) {
				agentDetails.push(`    context: ${contextFileNames.join(", ")}`);
			}
			let skillDir: string | undefined;
			if (agent.skills) {
				const candidate = resolve(agentDir, agent.skills.dir);
				if (existsSync(candidate)) skillDir = candidate;
			}
			results.push({
				name: agentName,
				agentDir,
				loaded: true,
				model: agent.model,
				hasSkills: !!agent.skills,
				skillDir,
				hasToolsDir: discovered.hasToolsDir,
				hasCommandsDir: discovered.hasCommandsDir,
				hasAgentsMd: discovered.hasAgentsMd,
				contextFileCount: agent.contextFiles.length,
				contextFileNames,
				customToolCount: agent.tools.length,
				customCommandCount: agent.commands.length,
				sources: agent.sources ?? [],
				disableDefaultTools: agent.disableDefaultTools,
				availableToolNames,
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			agentDetails.push(`- ${agentName}: error - ${msg}`);
			results.push({
				name: agentName,
				agentDir,
				loaded: false,
				error: msg,
				hasSkills: false,
				hasToolsDir: false,
				hasCommandsDir: false,
				hasAgentsMd: false,
				contextFileCount: 0,
				contextFileNames: [],
				customToolCount: 0,
				customCommandCount: 0,
				sources: [],
				disableDefaultTools: false,
				availableToolNames: [],
			});
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

	return results;
}

// ---------- Models ----------

interface ModelInfo {
	key: string;
	agentName?: string;
	definition: AgentModelDefinition;
	source: "agent" | "workspace";
}

async function checkModels(
	root: string,
	checks: DoctorCheck[],
	agentResults: AgentResult[],
	options: DoctorOptions,
): Promise<void> {
	const models: ModelInfo[] = [];

	const workspaceModelPaths = discoverWorkspaceModelPaths(root);
	for (const [ref, filePath] of Object.entries(workspaceModelPaths)) {
		try {
			const def = await loadWorkspaceModelDefinition(filePath);
			models.push({
				key: ref,
				definition: { ...def, id: def.id ?? ref },
				source: "workspace",
			});
		} catch {
			// skip unloadable workspace models
		}
	}

	for (const agent of agentResults) {
		if (agent.loaded && agent.model) {
			if (typeof agent.model === "string") {
				if (!workspaceModelPaths[agent.model]) {
					models.push({
						key: agent.model,
						agentName: agent.name,
						definition: { provider: "unknown", name: agent.model } as unknown as AgentModelDefinition,
						source: "agent",
					});
				}
			} else {
				models.push({
					key: agent.model && "id" in agent.model ? agent.model.id : `${agent.name}-model`,
					agentName: agent.name,
					definition: agent.model,
					source: "agent",
				});
			}
		}
	}

	if (models.length === 0) {
		checks.push({
			name: "models",
			status: "warn",
			message: "No models configured.",
			details: [
				"Define models in workspace models/ directory or inline in each agent's agent.ts file.",
				"Agents without a model cannot process requests.",
			],
		});
		return;
	}

	const verify = options.verifyModels ?? true;
	const fetchImpl = options.fetchImpl ?? fetch;
	const timeoutMs = options.modelVerifyTimeoutMs ?? 5000;

	const details: string[] = [];
	let okCount = 0;
	let failCount = 0;
	let skipCount = 0;

	for (const model of models) {
		const provider = getProviderFromModel(model.definition);
		const label = model.agentName ? `${model.agentName}/${model.key}` : `models/${model.key}`;

		if (model.source === "workspace") {
			if (!provider) {
				details.push(`- ${label}: workspace model (reference, no verification)`);
				skipCount++;
				continue;
			}
		}

		if (!provider) {
			details.push(`- ${label}: provider not resolved (reference model)`);
			skipCount++;
			continue;
		}

		if (!verify) {
			details.push(`- ${label}: ${provider.provider} (${provider.baseUrl})`);
			okCount++;
			continue;
		}

		try {
			const result = await verifyModel(provider, model.definition, fetchImpl, timeoutMs);
			if (result.ok) {
				details.push(`- ${label}: ${provider.provider} ✓ reachable`);
				okCount++;
			} else {
				details.push(`- ${label}: ${provider.provider} ✗ ${result.error}`);
				failCount++;
			}
		} catch (err) {
			details.push(`- ${label}: ${provider.provider} ✗ ${err instanceof Error ? err.message : String(err)}`);
			failCount++;
		}
	}

	let status: DoctorStatus = "ok";
	if (failCount > 0) status = "warn";
	if (okCount === 0 && failCount === 0) status = "info";

	const wsCount = models.filter((m) => m.source === "workspace").length;
	checks.push({
		name: "models",
		status,
		message: verify
			? `${models.length} model${models.length === 1 ? "" : "s"} (${wsCount} workspace, ${okCount} reachable, ${failCount} unreachable, ${skipCount} skipped)`
			: `${models.length} model${models.length === 1 ? "" : "s"} configured (verification skipped)`,
		details,
	});
}

function getProviderFromModel(model: AgentModelDefinition): AgentProviderDefinition | undefined {
	if (!("id" in model)) return undefined;
	if (typeof model.provider === "string") return undefined;
	return model.provider;
}

async function verifyModel(
	provider: AgentProviderDefinition,
	model: AgentModelDefinition,
	_fetchImpl: typeof fetch,
	timeoutMs: number,
): Promise<{ ok: boolean; error?: string }> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);

	try {
		const piModel = toPiModel(provider, model);
		const context: Context = {
			messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
		};

		const options = {
			signal: controller.signal,
			maxTokens: 1,
			maxRetries: 0,
			timeoutMs,
			...(provider.authHeader === false
				? { headers: provider.headers ?? {} }
				: {
						apiKey: provider.apiKey,
						headers: provider.headers,
					}),
		};

		const stream = streamSimple(piModel as Model<Api>, context, options);

		for await (const _event of stream) {
			controller.abort();
			break;
		}

		return { ok: true };
	} catch (err) {
		if (err instanceof Error && err.name === "AbortError") {
			return { ok: true };
		}
		const error = err as { status?: number; message?: string; name?: string };
		if (error.name === "AbortError") {
			return { ok: true };
		}
		if (error.status === 401 || error.status === 403) {
			return { ok: false, error: `auth failed (${error.status})` };
		}
		if (error.status) {
			return { ok: false, error: `HTTP ${error.status}` };
		}
		return { ok: false, error: error.message ?? String(err) };
	} finally {
		clearTimeout(timer);
	}
}

function toPiModel(provider: AgentProviderDefinition, model: AgentModelDefinition): Model<Api> {
	const modelId = "id" in model ? model.id : "unknown";
	const modelName = ("name" in model ? model.name : undefined) ?? modelId;
	const contextWindow = ("contextWindow" in model ? model.contextWindow : undefined) ?? 128000;
	const maxTokens = ("maxTokens" in model ? model.maxTokens : undefined) ?? 4096;

	return {
		id: modelId,
		name: modelName,
		api: provider.api as Api,
		provider: provider.provider,
		baseUrl: provider.baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens,
		headers: provider.headers,
	};
}

// ---------- Skills ----------

function checkSkills(root: string, checks: DoctorCheck[], agentResults: AgentResult[]): void {
	const skillDirs: Array<{ name: string; path: string; count: number }> = [];

	const workspaceSkills = join(root, "skills");
	if (existsSync(workspaceSkills)) {
		const count = countSkillsInDir(workspaceSkills);
		skillDirs.push({ name: "workspace", path: "skills/", count });
	}

	for (const agent of agentResults) {
		if (agent.skillDir) {
			const count = countSkillsInDir(agent.skillDir);
			const relPath = agent.skillDir.slice(root.length + 1);
			skillDirs.push({ name: `agent:${agent.name}`, path: relPath, count });
		}
	}

	if (skillDirs.length === 0) {
		checks.push({
			name: "skills",
			status: "info",
			message: "No skill directories found.",
			details: ["Skills are optional. Add a SKILL.md file under a skills/ directory to create one."],
		});
		return;
	}

	const total = skillDirs.reduce((sum, d) => sum + d.count, 0);
	const details = skillDirs.map((d) => `- ${d.name} (${d.path}): ${d.count} skill${d.count === 1 ? "" : "s"}`);

	checks.push({
		name: "skills",
		status: "ok",
		message: `${skillDirs.length} skill director${skillDirs.length === 1 ? "y" : "ies"} found, ${total} total skill${total === 1 ? "" : "s"}`,
		details,
	});
}

function countSkillsInDir(dir: string): number {
	let count = 0;
	const walk = (d: string) => {
		try {
			for (const entry of readdirSync(d, { withFileTypes: true })) {
				const path = join(d, entry.name);
				if (entry.isFile() && entry.name === SKILL_MD) {
					count++;
					continue;
				}
				if (entry.isDirectory() || entry.isSymbolicLink()) {
					walk(path);
				}
			}
		} catch {
			/* ignore unreadable dirs */
		}
	};
	walk(dir);
	return count;
}

// ---------- Workspace Context ----------

function checkWorkspaceContext(root: string, checks: DoctorCheck[]): void {
	const contextFiles = discoverWorkspaceContextFiles(root);
	if (contextFiles.length === 0) {
		checks.push({
			name: "context",
			status: "info",
			message: "No workspace context files found.",
			details: ["Add .md files under context/ to inject custom context into agent system prompts."],
		});
		return;
	}
	const details = contextFiles.map((cf) => `- ${cf.key} (${cf.content.length} bytes)`);
	checks.push({
		name: "context",
		status: "ok",
		message: `${contextFiles.length} context file${contextFiles.length === 1 ? "" : "s"} found in context/`,
		details,
	});
}

// ---------- Workspace Sources ----------

function checkWorkspaceSources(root: string, checks: DoctorCheck[], agentResults: AgentResult[]): void {
	const sourcePaths = discoverWorkspaceSourcePaths(root);
	const sourceNames = Object.keys(sourcePaths);
	const subscribedSources = new Set<string>();
	for (const agent of agentResults) {
		for (const s of agent.sources) subscribedSources.add(s);
	}
	if (sourceNames.length === 0) {
		checks.push({
			name: "sources",
			status: "info",
			message: "No workspace sources found.",
			details: ["Add source definitions under sources/<name>/source.ts to create external data sources."],
		});
		return;
	}
	const details = sourceNames.map((name) => {
		const subscribed = [...agentResults.filter((a) => a.sources.includes(name)).map((a) => a.name)];
		return `- ${name}${subscribed.length > 0 ? ` (subscribed by: ${subscribed.join(", ")})` : " (no subscribers)"}`;
	});
	const missingSubscriptions = [...subscribedSources].filter((s) => !sourceNames.includes(s));
	if (missingSubscriptions.length > 0) {
		for (const name of missingSubscriptions) {
			details.push(`- ${name}: NOT FOUND (referenced by agents but no source definition exists)`);
		}
		checks.push({
			name: "sources",
			status: "warn",
			message: `${sourceNames.length} source${sourceNames.length === 1 ? "" : "s"} found, ${missingSubscriptions.length} missing`,
			details,
		});
		return;
	}
	checks.push({
		name: "sources",
		status: "ok",
		message: `${sourceNames.length} source${sourceNames.length === 1 ? "" : "s"} found in sources/`,
		details,
	});
}

// ---------- Recent inputs ----------

function checkRecentInputs(
	_root: string,
	checks: DoctorCheck[],
	agentResults: AgentResult[],
	maxPerAgent: number,
): void {
	const details: string[] = [];
	let agentsWithHistory = 0;

	for (const agent of agentResults) {
		const sessionDir = join(agent.agentDir, SESSION_DIR);
		if (!existsSync(sessionDir)) {
			details.push(`- ${agent.name}: no session history`);
			continue;
		}

		const inputs = readRecentUserInputs(sessionDir, maxPerAgent);
		if (inputs.length === 0) {
			details.push(`- ${agent.name}: no user inputs yet`);
			continue;
		}

		agentsWithHistory++;
		details.push(`- ${agent.name} (${inputs.length} recent input${inputs.length === 1 ? "" : "s"}):`);
		for (let i = 0; i < inputs.length; i++) {
			const input = inputs[i];
			const preview = input.length > 80 ? `${input.slice(0, 77)}...` : input;
			const escaped = preview.replace(/\n/g, "\\n");
			details.push(`    ${i + 1}. ${escaped}`);
		}
	}

	if (agentResults.length === 0) {
		return;
	}

	checks.push({
		name: "recent inputs",
		status: agentsWithHistory > 0 ? "info" : "warn",
		message:
			agentsWithHistory > 0
				? `${agentsWithHistory} of ${agentResults.length} agent${agentResults.length === 1 ? "" : "s"} have session history`
				: `No agent has session history yet`,
		details,
	});
}

function readRecentUserInputs(sessionDir: string, max: number): string[] {
	let sessionFiles: string[] = [];
	try {
		sessionFiles = readdirSync(sessionDir)
			.filter((f) => f.endsWith(".jsonl"))
			.map((f) => join(sessionDir, f))
			.sort((a, b) => {
				try {
					return statSync(b).mtimeMs - statSync(a).mtimeMs;
				} catch {
					return 0;
				}
			});
	} catch {
		return [];
	}

	const inputs: string[] = [];

	for (const filePath of sessionFiles) {
		if (inputs.length >= max) break;
		try {
			const lines = readFileSync(filePath, "utf-8").split("\n").filter(Boolean).reverse();
			for (const line of lines) {
				if (inputs.length >= max) break;
				try {
					const entry = JSON.parse(line) as { type?: string; message?: { role?: string; content?: unknown } };
					if (entry.type === "message" && entry.message?.role === "user") {
						const content = entry.message.content;
						let text = "";
						if (typeof content === "string") {
							text = content;
						} else if (Array.isArray(content)) {
							text = content
								.map((c) => (typeof c === "object" && c !== null && "text" in c ? String(c.text) : ""))
								.filter(Boolean)
								.join(" ");
						}
						if (text.trim()) {
							inputs.push(text.trim());
						}
					}
				} catch {
					/* skip malformed lines */
				}
			}
		} catch {
			/* skip unreadable files */
		}
	}

	return inputs;
}

// ---------- Serve readiness ----------

function checkServeReadiness(root: string, checks: DoctorCheck[]): void {
	const issues: string[] = [];

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

	const pkgJsonPath = join(root, "package.json");
	if (!existsSync(pkgJsonPath)) {
		issues.push("package.json missing");
	}

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

// ---------- Formatting ----------

const COLORS = {
	reset: "\x1b[0m",
	bold: "\x1b[1m",
	dim: "\x1b[2m",
	green: "\x1b[32m",
	yellow: "\x1b[33m",
	red: "\x1b[31m",
	cyan: "\x1b[36m",
	white: "\x1b[37m",
	gray: "\x1b[90m",
} as const;

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function colorStatus(status: DoctorStatus, text: string, useColor: boolean): string {
	if (!useColor) return text;
	switch (status) {
		case "ok":
			return `${COLORS.green}${text}${COLORS.reset}`;
		case "warn":
			return `${COLORS.yellow}${text}${COLORS.reset}`;
		case "error":
			return `${COLORS.red}${text}${COLORS.reset}`;
		case "info":
			return `${COLORS.cyan}${text}${COLORS.reset}`;
	}
}

function statusLabel(status: DoctorStatus): string {
	switch (status) {
		case "ok":
			return "OK";
		case "warn":
			return "WARN";
		case "error":
			return "ERROR";
		case "info":
			return "INFO";
	}
}

function statusIcon(status: DoctorStatus, useColor: boolean): string {
	const label = statusLabel(status);
	const tag = `[${label}]`;
	return colorStatus(status, tag, useColor);
}

export function formatCheckLine(check: DoctorCheck, useColor = true): string {
	const icon = statusIcon(check.status, useColor);
	const name = useColor ? `${COLORS.bold}${check.name}${COLORS.reset}` : check.name;
	return `${icon} ${name}: ${check.message}`;
}

export function formatDetails(check: DoctorCheck, indent = "     "): string[] {
	if (!check.details || check.details.length === 0) return [];
	return check.details.map((d) => `${indent}${d}`);
}

export function formatReport(report: DoctorReport, useColor = false): string {
	const lines: string[] = [];
	const title = useColor
		? `${COLORS.bold}d-pi doctor${COLORS.reset} — workspace: ${report.workspaceRoot}`
		: `d-pi doctor — workspace: ${report.workspaceRoot}`;
	lines.push(title);
	lines.push("");

	for (const check of report.checks) {
		lines.push(formatCheckLine(check, useColor));
		lines.push(...formatDetails(check));
	}

	lines.push("");
	const s = report.summary;
	const summaryLine = `Summary: ${s.ok} ok, ${s.warn} warn, ${s.error} error${s.error === 1 ? "" : "s"}, ${s.info} info`;
	lines.push(useColor ? `${COLORS.bold}${summaryLine}${COLORS.reset}` : summaryLine);

	return lines.join("\n");
}

export interface DoctorStreamRenderer {
	onStart(name: string): void;
	onComplete(check: DoctorCheck): void;
	onFinish(report: DoctorReport): void;
	stop(): void;
}

export function createStreamRenderer(opts: {
	write: (text: string) => void;
	isTTY: boolean;
	useColor: boolean;
}): DoctorStreamRenderer {
	let currentName: string | null = null;
	let spinnerIndex = 0;
	let spinnerTimer: ReturnType<typeof setInterval> | null = null;
	let finished = false;

	function clearLine(): void {
		if (opts.isTTY) {
			opts.write("\r\x1b[2K");
		}
	}

	function renderLoading(): void {
		if (!currentName || finished) return;
		const frame = SPINNER_FRAMES[spinnerIndex];
		const prefix = opts.useColor ? `${COLORS.dim}${frame}${COLORS.reset}` : frame;
		const name = opts.useColor ? `${COLORS.bold}${currentName}${COLORS.reset}` : currentName;
		const msg = opts.useColor ? `${COLORS.dim}checking...${COLORS.reset}` : "checking...";
		const line = `${prefix} ${name}: ${msg}`;
		if (opts.isTTY) {
			opts.write(`\r\x1b[2K${line}`);
		}
		spinnerIndex = (spinnerIndex + 1) % SPINNER_FRAMES.length;
	}

	function startSpinner(): void {
		if (!opts.isTTY) {
			const frame = SPINNER_FRAMES[0];
			const prefix = opts.useColor ? `${COLORS.dim}${frame}${COLORS.reset}` : frame;
			const name = opts.useColor ? `${COLORS.bold}${currentName}${COLORS.reset}` : currentName;
			const msg = opts.useColor ? `${COLORS.dim}checking...${COLORS.reset}` : "checking...";
			opts.write(`${prefix} ${name}: ${msg}\n`);
			return;
		}
		renderLoading();
		spinnerTimer = setInterval(renderLoading, 80);
	}

	function stopSpinner(): void {
		if (spinnerTimer) {
			clearInterval(spinnerTimer);
			spinnerTimer = null;
		}
	}

	return {
		onStart(name: string) {
			currentName = name;
			spinnerIndex = 0;
			startSpinner();
		},
		onComplete(check: DoctorCheck) {
			stopSpinner();
			if (opts.isTTY) {
				clearLine();
			}
			opts.write(`${formatCheckLine(check, opts.useColor)}\n`);
			for (const detail of formatDetails(check)) {
				opts.write(`${detail}\n`);
			}
			currentName = null;
		},
		onFinish(report: DoctorReport) {
			finished = true;
			stopSpinner();
			const s = report.summary;
			const summaryLine = `\nSummary: ${s.ok} ok, ${s.warn} warn, ${s.error} error${s.error === 1 ? "" : "s"}, ${s.info} info`;
			opts.write(opts.useColor ? `${COLORS.bold}${summaryLine}${COLORS.reset}\n` : `${summaryLine}\n`);
		},
		stop() {
			finished = true;
			stopSpinner();
		},
	};
}
