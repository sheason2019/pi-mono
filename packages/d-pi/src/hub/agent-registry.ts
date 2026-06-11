import { createServer } from "node:net";
import type { AgentRecord, AgentStatus, GroupArchitectureSnapshot } from "../types.ts";

export class AgentRegistry {
	private readonly _agents = new Map<string, AgentRecord>();
	private _nextPort: number;

	constructor(startPort: number) {
		this._nextPort = startPort;
	}

	async allocatePort(): Promise<number> {
		// Try up to 100 ports starting from _nextPort
		for (let i = 0; i < 100; i++) {
			const port = this._nextPort++;
			if (await this._isPortAvailable(port)) {
				return port;
			}
		}
		throw new Error("No available ports found");
	}

	private _isPortAvailable(port: number): Promise<boolean> {
		return new Promise((resolve) => {
			const server = createServer();
			server.once("error", () => {
				resolve(false);
			});
			server.listen(port, () => {
				server.close(() => resolve(true));
			});
		});
	}

	register(record: AgentRecord): void {
		this._agents.set(record.id, record);
		// Add to parent's children list
		if (record.parentId) {
			const parent = this._agents.get(record.parentId);
			if (parent && !parent.children.includes(record.id)) {
				parent.children.push(record.id);
			}
		}
	}

	/**
	 * Unregister an agent and all its descendants.
	 * Returns the list of all destroyed agent IDs.
	 */
	unregister(agentId: string): string[] {
		const destroyed: string[] = [];
		const toRemove = this.getDescendants(agentId);
		toRemove.push(agentId);

		for (const id of toRemove) {
			const record = this._agents.get(id);
			if (record) {
				// Remove from parent's children list
				if (record.parentId) {
					const parent = this._agents.get(record.parentId);
					if (parent) {
						parent.children = parent.children.filter((c) => c !== id);
					}
				}
				this._agents.delete(id);
				destroyed.push(id);
			}
		}

		return destroyed;
	}

	get(agentId: string): AgentRecord | undefined {
		return this._agents.get(agentId);
	}

	getByName(name: string): AgentRecord | undefined {
		for (const agent of this._agents.values()) {
			if (agent.name === name) return agent;
		}
		return undefined;
	}

	updateStatus(agentId: string, status: AgentStatus): void {
		const record = this._agents.get(agentId);
		if (record) {
			record.status = status;
		}
	}

	getGroupArchitectureSnapshot(): GroupArchitectureSnapshot {
		let rootId = "";
		const agents = Array.from(this._agents.values()).map((a) => {
			if (a.name === "root") rootId = a.id;
			return {
				id: a.id,
				name: a.name,
				parentId: a.parentId,
				status: a.status,
				model: a.model,
				children: [...a.children],
			};
		});
		return { agents, rootId };
	}

	getDescendants(agentId: string): string[] {
		const result: string[] = [];
		const record = this._agents.get(agentId);
		if (!record) return result;

		for (const childId of record.children) {
			result.push(childId);
			result.push(...this.getDescendants(childId));
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
