import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildWorkerAdditionalExtensionPaths } from "../src/worker/resource-paths.ts";

let tempDir: string | undefined;

describe("worker resource paths", () => {
	afterEach(() => {
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = undefined;
		}
	});

	it("adds the generated tui-components capability module to connect-synced paths", () => {
		tempDir = mkdtempSync(join(tmpdir(), "d-pi-worker-paths-"));
		const workspaceExtensionPath = "/workspace/extensions/team.ts";
		writeFileSync(join(tempDir, "agent.ts"), `export default {};`);

		const paths = buildWorkerAdditionalExtensionPaths({
			agentCwd: tempDir,
			workspaceRoot: undefined,
			workspaceAdditionalExtensionPaths: [workspaceExtensionPath],
		});

		const capabilityPath = join(tempDir, ".d-pi-tui-components-capability.ts");
		expect(paths).toEqual([capabilityPath, workspaceExtensionPath]);
		expect(existsSync(capabilityPath)).toBe(true);
	});
});
