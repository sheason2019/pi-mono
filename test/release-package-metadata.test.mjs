import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const combinedVersion = "0.78.0-sheason.0.6.0-alpha.1";
const dPiVersion = "0.6.0-alpha.1";

function readJson(relativePath) {
	return JSON.parse(readFileSync(join(repoRoot, relativePath), "utf8"));
}

function readText(relativePath) {
	return readFileSync(join(repoRoot, relativePath), "utf8");
}

describe("sheason release metadata", () => {
	test("uses sheason package names and release versions for the release set", () => {
		const ai = readJson("packages/ai/package.json");
		const agent = readJson("packages/agent/package.json");
		const tui = readJson("packages/tui/package.json");
		const codingAgent = readJson("packages/coding-agent/package.json");
		const dPi = readJson("packages/d-pi/package.json");

		assert.equal(ai.name, "@sheason/pi-ai");
		assert.equal(ai.version, combinedVersion);
		assert.equal(agent.name, "@sheason/pi-agent-core");
		assert.equal(agent.version, combinedVersion);
		assert.equal(tui.name, "@sheason/pi-tui");
		assert.equal(tui.version, combinedVersion);
		assert.equal(codingAgent.name, "@sheason/pi-coding-agent");
		assert.equal(codingAgent.version, combinedVersion);
		assert.equal(dPi.name, "@sheason/d-pi");
		assert.equal(dPi.version, dPiVersion);

		assert.equal(agent.dependencies["@sheason/pi-ai"], combinedVersion);
		assert.equal(codingAgent.dependencies["@sheason/pi-agent-core"], combinedVersion);
		assert.equal(codingAgent.dependencies["@sheason/pi-ai"], combinedVersion);
		assert.equal(codingAgent.dependencies["@sheason/pi-tui"], combinedVersion);
		assert.equal(dPi.dependencies["@sheason/pi-agent-core"], combinedVersion);
		assert.equal(dPi.dependencies["@sheason/pi-ai"], combinedVersion);
		assert.equal(dPi.dependencies["@sheason/pi-coding-agent"], combinedVersion);
		assert.equal(dPi.dependencies["@sheason/pi-tui"], combinedVersion);
	});

	test("keeps pi packages lockstep while allowing d-pi to use its own embedded version", () => {
		const ai = readJson("packages/ai/package.json");
		const agent = readJson("packages/agent/package.json");
		const tui = readJson("packages/tui/package.json");
		const codingAgent = readJson("packages/coding-agent/package.json");
		const dPi = readJson("packages/d-pi/package.json");
		const publishScript = readText("scripts/publish.mjs");

		const piVersions = new Set([ai.version, agent.version, tui.version, codingAgent.version]);
		assert.deepEqual([...piVersions], [combinedVersion]);
		assert.equal(combinedVersion, `0.78.0-sheason.${dPi.version}`);
		assert.equal(dPi.version, dPiVersion);
		assert.match(publishScript, /assertReleaseVersions/);
		assert.doesNotMatch(publishScript, /Publish packages are not lockstep versioned/);
	});

	test("keeps workspace aliases and publish scripts aligned with renamed packages", () => {
		const rootPackage = readJson("package.json");
		const tsconfig = readJson("tsconfig.json");
		const codingAgentTsconfig = readJson("packages/coding-agent/tsconfig.build.json");
		const dPiTsconfig = readJson("packages/d-pi/tsconfig.build.json");
		const publishScript = readText("scripts/publish.mjs");
		const localReleaseScript = readText("scripts/local-release.mjs");

		assert.ok(tsconfig.compilerOptions.paths["@sheason/pi-ai"]);
		assert.ok(tsconfig.compilerOptions.paths["@sheason/pi-agent-core"]);
		assert.ok(tsconfig.compilerOptions.paths["@sheason/pi-coding-agent"]);
		assert.ok(tsconfig.compilerOptions.paths["@sheason/pi-tui"]);
		assert.ok(codingAgentTsconfig.compilerOptions.paths["@sheason/pi-agent-core"]);
		assert.ok(codingAgentTsconfig.compilerOptions.paths["@sheason/pi-ai"]);
		assert.ok(codingAgentTsconfig.compilerOptions.paths["@sheason/pi-tui"]);
		assert.ok(dPiTsconfig.compilerOptions.paths["@sheason/pi-agent-core"]);
		assert.ok(dPiTsconfig.compilerOptions.paths["@sheason/pi-ai"]);
		assert.ok(dPiTsconfig.compilerOptions.paths["@sheason/pi-coding-agent"]);
		assert.ok(dPiTsconfig.compilerOptions.paths["@sheason/pi-tui"]);

		assert.match(publishScript, /@sheason\/pi-ai/);
		assert.match(publishScript, /@sheason\/pi-agent-core/);
		assert.match(publishScript, /@sheason\/pi-coding-agent/);
		assert.match(publishScript, /@sheason\/pi-tui/);
		assert.match(publishScript, /@sheason\/d-pi/);
		assert.match(localReleaseScript, /@sheason\/pi-ai/);
		assert.match(localReleaseScript, /@sheason\/pi-agent-core/);
		assert.match(localReleaseScript, /@sheason\/pi-coding-agent/);
		assert.match(localReleaseScript, /@sheason\/pi-tui/);
		assert.match(localReleaseScript, /@sheason\/d-pi/);
		assert.match(rootPackage.scripts.build, /d-pi/);
	});
});
