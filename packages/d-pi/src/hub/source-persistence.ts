import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SourceConfig } from "../types.ts";

/**
 * Shape of a `sources/<name>/source.json` file on disk.
 *
 * Mirrors `SourceConfig` (the runtime shape accepted by
 * `createSource`) but adds the two fields that need to survive
 * a hub restart: the creator's name and the subscriber list. Both
 * are agent NAMES, not UUIDs — see the "name is identity" rationale
 * in the changelog. With names as the unique key, a persisted
 * subscribers list is meaningful across restarts: the hub can
 * re-attach to the same agents on restart without an indirection
 * table.
 *
 * Kept separate from `SourceConfig` so the runtime config (what
 * a tool call sends) doesn't grow "persistence metadata" fields
 * it doesn't need. The on-disk format is intentionally an
 * additive superset.
 */
export interface SourceConfigFile {
	name: string;
	command: string;
	args: string[];
	cwd: string | undefined;
	env: Record<string, string> | undefined;
	/**
	 * Agent NAMES subscribed at the time of last persist. On restore,
	 * the hub re-subscribes only those names that are still in the
	 * registry (i.e. the agents that were subscribed to this source
	 * have themselves been restored). Names that don't resolve are
	 * silently skipped — the source might have outlived its agent.
	 */
	subscribers: string[];
	/** Agent NAME that originally called create_source, if any. */
	creatorName?: string;
}

const SOURCE_CONFIG_FILE = "source.json";

/**
 * Write (or overwrite) `sources/<name>/source.json` for a freshly
 * created or in-place updated source. Idempotent; safe to call
 * repeatedly.
 */
export function writeSourceConfig(workspaceRoot: string, config: SourceConfigFile): void {
	const dir = join(workspaceRoot, "sources", config.name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, SOURCE_CONFIG_FILE), `${JSON.stringify(config, null, "\t")}\n`);
}

/**
 * Remove `sources/<name>/` entirely. Called on `destroySource`.
 * Idempotent — missing directory is fine.
 */
export function deleteSourceConfig(workspaceRoot: string, name: string): void {
	const dir = join(workspaceRoot, "sources", name);
	if (existsSync(dir)) {
		rmSync(dir, { recursive: true, force: true });
	}
}

/**
 * Read all `sources/<name>/source.json` files under the workspace,
 * returning the parsed configs. Corrupt or unreadable files are
 * skipped with a stderr warning — the hub continues to start with
 * whatever it can recover.
 */
export function discoverSourceConfigs(workspaceRoot: string): SourceConfigFile[] {
	const sourcesDir = join(workspaceRoot, "sources");
	if (!existsSync(sourcesDir)) return [];

	const out: SourceConfigFile[] = [];
	for (const entry of readdirSyncSafe(sourcesDir)) {
		const configPath = join(sourcesDir, entry, SOURCE_CONFIG_FILE);
		if (!existsSync(configPath)) continue;
		try {
			const raw = readFileSync(configPath, "utf-8");
			out.push(JSON.parse(raw) as SourceConfigFile);
		} catch (err) {
			process.stderr.write(
				`[d-pi hub] Failed to parse source.json at ${configPath}: ${err instanceof Error ? err.message : String(err)}\n`,
			);
		}
	}
	return out;
}

function readdirSyncSafe(dir: string): string[] {
	try {
		// We only need the entry names here; the simpler overload (no
		// `withFileTypes`) is portable across Node 18+ and 20+. The hub
		// never reads the directory tree recursively here.
		return readdirSync(dir);
	} catch {
		return [];
	}
}

/**
 * Convert a `SourceConfigFile` (the on-disk format) into a
 * `SourceConfig` (the runtime shape accepted by `createSource`).
 * Pure function; no I/O.
 */
export function sourceConfigFileToConfig(
	file: SourceConfigFile,
): Pick<SourceConfig, "name" | "command" | "args" | "cwd" | "env"> {
	return {
		name: file.name,
		command: file.command,
		args: file.args,
		cwd: file.cwd,
		env: file.env,
	};
}
