import * as Automerge from "@automerge/automerge";
import type { HubViewDocumentState, SessionCrdtSyncFormat } from "../../hub/index.js";

export interface PeerCrdtApplyResult {
	view: Automerge.Doc<HubViewDocumentState>;
}

export class PeerCrdtState {
	private doc: Automerge.Doc<HubViewDocumentState> = Automerge.init();

	reset(): void {
		this.doc = Automerge.init();
	}

	applySyncMessage(message: Uint8Array, format: SessionCrdtSyncFormat = "sync"): PeerCrdtApplyResult {
		if (format === "snapshot") {
			this.doc = Automerge.load<HubViewDocumentState>(message);
			return { view: this.doc };
		}
		if (format === "incremental") {
			this.doc = Automerge.loadIncremental(this.doc, message);
			return { view: this.doc };
		}
		const [nextDoc] = Automerge.receiveSyncMessage(this.doc, Automerge.initSyncState(), message);
		this.doc = nextDoc;
		return { view: this.doc };
	}

	getSnapshot(): Automerge.Doc<HubViewDocumentState> {
		return this.doc;
	}
}
