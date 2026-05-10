import { describe, expect, it, vi } from "vitest";
import { PeerUiState } from "../../src/peer/state/peer-ui-state.js";

describe("peer ui state", () => {
	it("keeps draft updates out of the global render subscription path", () => {
		const state = new PeerUiState();
		const listener = vi.fn();
		state.subscribe(listener);

		state.setDraft("h");
		state.setDraft("he");

		expect(state.getSnapshot().draft).toBe("he");
		expect(listener).not.toHaveBeenCalled();
	});

	it("still emits for non-draft ui changes", () => {
		const state = new PeerUiState();
		const listener = vi.fn();
		state.subscribe(listener);

		state.setConnectionStatus({ state: "connected", message: "Connected to hub." });

		expect(listener).toHaveBeenCalledTimes(1);
		expect(listener).toHaveBeenLastCalledWith({
			connectionState: "connected",
			connectionMessage: "Connected to hub.",
			draft: "",
			isCancelling: false,
			isCrdtResyncing: false,
		});
	});
});
