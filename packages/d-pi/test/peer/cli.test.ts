import { describe, expect, it, vi } from "vitest";

const sendOneShotPeerMessage = vi.hoisted(() => vi.fn());

vi.mock("../../src/peer/commands/send-message.js", () => ({
	sendOneShotPeerMessage,
}));

import { runPiPeerCli } from "../../src/peer/cli.js";

describe("d-pi peer CLI runner", () => {
	it("prints the one-shot assistant response", async () => {
		sendOneShotPeerMessage.mockResolvedValueOnce("assistant answer");
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		try {
			await expect(runPiPeerCli(["--hub", "http://hub", "--agent", "writer", "-p", "hello"])).resolves.toBe(0);
			expect(sendOneShotPeerMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					hubUrl: "http://hub",
					agentId: "writer",
					message: "hello",
					noResponse: undefined,
				}),
			);
			expect(log).toHaveBeenCalledWith("assistant answer");
		} finally {
			log.mockRestore();
		}
	});

	it("does not print a response for --no-response one-shot messages", async () => {
		sendOneShotPeerMessage.mockResolvedValueOnce(undefined);
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		try {
			await expect(runPiPeerCli(["-p", "hello", "--no-response"])).resolves.toBe(0);
			expect(sendOneShotPeerMessage).toHaveBeenCalledWith(expect.objectContaining({ noResponse: true }));
			expect(log).not.toHaveBeenCalled();
		} finally {
			log.mockRestore();
		}
	});

	it("prints help without exiting the process", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		try {
			await expect(runPiPeerCli(["--help"])).resolves.toBe(0);
			expect(log).toHaveBeenCalledWith(expect.stringContaining("Usage:"));
		} finally {
			log.mockRestore();
		}
	});
});
