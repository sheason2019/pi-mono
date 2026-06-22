import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { AGENT_TS_FILE } from "../agent-config.ts";
import type { LoadedAgentDefinition } from "../agent-loader.ts";
import { readLoadedAgentDefinitionFromTs } from "../agent-loader.ts";
import type { AgentConfig } from "../types.ts";
import { agentDefinitionToConfig } from "./agent-identity.ts";

/**
 * One discovered agent.ts on disk, paired with the directory entry
 * name it came from. The entry name is the canonical name.
 */
export interface DiscoveredAgent {
	entryName: string;
	config: AgentConfig;
	definition: LoadedAgentDefinition;
}

/**
 * Ordered + cycle-sanitised plan for restoring agents. Each entry's
 * `parentName` (if set) is guaranteed to point to an earlier entry in
 * the same list, OR to an agent that is not part of the restore set
 * (in which case the caller should treat it as an orphan).
 */
export interface RestoreEntry extends DiscoveredAgent {
	/** Depth in the parent chain within the discovered set (root = 0). */
	depth: number;
	/** True if the parent chain forms a cycle; entry is treated as orphan. */
	cycle: boolean;
}

/**
 * Read every `agents/<name>/agent.ts` in `workspaceRoot` and return
 * the agent configs, with the entry directory name preserved for
 * logging / error messages.
 *
 * Corrupt or unreadable agent.ts files are skipped with a stderr
 * warning; they do not abort the whole restore.
 */
export async function discoverPersistedAgents(workspaceRoot: string): Promise<DiscoveredAgent[]> {
	const agentsDir = join(workspaceRoot, "agents");
	if (!existsSync(agentsDir)) return [];

	const discovered: DiscoveredAgent[] = [];
	const entries = readdirSync(agentsDir, { withFileTypes: true });
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const configPath = join(agentsDir, entry.name, AGENT_TS_FILE);
		if (!existsSync(configPath)) continue;

		try {
			const agentDefinition = await readLoadedAgentDefinitionFromTs(join(agentsDir, entry.name));
			if (!agentDefinition) {
				continue;
			}
			discovered.push({
				entryName: entry.name,
				config: agentDefinitionToConfig(agentDefinition),
				definition: agentDefinition,
			});
		} catch (err) {
			process.stderr.write(
				`[d-pi hub] Failed to read agent.ts from ${entry.name}/: ${err instanceof Error ? err.message : String(err)}\n`,
			);
		}
	}
	return discovered;
}

/**
 * Compute the depth of `name` in its parent chain within the discovered
 * set. A name with no `parentName` (or whose parent is not in the set)
 * has depth 0. If walking the parent chain revisits `name`, the chain
 * has a cycle — returns `cycle: true` and the depth reached before the
 * cycle closed.
 */
function computeChainDepth(name: string, byName: Map<string, DiscoveredAgent>): { depth: number; cycle: boolean } {
	let depth = 0;
	let current: string | undefined = name;
	const seen = new Set<string>();
	while (current) {
		if (seen.has(current)) {
			return { depth, cycle: true };
		}
		seen.add(current);
		const entry = byName.get(current);
		if (!entry) break;
		const parentName = entry.config.parentName;
		if (!parentName) break;
		depth++;
		current = parentName;
	}
	return { depth, cycle: false };
}

/**
 * Sort the discovered agents so that parents always come before their
 * children. This is the bug fix for the orphan-on-restore issue: the
 * previous code iterated `readdirSync` in raw filesystem order, which
 * is not portable (e.g. on macOS HFS+/APFS the order is insertion /
 * case-insensitive / locale-dependent). If a child was read before its
 * parent, `getByName(parentName)` returned `undefined` and the child
 * was created as an orphan. Depth-sorting is deterministic and immune
 * to directory entry order.
 *
 * Tiebreaker: alphabetical by `config.name`. The sort is stable in V8.
 */
export function orderAgentsForRestore(discovered: DiscoveredAgent[]): RestoreEntry[] {
	const byName = new Map<string, DiscoveredAgent>();
	for (const d of discovered) {
		byName.set(d.config.name, d);
	}
	return discovered
		.map((d) => {
			const { depth, cycle } = computeChainDepth(d.config.name, byName);
			return { ...d, depth, cycle };
		})
		.sort((a, b) => {
			if (a.depth !== b.depth) return a.depth - b.depth;
			return a.config.name.localeCompare(b.config.name);
		});
}
