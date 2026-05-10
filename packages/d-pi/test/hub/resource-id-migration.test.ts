import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getMcpConfigPath } from "../../src/hub/mcp/mcp-config.js";
import { getHubModelsConfigPaths } from "../../src/hub/models-config.js";
import { ensureMcpResourceIds, ensureModelsResourceIds, ensureSourceResourceIds } from "../../src/hub/resource-ids.js";
import { getSourcesConfigPath } from "../../src/hub/sources/source-config.js";

const tempDirs: string[] = [];

function writeJson(path: string, value: unknown): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readJson(path: string): unknown {
	return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("resource id migration", () => {
	it("persists missing source resourceIds before sources start and preserves existing ids", () => {
		const cwd = mkdtempSync(join(tmpdir(), "resource-id-source-"));
		tempDirs.push(cwd);
		const path = getSourcesConfigPath(cwd);
		writeJson(path, {
			sources: [
				{ name: "a", transport: "stdio", command: "a-cmd" },
				{ resourceId: "existing-source", name: "b", transport: "stdio", command: "b-cmd" },
			],
		});

		const result = ensureSourceResourceIds(path, { createId: () => "new-source" });

		expect(result.changed).toBe(true);
		expect(result.resourceIdsByName).toEqual(
			new Map([
				["a", "new-source"],
				["b", "existing-source"],
			]),
		);
		expect(readJson(path)).toEqual({
			sources: [
				{ name: "a", transport: "stdio", command: "a-cmd", resourceId: "new-source" },
				{ resourceId: "existing-source", name: "b", transport: "stdio", command: "b-cmd" },
			],
		});
	});

	it("persists missing MCP resourceIds for bare-array configs", () => {
		const cwd = mkdtempSync(join(tmpdir(), "resource-id-mcp-"));
		tempDirs.push(cwd);
		const path = getMcpConfigPath(cwd);
		writeJson(path, [
			{ name: "fs", transport: "stdio", command: "fs-cmd" },
			{ resourceId: "existing-mcp", name: "git", transport: "stdio", command: "git-cmd" },
		]);

		const result = ensureMcpResourceIds(path, { createId: () => "new-mcp" });

		expect(result.changed).toBe(true);
		expect(result.resourceIdsByName).toEqual(
			new Map([
				["fs", "new-mcp"],
				["git", "existing-mcp"],
			]),
		);
		expect(readJson(path)).toEqual([
			{ name: "fs", transport: "stdio", command: "fs-cmd", resourceId: "new-mcp" },
			{ resourceId: "existing-mcp", name: "git", transport: "stdio", command: "git-cmd" },
		]);
	});

	it("persists provider and model resourceIds in models.json", () => {
		const cwd = mkdtempSync(join(tmpdir(), "resource-id-models-"));
		tempDirs.push(cwd);
		const agentDir = join(cwd, "agent");
		const path = getHubModelsConfigPaths(cwd, agentDir).globalModelsFile;
		writeJson(path, {
			providers: {
				openai: {
					models: [{ id: "gpt-4.1", name: "GPT" }],
				},
				anthropic: {
					resourceId: "provider-existing",
					models: [{ resourceId: "model-existing", id: "claude", name: "Claude" }],
				},
			},
		});
		const ids = ["provider-openai", "model-gpt"];

		const result = ensureModelsResourceIds(path, { createId: () => ids.shift() ?? "unexpected" });

		expect(result.changed).toBe(true);
		expect(result.providerResourceIdsByName.get("openai")).toBe("provider-openai");
		expect(result.modelResourceIdsByProviderAndModel.get("openai:gpt-4.1")).toBe("model-gpt");
		expect(result.providerResourceIdsByName.get("anthropic")).toBe("provider-existing");
		expect(result.modelResourceIdsByProviderAndModel.get("anthropic:claude")).toBe("model-existing");
		expect(readJson(path)).toEqual({
			providers: {
				openai: {
					models: [{ id: "gpt-4.1", name: "GPT", resourceId: "model-gpt" }],
					resourceId: "provider-openai",
				},
				anthropic: {
					resourceId: "provider-existing",
					models: [{ resourceId: "model-existing", id: "claude", name: "Claude" }],
				},
			},
		});
	});
});
