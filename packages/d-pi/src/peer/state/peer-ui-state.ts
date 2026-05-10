import type { PeerConnectionState, PeerConnectionStatus } from "../types.js";

export interface PeerUiSnapshot {
	connectionState: PeerConnectionState;
	connectionMessage?: string;
	draft: string;
	isCancelling?: boolean;
	isCrdtResyncing?: boolean;
}

export class PeerUiState {
	private connectionState: PeerConnectionState = "idle";
	private connectionMessage: string | undefined;
	private draft = "";
	private isCancelling = false;
	private isCrdtResyncing = false;
	private readonly listeners = new Set<(snapshot: PeerUiSnapshot) => void>();

	subscribe(listener: (snapshot: PeerUiSnapshot) => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	setConnectionState(connectionState: PeerConnectionState): void {
		this.connectionState = connectionState;
		this.connectionMessage = undefined;
		this.emit();
	}

	setConnectionStatus(status: PeerConnectionStatus): void {
		this.connectionState = status.state;
		this.connectionMessage = status.message;
		this.emit();
	}

	setDraft(draft: string): void {
		this.draft = draft;
	}

	setCancelling(isCancelling: boolean): void {
		if (this.isCancelling === isCancelling) {
			return;
		}
		this.isCancelling = isCancelling;
		this.emit();
	}

	setCrdtResyncing(isCrdtResyncing: boolean): void {
		if (this.isCrdtResyncing === isCrdtResyncing) {
			return;
		}
		this.isCrdtResyncing = isCrdtResyncing;
		this.emit();
	}

	getSnapshot(): PeerUiSnapshot {
		return {
			connectionState: this.connectionState,
			connectionMessage: this.connectionMessage,
			draft: this.draft,
			isCancelling: this.isCancelling,
			isCrdtResyncing: this.isCrdtResyncing,
		};
	}

	private emit(): void {
		const snapshot = this.getSnapshot();
		for (const listener of this.listeners) {
			listener(snapshot);
		}
	}
}
