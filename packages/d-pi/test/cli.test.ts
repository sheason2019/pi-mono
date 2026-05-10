import { describe, expect, it, vi } from "vitest";
import { runBundledDPiCli } from "../src/bundled-runner.js";
import { HUB_PROTOCOL_VERSION } from "../src/hub/transport/protocol.js";
import { getDPiHelpText, resolveDPiCommand } from "../src/index.js";
import { VERSION } from "../src/version.js";

describe("d-pi CLI", () => {
	it("resolves hub and peer subcommands for in-process dispatch", () => {
		const hub = resolveDPiCommand(["hub", "serve", "--port", "0"]);
		const peer = resolveDPiCommand(["peer", "--hub", "http://127.0.0.1:4317"]);

		expect(hub).toMatchObject({
			subcommand: "hub",
			args: ["serve", "--port", "0"],
		});
		expect(peer).toMatchObject({
			subcommand: "peer",
			args: ["--hub", "http://127.0.0.1:4317"],
		});
	});

	it("opens d-pi hub serve to LAN by default without overriding explicit host config", () => {
		const hubServe = resolveDPiCommand(["hub", "serve"], {});
		const explicitHost = resolveDPiCommand(["hub", "serve"], { PI_HUB_HOST: "127.0.0.1" });
		const hubStatus = resolveDPiCommand(["hub", "status"], {});

		expect(hubServe?.env).toEqual({ PI_HUB_HOST: "0.0.0.0" });
		expect(explicitHost?.env).toBeUndefined();
		expect(hubStatus?.env).toBeUndefined();
	});

	it("returns undefined for unknown subcommands and documents the unified shape", () => {
		expect(resolveDPiCommand(["serve"])).toBeUndefined();
		const help = getDPiHelpText("d-pi");
		expect(help).toContain("D-Pi");
		expect(help).toContain("d-pi hub");
		expect(help).toContain("d-pi peer");
	});

	it("runs bundled help and unknown-command paths in-process", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const helpCode = await runBundledDPiCli(["help"]);
			const unknownCode = await runBundledDPiCli(["serve"]);

			expect(helpCode).toBe(0);
			expect(unknownCode).toBe(1);
		} finally {
			log.mockRestore();
			error.mockRestore();
		}
	});

	it("prints d-pi and hub protocol version through --version, -v, and version", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		try {
			for (const args of [["--version"], ["-v"], ["version"]]) {
				log.mockClear();
				const code = await runBundledDPiCli(args);
				expect(code).toBe(0);
				const printed = log.mock.calls.map((call) => String(call[0])).join("\n");
				expect(printed).toContain(`d-pi ${VERSION}`);
				expect(printed).toContain(`hub protocol v${HUB_PROTOCOL_VERSION}`);
			}
		} finally {
			log.mockRestore();
		}
	});
});
