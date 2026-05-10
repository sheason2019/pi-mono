import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type SourceConfig, SourceHost, type SourceRuntimeStatus } from "../../hub/index.js";

export interface LoadPeerSourceConfigsOptions {
	cwd: string;
	agentDir: string;
	globalDir?: string;
}

export interface LoadedPeerSourceConfigs {
	configs: SourceConfig[];
	configPathByName: Map<string, string>;
}

function peerSourceConfigPaths(options: LoadPeerSourceConfigsOptions): string[] {
	return [
		join(options.agentDir, "sources.json"),
		join(options.globalDir ?? dirname(options.agentDir), "sources.json"),
		join(options.cwd, ".pi", "sources.json"),
	];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSourceEntry(raw: unknown, index: number): SourceConfig {
	if (!isRecord(raw)) {
		throw new Error(`Invalid source entry at index ${index}: expected object`);
	}
	if (typeof raw.name !== "string" || raw.name.length === 0) {
		throw new Error(`Invalid source entry at index ${index}: "name" must be a non-empty string`);
	}
	if (typeof raw.resourceId !== "string" || raw.resourceId.length === 0) {
		throw new Error(`Invalid source entry at index ${index}: "resourceId" must be a non-empty string`);
	}
	if (raw.transport !== "stdio") {
		throw new Error(`Invalid source transport: expected "stdio", got ${JSON.stringify(raw.transport)}`);
	}
	if (typeof raw.command !== "string" || raw.command.length === 0) {
		throw new Error(`Invalid source for ${JSON.stringify(raw.name)}: "command" must be a non-empty string`);
	}
	const out: SourceConfig = { resourceId: raw.resourceId, name: raw.name, transport: "stdio", command: raw.command };
	if (raw.args !== undefined) {
		if (!Array.isArray(raw.args) || !raw.args.every((arg) => typeof arg === "string")) {
			throw new Error(`Invalid source for ${JSON.stringify(raw.name)}: "args" must be an array of strings`);
		}
		out.args = raw.args;
	}
	if (raw.cwd !== undefined) {
		if (typeof raw.cwd !== "string") {
			throw new Error(`Invalid source for ${JSON.stringify(raw.name)}: "cwd" must be a string`);
		}
		out.cwd = raw.cwd;
	}
	if (raw.env !== undefined) {
		if (!isRecord(raw.env)) {
			throw new Error(`Invalid source for ${JSON.stringify(raw.name)}: "env" must be an object`);
		}
		out.env = Object.fromEntries(
			Object.entries(raw.env).map(([key, value]) => {
				if (typeof value !== "string") {
					throw new Error(`Invalid source env value for ${JSON.stringify(key)}: expected string`);
				}
				return [key, value];
			}),
		);
	}
	if (raw.agentId !== undefined) {
		if (typeof raw.agentId !== "string" || raw.agentId.trim().length === 0) {
			throw new Error(`Invalid source for ${JSON.stringify(raw.name)}: "agentId" must be a non-empty string`);
		}
		out.agentId = raw.agentId.trim();
	}
	if (raw.disabled !== undefined) {
		if (raw.disabled !== true && raw.disabled !== false) {
			throw new Error(`Invalid source for ${JSON.stringify(raw.name)}: "disabled" must be a boolean`);
		}
		out.disabled = raw.disabled;
	}
	return out;
}

function rawSourceResourceId(resourceId: string): string {
	const idx = resourceId.indexOf(":");
	return idx >= 0 ? resourceId.slice(idx + 1) : resourceId;
}

function sourceResourceIdsMatch(a: string, b: string): boolean {
	return a === b || rawSourceResourceId(a) === rawSourceResourceId(b);
}

function loadSourcesConfigFromFile(path: string): SourceConfig[] {
	ensurePeerSourceResourceIds(path);
	const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
	const rawSources = Array.isArray(parsed)
		? parsed
		: isRecord(parsed) && parsed.sources === undefined
			? []
			: isRecord(parsed) && Array.isArray(parsed.sources)
				? parsed.sources
				: undefined;
	if (!rawSources) {
		throw new Error(
			'Invalid sources config: root must be a JSON array of sources, or an object with a "sources" array',
		);
	}
	const sources = rawSources.map((entry, index) => parseSourceEntry(entry, index));
	const seen = new Set<string>();
	for (const source of sources) {
		if (seen.has(source.name)) {
			throw new Error(`Duplicate source name ${JSON.stringify(source.name)}`);
		}
		seen.add(source.name);
	}
	return sources;
}

function ensurePeerSourceResourceIds(path: string): void {
	const root = JSON.parse(readFileSync(path, "utf8")) as unknown;
	const rawSources = Array.isArray(root)
		? root
		: isRecord(root) && root.sources === undefined
			? []
			: isRecord(root) && Array.isArray(root.sources)
				? root.sources
				: undefined;
	if (!rawSources) {
		return;
	}
	let changed = false;
	for (const entry of rawSources) {
		if (isRecord(entry) && (typeof entry.resourceId !== "string" || entry.resourceId.length === 0)) {
			entry.resourceId = randomUUID();
			changed = true;
		}
	}
	if (!changed) {
		return;
	}
	const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
	try {
		writeFileSync(tmp, `${JSON.stringify(root, null, 2)}\n`, "utf8");
		renameSync(tmp, path);
	} catch (error) {
		try {
			if (existsSync(tmp)) {
				unlinkSync(tmp);
			}
		} catch {
			// best-effort cleanup
		}
		throw error;
	}
}

function mutateSourcesConfigFile(
	path: string,
	resourceId: string,
	mutate: (entry: Record<string, unknown>[]) => void,
): void {
	const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
	if (!Array.isArray(parsed) && !(isRecord(parsed) && Array.isArray(parsed.sources))) {
		throw new Error(
			'Invalid sources config: root must be a JSON array of sources, or an object with a "sources" array',
		);
	}
	const workingArray = (Array.isArray(parsed) ? parsed : parsed.sources) as unknown[];
	const index = workingArray.findIndex((entry) => isRecord(entry) && entry.resourceId === resourceId);
	if (index < 0) {
		throw new Error(`Source resourceId ${JSON.stringify(resourceId)} not found in sources config`);
	}
	mutate(workingArray as Record<string, unknown>[]);
	const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
	try {
		writeFileSync(tmp, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
		renameSync(tmp, path);
	} catch (error) {
		try {
			if (existsSync(tmp)) {
				unlinkSync(tmp);
			}
		} catch {
			// best-effort cleanup
		}
		throw error;
	}
}

function pauseSourceInConfigFile(path: string, resourceId: string): void {
	mutateSourcesConfigFile(path, resourceId, (entries) => {
		const entry = entries.find((candidate) => candidate.resourceId === resourceId);
		if (entry) {
			entry.disabled = true;
		}
	});
}

function resumeSourceInConfigFile(path: string, resourceId: string): void {
	mutateSourcesConfigFile(path, resourceId, (entries) => {
		const entry = entries.find((candidate) => candidate.resourceId === resourceId);
		if (entry) {
			delete entry.disabled;
		}
	});
}

function removeSourceInConfigFile(path: string, resourceId: string): void {
	mutateSourcesConfigFile(path, resourceId, (entries) => {
		const index = entries.findIndex((candidate) => candidate.resourceId === resourceId);
		if (index >= 0) {
			entries.splice(index, 1);
		}
	});
}

export function loadPeerSourceConfigs(options: LoadPeerSourceConfigsOptions): LoadedPeerSourceConfigs {
	const byName = new Map<string, SourceConfig>();
	const order: string[] = [];
	const configPathByName = new Map<string, string>();
	for (const path of peerSourceConfigPaths(options)) {
		if (!existsSync(path)) {
			continue;
		}
		for (const config of loadSourcesConfigFromFile(path)) {
			if (!byName.has(config.name)) {
				order.push(config.name);
			}
			byName.set(config.name, config);
			configPathByName.set(config.name, path);
		}
	}
	return {
		configs: order.flatMap((name) => {
			const config = byName.get(name);
			return config ? [config] : [];
		}),
		configPathByName,
	};
}

export interface PeerSourceRuntimeHost {
	start(): Promise<void>;
	stop(): Promise<void>;
	getStatuses(): SourceRuntimeStatus[];
	pauseSource(resourceId: string): Promise<void>;
	restartSource(resourceId: string): Promise<void>;
	removeSource(resourceId: string): Promise<void>;
}

export interface PeerSourceRuntimeOptions {
	cwd: string;
	agentDir: string;
	globalDir?: string;
	peerId: string;
	isHubRunning: () => boolean;
	targetAgentId?: () => string;
	emitSourceMessage: (sourceName: string, text: string, agentId?: string) => Promise<void>;
	host?: PeerSourceRuntimeHost;
}

export class PeerSourceRuntime {
	private host: PeerSourceRuntimeHost | undefined;
	private configPathByName = new Map<string, string>();
	private configPathByResourceId = new Map<string, string>();
	private configuredAgentIdByName = new Map<string, string>();

	constructor(private readonly options: PeerSourceRuntimeOptions) {
		this.host = options.host;
	}

	async start(): Promise<void> {
		await this.requireHost().start();
	}

	async stop(): Promise<void> {
		await this.requireHost().stop();
	}

	getStatuses(): Array<SourceRuntimeStatus & { origin: "peer"; peerId: string }> {
		return this.requireHost()
			.getStatuses()
			.map((status) => ({
				...status,
				agentId: this.configuredAgentIdByName.get(status.name) ?? this.options.targetAgentId?.() ?? status.agentId,
				origin: "peer" as const,
				peerId: this.options.peerId,
			}));
	}

	hasLocalSourceResourceId(resourceId: string): boolean {
		return this.getMatchingLocalSourceResourceIds(resourceId).length > 0;
	}

	getMatchingLocalSourceResourceIds(resourceId: string): string[] {
		const out: string[] = [];
		for (const status of this.requireHost().getStatuses()) {
			if (status.resourceId !== undefined && sourceResourceIdsMatch(status.resourceId, resourceId)) {
				out.push(status.resourceId);
			}
		}
		return out;
	}

	async pauseSource(resourceId: string): Promise<void> {
		await this.requireHost().pauseSource(resourceId);
	}

	async restartSource(resourceId: string): Promise<void> {
		await this.requireHost().restartSource(resourceId);
	}

	async removeSource(resourceId: string): Promise<void> {
		await this.requireHost().removeSource(resourceId);
	}

	private loadSources(): SourceConfig[] {
		const loaded = loadPeerSourceConfigs({
			cwd: this.options.cwd,
			agentDir: this.options.agentDir,
			globalDir: this.options.globalDir,
		});
		this.configPathByName = loaded.configPathByName;
		this.configPathByResourceId = new Map(
			loaded.configs.map((config) => [config.resourceId, this.configPathByName.get(config.name)!]),
		);
		this.configuredAgentIdByName = new Map(
			loaded.configs.flatMap((config) => (config.agentId !== undefined ? [[config.name, config.agentId]] : [])),
		);
		return loaded.configs;
	}

	private requireHost(): PeerSourceRuntimeHost {
		this.host ??= new SourceHost({
			cwd: this.options.cwd,
			loadSources: () => this.loadSources(),
			sourceMutators: {
				pause: (name) => pauseSourceInConfigFile(this.requireConfigPath(name), name),
				resume: (name) => resumeSourceInConfigFile(this.requireConfigPath(name), name),
				remove: (name) => removeSourceInConfigFile(this.requireConfigPath(name), name),
			},
			inbound: {
				submitFromSource: async (sourceName, _agentId, text) => {
					const agentId = this.configuredAgentIdByName.get(sourceName) ?? this.options.targetAgentId?.();
					await this.options.emitSourceMessage(sourceName, text, agentId);
				},
			},
		});
		return this.host;
	}

	private requireConfigPath(name: string): string {
		if (this.configPathByName.size === 0) {
			this.loadSources();
		}
		const path = this.configPathByResourceId.get(name) ?? this.configPathByName.get(name);
		if (!path) {
			throw new Error(`Source ${JSON.stringify(name)} not found in peer sources config`);
		}
		return path;
	}
}
