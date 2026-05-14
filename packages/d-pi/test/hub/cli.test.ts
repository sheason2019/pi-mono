import { describe, expect, it, vi } from "vitest";
import { runPiHubCli } from "../../src/hub/cli.js";

describe("pi-hub CLI runner", () => {
	it("prints help without exiting the process", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		try {
			await expect(runPiHubCli(["help"])).resolves.toBe(0);
			expect(log).toHaveBeenCalledWith(expect.stringContaining("Usage:"));
			expect(log).toHaveBeenCalledWith(expect.stringContaining("serve"));
		} finally {
			log.mockRestore();
		}
	});

	it("returns an error for unknown commands", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		try {
			await expect(runPiHubCli(["missing"])).resolves.toBe(1);
			expect(error).toHaveBeenCalledWith("Unknown command: missing");
		} finally {
			error.mockRestore();
			log.mockRestore();
		}
	});
});
