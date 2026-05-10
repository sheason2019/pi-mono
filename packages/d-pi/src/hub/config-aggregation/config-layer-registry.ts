import type { PeerConfigSnapshot } from "./types.js";

interface AgentSnapshots {
	order: string[];
	byPeerId: Map<string, PeerConfigSnapshot>;
}

export class ConfigLayerRegistry {
	private readonly byAgentId = new Map<string, AgentSnapshots>();

	setPeerSnapshot(agentId: string, peerId: string, snapshot: PeerConfigSnapshot): void {
		let entry = this.byAgentId.get(agentId);
		if (!entry) {
			entry = { order: [], byPeerId: new Map() };
			this.byAgentId.set(agentId, entry);
		}
		if (!entry.byPeerId.has(peerId)) {
			entry.order.push(peerId);
		}
		entry.byPeerId.set(peerId, snapshot);
	}

	removePeerSnapshot(agentId: string, peerId: string): void {
		const entry = this.byAgentId.get(agentId);
		if (!entry) {
			return;
		}
		entry.byPeerId.delete(peerId);
		entry.order = entry.order.filter((id) => id !== peerId);
		if (entry.order.length === 0) {
			this.byAgentId.delete(agentId);
		}
	}

	removeAgentSnapshots(agentId: string): void {
		this.byAgentId.delete(agentId);
	}

	listPeerIds(agentId: string): string[] {
		return [...(this.byAgentId.get(agentId)?.order ?? [])];
	}

	getPrimaryPeerSnapshot(agentId: string): PeerConfigSnapshot | undefined {
		const entry = this.byAgentId.get(agentId);
		if (!entry) {
			return undefined;
		}
		const first = entry.order[0];
		return first ? entry.byPeerId.get(first) : undefined;
	}

	listPeerSnapshots(agentId: string): Array<{ peerId: string; snapshot: PeerConfigSnapshot }> {
		const entry = this.byAgentId.get(agentId);
		if (!entry) {
			return [];
		}
		return entry.order
			.map((peerId) => {
				const snapshot = entry.byPeerId.get(peerId);
				return snapshot ? { peerId, snapshot } : undefined;
			})
			.filter((item): item is { peerId: string; snapshot: PeerConfigSnapshot } => item !== undefined);
	}
}
