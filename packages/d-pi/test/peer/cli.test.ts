import { describe, expect, it, vi } from "vitest";

const sendOneShotPeerMessage = vi.hoisted(() => vi.fn());

vi.mock("../../src/peer/commands/send-message.js", () => ({
	sendOneShotPeerMessage,
}));

import { runPiPeerCli } from "../../src/peer/cli.js";

describe("d-pi peer CLI runner", () => {
	it("prints only the one-shot assistant response to stdout", async () => {
		sendOneShotPeerMessage.mockResolvedValueOnce("assistant answer");
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		try {
			await expect(runPiPeerCli(["--hub", "http://hub", "--agent", "writer", "-p", "hello"])).resolves.toBe(0);
			expect(sendOneShotPeerMessage).toHaveBeenCalledWith(
				expect.not.objectContaining({
					onHandshakeLog: expect.any(Function),
				}),
			);
			expect(sendOneShotPeerMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					hubUrl: "http://hub",
					agentId: "writer",
					message: "hello",
					noResponse: undefined,
				}),
			);
			expect(stdout).toHaveBeenCalledWith("assistant answer\n");
			expect(log).not.toHaveBeenCalled();
			expect(error).not.toHaveBeenCalled();
		} finally {
			log.mockRestore();
			error.mockRestore();
			stdout.mockRestore();
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
