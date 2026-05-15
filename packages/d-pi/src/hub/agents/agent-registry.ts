import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { getAgentsConfigPath, getLocalPiDir, getSessionFile } from "../config.js";
import { getChildAgentSessionFile } from "./child-agent-layout.js";
import {
	type AgentExecutorConfig,
	type AgentKind,
	type AgentRecord,
	type AgentRegistryFile,
	type CreateChildAgentRecordInput,
	type CreateGuestAgentRecordInput,
	type HubExecutorPolicy,
	ROOT_AGENT_ID,
} from "./types.js";

function cloneRecord(record: AgentRecord): AgentRecord {
	return structuredClone(record);
}

function assertNonEmptySessionFile(sessionFile: string, context: string): string {
	const trimmed = sessionFile.trim();
	if (trimmed.length === 0) {
		throw new Error(`${context}: sessionFile must be non-empty`);
	}
	return trimmed;
}

function assertNonEmptyString(value: unknown, context: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`${context} must be a non-empty string`);
	}
	return value.trim();
}

function normalizeHubExecutor(value: unknown): HubExecutorPolicy {
	return value === "disabled" ? "disabled" : "enabled";
}

function normalizeStringRecord(value: unknown, context: string): Record<string, string> | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${context} must be an object`);
	}
	const out: Record<string, string> = {};
	for (const [key, raw] of Object.entries(value)) {
		if (typeof raw !== "string") {
			throw new Error(`${context}.${key} must be a string`);
		}
		out[key] = raw;
	}
	return out;
}

function normalizeExecutors(value: unknown, context: string): AgentExecutorConfig[] | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (!Array.isArray(value)) {
		throw new Error(`${context}: executors must be an array`);
	}
	const ids = new Set<string>();
	const peerIds = new Set<string>();
	const executors: AgentExecutorConfig[] = [];
	for (const [index, raw] of value.entries()) {
		if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
			throw new Error(`${context}: executor entry ${index} must be an object`);
		}
		const rec = raw as Record<string, unknown>;
		if (rec.type !== "node-container") {
			throw new Error(`${context}: executor ${index} has unsupported type`);
		}
		const id = assertNonEmptyString(rec.id, `${context}: executor id`);
		const peerId = assertNonEmptyString(rec.peerId, `${context}: executor peerId`);
		if (ids.has(id)) {
			throw new Error(`Duplicate executor id: ${id}`);
		}
		if (peerIds.has(peerId)) {
			throw new Error(`Duplicate executor peerId: ${peerId}`);
		}
		ids.add(id);
		peerIds.add(peerId);
		if (
			!Array.isArray(rec.command) ||
			rec.command.length === 0 ||
			rec.command.some((part) => typeof part !== "string")
		) {
			throw new Error(`${context}: executor ${id} command must be a non-empty string array`);
		}
		const token = assertNonEmptyString(rec.token, `${context}: executor ${id} token`);
		const executor: AgentExecutorConfig = {
			id,
			type: "node-container",
			peerId,
			image: typeof rec.image === "string" && rec.image.trim() ? rec.image.trim() : "node:22",
			command: [...rec.command],
			token,
		};
		const env = normalizeStringRecord(rec.env, `${context}: executor ${id} env`);
		if (env !== undefined) executor.env = env;
		if (typeof rec.workdir === "string" && rec.workdir.trim()) executor.workdir = rec.workdir.trim();
		if (typeof rec.containerName === "string" && rec.containerName.trim()) {
			executor.containerName = rec.containerName.trim();
		}
		executors.push(executor);
	}
	return executors;
}

function sanitizeIdBase(raw: string): string {
	let s = raw
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.replace(/-+/g, "-");
	if (s.length === 0) {
		s = "child";
	}
	return s;
}

function isIdTaken(ids: ReadonlySet<string>, id: string): boolean {
	return ids.has(id);
}

function allocateChildId(
	existingIds: ReadonlySet<string>,
	input: CreateChildAgentRecordInput | CreateGuestAgentRecordInput,
): string {
	if (input.id !== undefined && input.id.trim() !== "") {
		const sanitized = sanitizeIdBase(input.id);
		if (sanitized === ROOT_AGENT_ID) {
			throw new Error(`Invalid child id: "${input.id}" resolves to reserved id "${ROOT_AGENT_ID}"`);
		}
		if (isIdTaken(existingIds, sanitized)) {
			throw new Error(`Duplicate agent id: ${sanitized}`);
		}
		return sanitized;
	}

	if (input.name !== undefined && input.name.trim() !== "") {
		const base = sanitizeIdBase(input.name);
		return nextAvailableId(existingIds, base);
	}

	let n = 1;
	while (isIdTaken(existingIds, `child-${n}`)) {
		n += 1;
	}
	return `child-${n}`;
}

function nextAvailableId(existingIds: ReadonlySet<string>, base: string): string {
	if (!isIdTaken(existingIds, base)) {
		return base;
	}
	let n = 2;
	while (isIdTaken(existingIds, `${base}-${n}`)) {
		n += 1;
	}
	return `${base}-${n}`;
}

function parseRegistryJson(raw: string, contextPath: string): AgentRegistryFile {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw) as unknown;
	} catch (e) {
		const err = e instanceof Error ? e : new Error(String(e));
		throw new Error(`Invalid JSON in ${contextPath}: ${err.message}`);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(`Invalid agents registry shape in ${contextPath}`);
	}
	const obj = parsed as { version?: unknown; agents?: unknown };
	if (obj.version !== 1 && obj.version !== 2) {
		throw new Error(`Unsupported agents registry version in ${contextPath}`);
	}
	if (!Array.isArray(obj.agents)) {
		throw new Error(`Invalid agents registry: "agents" must be an array (${contextPath})`);
	}

	const agents: AgentRecord[] = [];
	const seenIds = new Set<string>();

	for (const entry of obj.agents) {
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
			throw new Error(`Invalid agent entry in ${contextPath}`);
		}
		const rec = entry as Record<string, unknown>;
		if (typeof rec.id !== "string" || rec.id.length === 0) {
			throw new Error(`Invalid agent id in ${contextPath}`);
		}
		const legacyMain = obj.version === 1 && rec.kind === "main";
		if (!legacyMain && rec.kind !== "root" && rec.kind !== "child" && rec.kind !== "guest") {
			throw new Error(`Invalid agent kind for "${rec.id}" in ${contextPath}`);
		}
		const kind = legacyMain ? "root" : (rec.kind as AgentKind);
		const id = rec.id === "main" && legacyMain ? ROOT_AGENT_ID : rec.id;
		if (typeof rec.sessionFile !== "string") {
			throw new Error(`Invalid sessionFile for "${id}" in ${contextPath}`);
		}
		assertNonEmptySessionFile(rec.sessionFile, `Agent "${id}"`);
		if (typeof rec.createdAt !== "string" || rec.createdAt.length === 0) {
			throw new Error(`Invalid createdAt for "${id}" in ${contextPath}`);
		}

		if (seenIds.has(id)) {
			throw new Error(`Duplicate agent id in registry: ${id}`);
		}
		seenIds.add(id);

		const record: AgentRecord = {
			id,
			kind,
			sessionFile: rec.sessionFile.trim(),
			createdAt: rec.createdAt,
			lifecycle: rec.lifecycle === "temporary" ? "temporary" : "persistent",
			hubExecutor: normalizeHubExecutor(rec.hubExecutor),
		};
		const parentId =
			typeof rec.parentId === "string" ? (rec.parentId === "main" ? ROOT_AGENT_ID : rec.parentId) : undefined;
		if (kind === "child" || kind === "guest") {
			record.parentId = parentId ?? ROOT_AGENT_ID;
		}
		if (typeof rec.name === "string") record.name = rec.name;
		if (typeof rec.description === "string") record.description = rec.description;
		if (typeof rec.createdBy === "string")
			record.createdBy = rec.createdBy === "main" ? ROOT_AGENT_ID : rec.createdBy;
		if (rec.spawnMode === "fork" || rec.spawnMode === "spawn") record.spawnMode = rec.spawnMode;
		if (typeof rec.background === "string") record.background = rec.background;
		if (typeof rec.reportResult === "boolean") record.reportResult = rec.reportResult;
		const executors = normalizeExecutors(rec.executors, `Agent "${id}"`);
		if (executors !== undefined) record.executors = executors;
		if (typeof rec.model === "object" && rec.model !== null) {
			const m = rec.model as Record<string, unknown>;
			if (typeof m.provider === "string" && typeof m.modelId === "string") {
				record.model = { provider: m.provider, modelId: m.modelId };
			}
		}

		agents.push(record);
	}

	const root = agents.find((a) => a.id === ROOT_AGENT_ID);
	if (!root) {
		throw new Error(`Agents registry must include "${ROOT_AGENT_ID}" (${contextPath})`);
	}
	if (root.kind !== "root") {
		throw new Error(`Agent "${ROOT_AGENT_ID}" must have kind "root" (${contextPath})`);
	}
	for (const a of agents) {
		if (a.kind === "root" && a.id !== ROOT_AGENT_ID) {
			throw new Error(`Only "${ROOT_AGENT_ID}" may have kind "root" (${contextPath})`);
		}
		if (a.id !== ROOT_AGENT_ID && a.kind !== "child" && a.kind !== "guest") {
			throw new Error(`Agent "${a.id}" must have kind "child" or "guest" (${contextPath})`);
		}
		if ((a.kind === "child" || a.kind === "guest") && (!a.parentId || !seenIds.has(a.parentId))) {
			throw new Error(`Agent "${a.id}" has unknown parent "${a.parentId}" (${contextPath})`);
		}
	}
	assertAcyclicTree(agents, contextPath);

	return { version: 2, agents };
}

function assertAcyclicTree(agents: AgentRecord[], contextPath: string): void {
	const byId = new Map(agents.map((agent) => [agent.id, agent]));
	for (const agent of agents) {
		const seen = new Set<string>();
		let cursor: AgentRecord | undefined = agent;
		while (cursor?.parentId) {
			if (seen.has(cursor.id)) {
				throw new Error(`Agents registry contains a parent cycle at "${agent.id}" (${contextPath})`);
			}
			seen.add(cursor.id);
			cursor = byId.get(cursor.parentId);
		}
	}
}

export class AgentRegistry {
	private readonly cwd: string;
	private readonly path: string;
	private readonly agents: Map<string, AgentRecord>;

	private constructor(cwd: string, agents: Map<string, AgentRecord>) {
		this.cwd = cwd;
		this.path = getAgentsConfigPath(cwd);
		this.agents = agents;
	}

	static open(cwd: string): AgentRegistry {
		const path = getAgentsConfigPath(cwd);
		if (!existsSync(path)) {
			const root: AgentRecord = {
				id: ROOT_AGENT_ID,
				kind: "root",
				sessionFile: getSessionFile(cwd),
				createdAt: new Date().toISOString(),
				lifecycle: "persistent",
				hubExecutor: "enabled",
			};
			const map = new Map<string, AgentRecord>([[ROOT_AGENT_ID, root]]);
			const reg = new AgentRegistry(cwd, map);
			reg.save();
			return reg;
		}

		const raw = readFileSync(path, "utf8");
		const wasLegacy = /"version"\s*:\s*1/.test(raw);
		const file = parseRegistryJson(raw, path);
		const map = new Map<string, AgentRecord>();
		for (const a of file.agents) {
			map.set(a.id, a);
		}
		const registry = new AgentRegistry(cwd, map);
		if (wasLegacy) {
			registry.save();
		}
		return registry;
	}

	getAll(): AgentRecord[] {
		return [...this.agents.values()].map((r) => cloneRecord(r));
	}

	get(agentId: string): AgentRecord | undefined {
		const r = this.agents.get(agentId);
		return r ? cloneRecord(r) : undefined;
	}

	require(agentId: string): AgentRecord {
		const r = this.get(agentId);
		if (!r) {
			throw new Error(`Unknown agent id: ${agentId}`);
		}
		return r;
	}

	/**
	 * Like `createChild`, but the session file path is always `<hubWorkspace>/agents/<id>.jsonl` after
	 * a unique child id is allocated. Callers that need a stable path before creating the file should use this.
	 */
	createChildResolvingSessionPath(input: Omit<CreateChildAgentRecordInput, "sessionFile">): AgentRecord {
		const existingIds = new Set(this.agents.keys());
		const id = allocateChildId(existingIds, { ...input, sessionFile: "x" } as CreateChildAgentRecordInput);
		const sessionFile = getChildAgentSessionFile(this.cwd, id);
		return this.createChild({ ...input, id, sessionFile });
	}

	createGuestResolvingSessionPath(input: Omit<CreateGuestAgentRecordInput, "sessionFile">): AgentRecord {
		const existingIds = new Set(this.agents.keys());
		const id = allocateChildId(existingIds, { ...input, sessionFile: "x" } as CreateGuestAgentRecordInput);
		const sessionFile = getChildAgentSessionFile(this.cwd, id);
		return this.createGuest({ ...input, id, sessionFile });
	}

	createChild(input: CreateChildAgentRecordInput): AgentRecord {
		const sessionFile = assertNonEmptySessionFile(input.sessionFile, "createChild");
		const parent = this.agents.get(input.parentId);
		if (!parent) {
			throw new Error(`Unknown parent agent id: ${input.parentId}`);
		}
		const existingIds = new Set(this.agents.keys());
		const id = allocateChildId(existingIds, input);
		const record: AgentRecord = {
			id,
			kind: "child",
			parentId: parent.id,
			sessionFile,
			createdAt: new Date().toISOString(),
			lifecycle: input.lifecycle ?? "persistent",
			hubExecutor: input.hubExecutor ?? "enabled",
		};
		if (input.name !== undefined) record.name = input.name;
		if (input.description !== undefined) record.description = input.description;
		if (input.createdBy !== undefined) record.createdBy = input.createdBy;
		if (input.spawnMode !== undefined) record.spawnMode = input.spawnMode;
		if (input.background !== undefined) record.background = input.background;
		if (input.reportResult !== undefined) record.reportResult = input.reportResult;
		const executors = normalizeExecutors(input.executors, `createChild(${id})`);
		if (executors !== undefined) record.executors = executors;

		this.agents.set(id, record);
		return cloneRecord(record);
	}

	createGuest(input: CreateGuestAgentRecordInput): AgentRecord {
		const sessionFile = assertNonEmptySessionFile(input.sessionFile, "createGuest");
		const parent = this.agents.get(input.parentId);
		if (!parent) {
			throw new Error(`Unknown parent agent id: ${input.parentId}`);
		}
		const existingIds = new Set(this.agents.keys());
		const id = allocateChildId(existingIds, input);
		const record: AgentRecord = {
			id,
			kind: "guest",
			parentId: parent.id,
			sessionFile,
			createdAt: new Date().toISOString(),
			lifecycle: input.lifecycle ?? "persistent",
			hubExecutor: "disabled",
		};
		if (input.name !== undefined) record.name = input.name;
		if (input.description !== undefined) record.description = input.description;
		if (input.createdBy !== undefined) record.createdBy = input.createdBy;
		this.agents.set(id, record);
		return cloneRecord(record);
	}

	update(record: AgentRecord): void {
		const existing = this.agents.get(record.id);
		if (!existing) {
			throw new Error(`Cannot update unknown agent id: ${record.id}`);
		}
		const sessionFile = assertNonEmptySessionFile(record.sessionFile, `update(${record.id})`);

		if (existing.kind === "root") {
			if (record.id !== ROOT_AGENT_ID) {
				throw new Error(`Cannot change id of root agent`);
			}
			if (record.kind !== "root") {
				throw new Error(`Root agent must have kind "root"`);
			}
		} else {
			if (record.kind !== "child" && record.kind !== "guest") {
				throw new Error(`Agent "${record.id}" must have kind "child" or "guest"`);
			}
			if (!record.parentId || !this.agents.has(record.parentId)) {
				throw new Error(`Agent "${record.id}" has unknown parent "${record.parentId}"`);
			}
		}

		const next: AgentRecord = {
			...record,
			sessionFile,
			hubExecutor: normalizeHubExecutor(record.hubExecutor),
		};
		const executors = normalizeExecutors(record.executors, `update(${record.id})`);
		if (executors !== undefined) {
			next.executors = executors;
		}
		this.agents.set(record.id, next);
	}

	resolveNewChildAgentId(rawAgentId: string): string {
		const id = sanitizeIdBase(rawAgentId);
		if (id === ROOT_AGENT_ID) {
			throw new Error(`Invalid child id: "${rawAgentId}" resolves to reserved id "${ROOT_AGENT_ID}"`);
		}
		if (this.agents.has(id)) {
			throw new Error(`Duplicate agent id: ${id}`);
		}
		return id;
	}

	renameChild(agentId: string, newAgentId: string): AgentRecord {
		if (agentId === ROOT_AGENT_ID) {
			throw new Error(`Cannot rename root agent "${ROOT_AGENT_ID}"`);
		}
		const existing = this.agents.get(agentId);
		if (!existing) {
			throw new Error(`Unknown agent id: ${agentId}`);
		}
		if (existing.kind !== "child") {
			throw new Error(`Agent "${agentId}" is not a child agent`);
		}
		const resolvedId = this.resolveNewChildAgentId(newAgentId);
		const next: AgentRecord = {
			...existing,
			id: resolvedId,
			sessionFile: getChildAgentSessionFile(this.cwd, resolvedId),
		};
		this.agents.delete(agentId);
		this.agents.set(resolvedId, next);
		for (const record of this.agents.values()) {
			if (record.parentId === agentId) {
				record.parentId = resolvedId;
			}
		}
		return cloneRecord(next);
	}

	removeChild(agentId: string): AgentRecord {
		if (agentId === ROOT_AGENT_ID) {
			throw new Error(`Cannot remove root agent "${ROOT_AGENT_ID}"`);
		}
		const existing = this.agents.get(agentId);
		if (!existing) {
			throw new Error(`Unknown agent id: ${agentId}`);
		}
		if (existing.kind !== "child") {
			throw new Error(`Agent "${agentId}" is not a child agent`);
		}
		this.agents.delete(agentId);
		return cloneRecord(existing);
	}

	getChildren(parentId: string): AgentRecord[] {
		return [...this.agents.values()]
			.filter((agent) => agent.parentId === parentId)
			.map((agent) => cloneRecord(agent));
	}

	getDescendantIds(agentId: string): string[] {
		const out: string[] = [];
		const visit = (parentId: string): void => {
			for (const child of this.agents.values()) {
				if (child.parentId === parentId) {
					out.push(child.id);
					visit(child.id);
				}
			}
		};
		visit(agentId);
		return out;
	}

	isInSubtree(scopeRootAgentId: string, targetAgentId: string): boolean {
		if (scopeRootAgentId === targetAgentId) {
			return true;
		}
		let cursor = this.agents.get(targetAgentId);
		while (cursor?.parentId) {
			if (cursor.parentId === scopeRootAgentId) {
				return true;
			}
			cursor = this.agents.get(cursor.parentId);
		}
		return false;
	}

	save(): void {
		mkdirSync(getLocalPiDir(this.cwd), { recursive: true });
		const file: AgentRegistryFile = {
			version: 2,
			agents: [...this.agents.values()],
		};
		writeFileSync(this.path, `${JSON.stringify(file, null, 2)}\n`, "utf8");
	}
}
