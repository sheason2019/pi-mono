import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function readJson(relativePath) {
	return JSON.parse(readFileSync(join(repoRoot, relativePath), "utf8"));
}

function readText(relativePath) {
	return readFileSync(join(repoRoot, relativePath), "utf8");
}

describe("sheason release metadata", () => {
	test("uses d-pi as the only publishable workspace package", () => {
		const rootPackage = readJson("package.json");
		const dPi = readJson("packages/d-pi/package.json");

		assert.deepEqual(rootPackage.workspaces, ["packages/d-pi"]);
		assert.equal(dPi.name, "@sheason/d-pi");
		assert.equal(dPi.dependencies["@earendil-works/pi-agent-core"], "0.78.0");
		assert.equal(dPi.dependencies["@earendil-works/pi-ai"], "0.78.0");
		assert.equal(dPi.dependencies["@earendil-works/pi-tui"], "0.78.0");
		assert.equal(dPi.dependencies[["@sheason", "pi-coding-agent"].join("/")], undefined);
	});

	test("uses npm provenance only in supported CI providers", () => {
		const publishScript = readText("scripts/publish.mjs");

		assert.match(publishScript, /useProvenance/);
		assert.match(publishScript, /GITHUB_ACTIONS/);
		assert.match(publishScript, /publishArgs\.push\("--provenance"\)/);
		assert.doesNotMatch(publishScript, /\["publish", "--access", "public", "--provenance", "--ignore-scripts"\]/);
	});

	test("keeps workspace aliases and publish scripts aligned with d-pi-only packaging", () => {
		const rootPackage = readJson("package.json");
		const tsconfig = readJson("tsconfig.json");
		const dPiTsconfig = readJson("packages/d-pi/tsconfig.build.json");
		const publishScript = readText("scripts/publish.mjs");
		const localReleaseScript = readText("scripts/local-release.mjs");

		assert.deepEqual(tsconfig.compilerOptions.paths, {
			"*": ["./*"],
			typebox: ["./node_modules/typebox"],
		});
		assert.equal(dPiTsconfig.compilerOptions.paths, undefined);

		assert.doesNotMatch(publishScript, /@sheason\/pi-coding-agent/);
		assert.match(publishScript, /@sheason\/d-pi/);
		assert.doesNotMatch(localReleaseScript, /@sheason\/pi-coding-agent/);
		assert.match(localReleaseScript, /@sheason\/d-pi/);
		assert.match(rootPackage.scripts.build, /d-pi/);
	});
});
