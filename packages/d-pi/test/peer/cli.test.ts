import { describe, expect, it, vi } from "vitest";
import { runPiPeerCli } from "../../src/peer/cli.js";

describe("d-pi peer CLI runner", () => {
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
