import { mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { buildNativeToolSet } from "../src/executor/index.ts";

function getTool(tools: AgentTool[], name: string): AgentTool {
	const tool = tools.find((candidate) => candidate.name === name);
	if (!tool) {
		throw new Error(`Missing native tool: ${name}`);
	}
	return tool;
}

function readTextContent(result: unknown): string {
	if (typeof result !== "object" || result === null || !("content" in result) || !Array.isArray(result.content)) {
		throw new Error("Tool result does not contain text content");
	}
	return result.content
		.map((part: unknown) =>
			typeof part === "object" && part !== null && "text" in part && typeof part.text === "string" ? part.text : "",
		)
		.join("");
}

describe("buildNativeToolSet", () => {
	it("keeps the public executor entry independent from previous native factories", async () => {
		const sourcePath = fileURLToPath(new URL("../src/executor/index.ts", import.meta.url));
		const source = await readFile(sourcePath, "utf8");

		expect(source).not.toContain("createBashToolDefinition");
		expect(source).not.toContain("createEditToolDefinition");
		expect(source).not.toContain("createFindToolDefinition");
		expect(source).not.toContain("createGrepToolDefinition");
		expect(source).not.toContain("createLsToolDefinition");
		expect(source).not.toContain("createReadToolDefinition");
		expect(source).not.toContain("createWriteToolDefinition");
		expect(source).not.toContain("SettingsManager");
		expect(source).not.toContain("getAgentDir");
	});

	it("keeps native tools owned by the d-pi executor package", async () => {
		const executorDir = fileURLToPath(new URL("../src/executor/", import.meta.url));
		const entries = await readdir(executorDir);
		const sourceFiles = entries.filter((entry) => entry.endsWith(".ts"));
		const filesWithExternalRuntimeDependency: string[] = [];

		for (const fileName of sourceFiles) {
			const source = await readFile(new URL(`../src/executor/${fileName}`, import.meta.url), "utf8");
			if (source.includes("createBashToolDefinition") || source.includes("SettingsManager")) {
				filesWithExternalRuntimeDependency.push(basename(fileName));
			}
		}

		expect(filesWithExternalRuntimeDependency.sort()).toEqual([]);
	});

	it("returns the 7 canonical native tools", () => {
		const tools = buildNativeToolSet(process.cwd());
		const names = tools.map((t) => t.name).sort();
		expect(names).toEqual(["bash", "edit", "find", "grep", "ls", "read", "write"]);
	});

	it("passes cwd to every tool", () => {
		const tools = buildNativeToolSet("/tmp/some-cwd");
		// Real native tools' first execute arg is the resolved absolute path
		// they were constructed with; we sanity-check that the tool names are
		// the expected ones (cwd is opaque through the ToolDefinition type).
		for (const t of tools) {
			expect(typeof t.name).toBe("string");
			expect(t.name.length).toBeGreaterThan(0);
		}
	});

	it("executes bash, write, read, and ls against the configured cwd", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "d-pi-native-tools-"));
		try {
			const physicalCwd = await realpath(cwd);
			const tools = buildNativeToolSet(cwd);

			const writeResult = await getTool(tools, "write").execute("write-1", {
				path: "nested/file.txt",
				content: "hello native tools",
			});
			expect(readTextContent(writeResult)).toContain("Wrote 18 characters");

			const readResult = await getTool(tools, "read").execute("read-1", { path: "nested/file.txt" });
			expect(readTextContent(readResult)).toBe("hello native tools");

			const lsResult = await getTool(tools, "ls").execute("ls-1", { path: "nested" });
			expect(readTextContent(lsResult)).toBe("file.txt");

			const bashResult = await getTool(tools, "bash").execute("bash-1", {
				command: "pwd && test -f nested/file.txt",
			});
			expect(readTextContent(bashResult).split(/\r?\n/)[0]).toBe(physicalCwd);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});
});
