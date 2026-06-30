import type { AgentPlanItem, AgentRecord, AgentStatus, PublicTeamSnapshot, TeamSnapshot } from "../types.ts";

/**
 * In-memory registry of running agents.
 *
 * The map is keyed by agent `name` (not a generated UUID) — see the
 * "name is identity" rationale in the changelog for why we dropped
 * UUIDs in favor of names. Every public lookup (`get`, `getByName`,
 * `unregister`, `getDescendants`, etc.) takes a name. `getByName` is
 * kept as an alias for the name-based lookup so existing call sites
 * read naturally; it is now O(1) because the map is name-keyed.
 *
 * Parent/children references store the child / parent name string
 * directly. The persisted `agent.ts` config already uses `parentName` (not
 * `parentId`), so there is no migration step — restored records slot
 * in without a remap.
 */
export class AgentRegistry {
	private readonly _agents = new Map<string, AgentRecord>();

	register(record: AgentRecord): void {
		if (this._agents.has(record.name)) {
			throw new Error(`Agent "${record.name}" already exists`);
		}
		this._agents.set(record.name, record);
		// Add to parent's children list (by name, same as the map key)
		if (record.parentName) {
			const parent = this._agents.get(record.parentName);
			if (parent && !parent.children.includes(record.name)) {
				parent.children.push(record.name);
			}
		}
	}

	/**
	 * Unregister an agent and all its descendants.
	 * Returns the list of all destroyed agent names.
	 */
	unregister(agentName: string): string[] {
		const destroyed: string[] = [];
		const toRemove = this.getDescendants(agentName);
		toRemove.push(agentName);

		for (const name of toRemove) {
			const record = this._agents.get(name);
			if (record) {
				// Remove from parent's children list
				if (record.parentName) {
					const parent = this._agents.get(record.parentName);
					if (parent) {
						parent.children = parent.children.filter((c) => c !== name);
					}
				}
				this._agents.delete(name);
				destroyed.push(name);
			}
		}

		return destroyed;
	}

	get(agentName: string): AgentRecord | undefined {
		return this._agents.get(agentName);
	}

	getByName(name: string): AgentRecord | undefined {
		// Map is name-keyed, so this is now O(1) — same as `get`.
		return this._agents.get(name);
	}

	updateStatus(agentName: string, status: AgentStatus): void {
		const record = this._agents.get(agentName);
		if (record) {
			record.status = status;
		}
	}

	updatePlan(agentName: string, plan: AgentPlanItem[]): void {
		const record = this._agents.get(agentName);
		if (record) {
			record.plan = plan.map((p) => ({ ...p }));
		}
	}

	getTeamSnapshot(): TeamSnapshot {
		let rootName = "";
		const agents = Array.from(this._agents.values()).map((a) => {
			if (a.name === "root") rootName = a.name;
			return {
				name: a.name,
				parentName: a.parentName,
				status: a.status,
				children: [...a.children],
				cwd: a.cwd,
				plan: a.plan.map((p) => ({ ...p })),
			};
		});
		return { agents, sources: [], executors: [], rootName };
	}

	getPublicTeamSnapshot(): PublicTeamSnapshot {
		let rootName = "";
		const agents = Array.from(this._agents.values()).map((a) => {
			if (a.name === "root") rootName = a.name;
			return {
				name: a.name,
				parentName: a.parentName,
				status: a.status,
				children: [...a.children],
				plan: a.plan.map((p) => ({ ...p })),
			};
		});
		return { agents, rootName };
	}

	getDescendants(agentName: string): string[] {
		const result: string[] = [];
		const record = this._agents.get(agentName);
		if (!record) return result;

		for (const childName of record.children) {
			result.push(childName);
			result.push(...this.getDescendants(childName));
		}
		return result;
	}

	getRootAgent(): AgentRecord | undefined {
		return this.getByName("root");
	}

	getAll(): IterableIterator<AgentRecord> {
		return this._agents.values();
	}

	get size(): number {
		return this._agents.size;
	}
}
