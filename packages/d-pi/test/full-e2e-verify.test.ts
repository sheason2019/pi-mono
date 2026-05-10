import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createCommandForStep, createVitestArgs, E2E_STEPS, E2E_TEST_GROUPS } from "../scripts/full-e2e-verify.js";

const packageRoot = join(import.meta.dirname, "..");

describe("full e2e verify flow", () => {
	it("is exposed as an explicit package script", () => {
		const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
			scripts?: Record<string, string>;
		};

		expect(pkg.scripts?.["verify:e2e"]).toBe("npx tsx scripts/full-e2e-verify.ts");
	});

	it("covers the main d-pi runtime paths with grouped focused tests", () => {
		const groupedFiles = E2E_TEST_GROUPS.flatMap((group) => group.files);
		expect(E2E_TEST_GROUPS.map((group) => group.name)).toEqual([
			"hub-startup-security",
			"hub-peer-session",
			"remote-tooling",
			"sources-and-mcp",
			"peer-ui-and-distribution",
		]);
		expect(groupedFiles).toEqual(
			expect.arrayContaining([
				"test/hub/serve-tui.test.ts",
				"test/hub/auth-token-store.test.ts",
				"test/hub/hub-runtime-agents.test.ts",
				"test/hub/socket-hub-server-agent-binding.test.ts",
				"test/peer/hub-peer-roundtrip.test.ts",
				"test/hub/peer-tool-bridge-agent.test.ts",
				"test/hub/host-peer-tools.test.ts",
				"test/hub/source-host.test.ts",
				"test/hub/mcp-host-lifecycle.test.ts",
				"test/peer/forked-interactive-mode.test.ts",
				"test/package-distribution.test.ts",
			]),
		);
		expect(new Set(groupedFiles).size).toBe(groupedFiles.length);
		expect(createVitestArgs().slice(0, 3)).toEqual(["tsx", "../../node_modules/vitest/dist/cli.js", "--run"]);
	});

	it("builds the publish package before distribution assertions", () => {
		const distributionBuildIndex = E2E_STEPS.findIndex((step) => step.name === "distribution-build");
		const distributionTestIndex = E2E_STEPS.findIndex((step) => step.name === "peer-ui-and-distribution");
		expect(distributionBuildIndex).toBeGreaterThan(-1);
		expect(distributionBuildIndex).toBeLessThan(distributionTestIndex);
		expect(createCommandForStep(E2E_STEPS[distributionBuildIndex]!)).toEqual({
			command: "npm",
			args: ["run", "prepare:publish"],
		});
	});
});
