import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	AGENT_SESSION_DIR,
	AGENT_TS_FILE,
	buildAgentTsSource as buildAgentTsSourceFromConfig,
	resolveMigratedToolNames,
} from "../agent-config.ts";
import type { AgentConfig } from "../types.ts";

const AGENTS_DIR = "agents";
const AGENT_CONFIG_FILE = "agent.json";
const LEGACY_SESSIONS_DIR = ".dpi-sessions";

interface LegacyAgentConfig extends Omit<AgentConfig, "parentName"> {
	parentName?: string | null;
	includeTools?: string[];
	excludeTools?: string[];
}

interface AgentTsMigrationPlan {
	agentJsonPath: string;
	agentTsPath: string;
	legacySessionDir: string;
	sessionDir: string;
	agentTsSource: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function readLegacyAgentConfig(agentJsonPath: string): LegacyAgentConfig {
	const parsed = JSON.parse(readFileSync(agentJsonPath, "utf-8")) as unknown;
	if (!isRecord(parsed)) {
		throw new TypeError(`Invalid agent config at ${agentJsonPath}: expected object`);
	}
	if (typeof parsed.name !== "string" || parsed.name.length === 0) {
		throw new TypeError(`Invalid agent config at ${agentJsonPath}: name must be a non-empty string`);
	}
	if (parsed.parentName !== undefined && parsed.parentName !== null && typeof parsed.parentName !== "string") {
		throw new TypeError(`Invalid agent config at ${agentJsonPath}: parentName must be a string or null`);
	}
	if (parsed.description !== undefined && typeof parsed.description !== "string") {
		throw new TypeError(`Invalid agent config at ${agentJsonPath}: description must be a string`);
	}
	if (
		parsed.roles !== undefined &&
		(!Array.isArray(parsed.roles) || parsed.roles.some((role) => typeof role !== "string"))
	) {
		throw new TypeError(`Invalid agent config at ${agentJsonPath}: roles must be an array of strings`);
	}
	if (
		parsed.includeTools !== undefined &&
		(!Array.isArray(parsed.includeTools) || parsed.includeTools.some((tool) => typeof tool !== "string"))
	) {
		throw new TypeError(`Invalid agent config at ${agentJsonPath}: includeTools must be an array of strings`);
	}
	if (
		parsed.excludeTools !== undefined &&
		(!Array.isArray(parsed.excludeTools) || parsed.excludeTools.some((tool) => typeof tool !== "string"))
	) {
		throw new TypeError(`Invalid agent config at ${agentJsonPath}: excludeTools must be an array of strings`);
	}

	return {
		name: parsed.name,
		parentName: parsed.parentName as string | null | undefined,
		description: parsed.description as string | undefined,
		roles: parsed.roles as string[] | undefined,
		includeTools: parsed.includeTools as string[] | undefined,
		excludeTools: parsed.excludeTools as string[] | undefined,
	};
}

function buildMigratedAgentTsSource(config: LegacyAgentConfig): string {
	return buildAgentTsSourceFromConfig({
		name: config.name,
		parentName: config.parentName ?? undefined,
		description: config.description,
		roles: config.roles,
		toolNames: resolveMigratedToolNames({
			name: config.name,
			includeTools: config.includeTools,
			excludeTools: config.excludeTools,
		}),
	});
}

function moveLegacySessionDir(sourceDir: string, targetDir: string): void {
	if (!existsSync(sourceDir)) {
		return;
	}
	mkdirSync(targetDir, { recursive: true });
	for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
		const sourcePath = join(sourceDir, entry.name);
		const targetPath = join(targetDir, entry.name);
		if (existsSync(targetPath)) {
			throw new Error(`Cannot migrate session file: target already exists at ${targetPath}`);
		}
		renameSync(sourcePath, targetPath);
	}
	rmSync(sourceDir, { recursive: true, force: true });
}

function removeLegacySessionsRootIfEmpty(workspaceRoot: string): void {
	const legacySessionsRoot = join(workspaceRoot, LEGACY_SESSIONS_DIR);
	if (!existsSync(legacySessionsRoot)) {
		return;
	}
	const stats = statSync(legacySessionsRoot);
	if (!stats.isDirectory()) {
		return;
	}
	if (readdirSync(legacySessionsRoot).length === 0) {
		rmSync(legacySessionsRoot, { recursive: true, force: true });
	}
}

function buildMigrationPlans(workspaceRoot: string): AgentTsMigrationPlan[] {
	const agentsRoot = join(workspaceRoot, AGENTS_DIR);
	if (!existsSync(agentsRoot)) {
		return [];
	}

	const plans: AgentTsMigrationPlan[] = [];
	for (const entry of readdirSync(agentsRoot, { withFileTypes: true })) {
		if (!entry.isDirectory()) {
			continue;
		}
		const agentDir = join(agentsRoot, entry.name);
		const agentJsonPath = join(agentDir, AGENT_CONFIG_FILE);
		if (!existsSync(agentJsonPath)) {
			continue;
		}
		const config = readLegacyAgentConfig(agentJsonPath);
		plans.push({
			agentJsonPath,
			agentTsPath: join(agentDir, AGENT_TS_FILE),
			legacySessionDir: join(workspaceRoot, LEGACY_SESSIONS_DIR, entry.name),
			sessionDir: join(agentDir, AGENT_SESSION_DIR),
			agentTsSource: buildMigratedAgentTsSource(config),
		});
	}
	return plans;
}

export function migrateWorkspaceToAgentTs(workspaceRoot: string): void {
	const plans = buildMigrationPlans(workspaceRoot);
	for (const plan of plans) {
		writeFileSync(plan.agentTsPath, plan.agentTsSource);
	}
	for (const plan of plans) {
		moveLegacySessionDir(plan.legacySessionDir, plan.sessionDir);
	}
	for (const plan of plans) {
		rmSync(plan.agentJsonPath, { force: true });
	}
	removeLegacySessionsRootIfEmpty(workspaceRoot);
}
