import type {
	PeerConfigPayload,
	PeerHelloPayload,
	PeerRegistryEvent,
	RegisteredPeer,
	RegisterPeerResult,
	UpdatePeerConfigResult,
} from "./peer-types.js";

function normalizeTools(tools: string[] | undefined): string[] {
	return [...new Set((tools ?? []).map((tool) => tool.trim()).filter((tool) => tool.length > 0))].sort((a, b) =>
		a.localeCompare(b),
	);
}

export class PeerRegistry {
	private readonly peersById = new Map<string, RegisteredPeer>();
	private readonly peerIdsBySocketId = new Map<string, string>();
	private readonly listeners = new Set<(event: PeerRegistryEvent) => void>();

	register(socketId: string, hello: PeerHelloPayload, agentId: string): RegisterPeerResult {
		const peerId = hello.peerId.trim();
		if (peerId.length === 0) {
			throw new Error("peerId is required.");
		}
		if (agentId.length === 0) {
			throw new Error("agentId is required.");
		}

		let replacedSocketId: string | undefined;
		const existingPeer = this.peersById.get(peerId);
		if (existingPeer && existingPeer.socketId !== socketId) {
			replacedSocketId = existingPeer.socketId;
			this.peerIdsBySocketId.delete(existingPeer.socketId);
		}

		const peer: RegisteredPeer = {
			agentId,
			peerId,
			socketId,
			protocolVersion: hello.protocolVersion,
			displayName: hello.displayName?.trim() || undefined,
			version: hello.version?.trim() || undefined,
			platform: hello.platform?.trim() || undefined,
			hostname: hello.hostname?.trim() || undefined,
			cwd: hello.cwd?.trim() || undefined,
			executorEnabled: hello.executorEnabled !== false,
			tools: [],
			connectedAt: existingPeer?.connectedAt ?? new Date().toISOString(),
			transport: "socket.io",
		};

		this.peersById.set(peer.peerId, peer);
		this.peerIdsBySocketId.set(socketId, peer.peerId);
		this.emit({
			type: "registered",
			peer,
			replacedSocketId,
		});
		return { peer, replacedSocketId };
	}

	updateConfigBySocketId(socketId: string, config: PeerConfigPayload): UpdatePeerConfigResult {
		const existing = this.getBySocketId(socketId);
		if (!existing) {
			throw new Error("Peer is not registered.");
		}
		const peer: RegisteredPeer = {
			...existing,
			tools: existing.executorEnabled ? normalizeTools(config.tools) : [],
			mcpSnapshot: existing.executorEnabled ? config.mcpSnapshot : undefined,
		};
		this.peersById.set(peer.peerId, peer);
		this.emit({
			type: "updated",
			peer,
		});
		return { peer };
	}

	unregisterBySocketId(socketId: string): RegisteredPeer | undefined {
		const peerId = this.peerIdsBySocketId.get(socketId);
		if (!peerId) {
			return undefined;
		}

		this.peerIdsBySocketId.delete(socketId);
		const peer = this.peersById.get(peerId);
		if (!peer || peer.socketId !== socketId) {
			return undefined;
		}

		this.peersById.delete(peerId);
		this.emit({
			type: "unregistered",
			peer,
		});
		return peer;
	}

	get(peerId: string): RegisteredPeer | undefined {
		return this.peersById.get(peerId);
	}

	getBySocketId(socketId: string): RegisteredPeer | undefined {
		const peerId = this.peerIdsBySocketId.get(socketId);
		return peerId ? this.peersById.get(peerId) : undefined;
	}

	list(): RegisteredPeer[] {
		return [...this.peersById.values()].sort((a, b) => a.peerId.localeCompare(b.peerId));
	}

	size(): number {
		return this.peersById.size;
	}

	subscribe(listener: (event: PeerRegistryEvent) => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	private emit(event: PeerRegistryEvent): void {
		for (const listener of this.listeners) {
			listener(event);
		}
	}
}
