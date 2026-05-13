import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findEnvKeys as findBrowserEnvKeys, getEnvApiKey as getBrowserEnvApiKey } from "../src/env-api-keys.browser.js";

const sourcePath = join(import.meta.dirname, "..", "src", "env-api-keys.ts");
const packageJsonPath = join(import.meta.dirname, "..", "package.json");

describe("env API key detection", () => {
	it("uses top-level Node builtin imports instead of dynamic specifier imports", () => {
		const source = readFileSync(sourcePath, "utf8");

		expect(source).toContain('from "node:fs"');
		expect(source).toContain('from "node:os"');
		expect(source).toContain('from "node:path"');
		expect(source).not.toContain('"node:" + "fs"');
		expect(source).not.toContain("import(specifier)");
	});

	it("maps the Node env key implementation to a browser-safe entry", () => {
		const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
			browser?: Record<string, string>;
		};

		expect(packageJson.browser?.["./dist/env-api-keys.js"]).toBe("./dist/env-api-keys.browser.js");
		expect(findBrowserEnvKeys("openai")).toBeUndefined();
		expect(getBrowserEnvApiKey("openai")).toBeUndefined();
	});
});
