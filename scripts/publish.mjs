#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The d-pi release pipeline only publishes @sheason/* scoped packages. The
// upstream @earendil-works/* packages (pi-ai, pi-tui, pi-agent-core) are
// runtime dependencies of @sheason/d-pi and @sheason/pi-coding-agent, but
// they are published by upstream pi-mono to the public npm registry, not
// by this fork. We have no npm publish permission to the @earendil-works
// scope, so including them here would always fail.
const packages = [
	{ directory: "packages/coding-agent", name: "@sheason/pi-coding-agent" },
	{ directory: "packages/d-pi", name: "@sheason/d-pi" },
];

const dPiPackageName = "@sheason/d-pi";
const codingAgentPackageName = "@sheason/pi-coding-agent";

const dryRun = process.argv.includes("--dry-run");
const unknownArgs = process.argv.slice(2).filter((arg) => arg !== "--dry-run");

if (unknownArgs.length > 0) {
	console.error(`Usage: node scripts/publish.mjs [--dry-run]`);
	process.exit(1);
}

const SEMVER_RE = /^\d+\.\d+\.\d+(-[A-Za-z0-9.-]+)?(\+[A-Za-z0-9.-]+)?$/;

function commandForPlatform(command) {
	return process.platform === "win32" ? `${command}.cmd` : command;
}

function run(command, args, options = {}) {
	console.log(`$ ${[command, ...args].join(" ")}`);
	const result = spawnSync(commandForPlatform(command), args, {
		cwd: options.cwd,
		encoding: "utf8",
		stdio: options.capture ? ["inherit", "pipe", "pipe"] : "inherit",
	});

	if (result.status !== 0) {
		const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
		throw new Error(output ? `Command failed: ${command} ${args.join(" ")}\n${output}` : `Command failed: ${command} ${args.join(" ")}`);
	}

	return result;
}

function readPackageJson(directory) {
	return JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
}

function assertBuildOutputExists(directory) {
	if (!existsSync(join(directory, "dist"))) {
		throw new Error(`${directory}/dist does not exist. Run npm run build before publishing.`);
	}
}

function validatePack(directory) {
	const result = run("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], { capture: true, cwd: directory });
	const packed = JSON.parse(result.stdout)[0];
	console.log(`  ${packed.filename}: ${packed.files.length} files, ${packed.size} bytes packed, ${packed.unpackedSize} bytes unpacked`);
}

function isPublished(name, version) {
	const result = spawnSync(commandForPlatform("npm"), ["view", `${name}@${version}`, "version", "--json"], {
		encoding: "utf8",
		stdio: ["inherit", "pipe", "pipe"],
	});

	if (result.status === 0 && result.stdout.trim()) {
		return true;
	}

	const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
	if (result.status !== 0 && (output.includes("E404") || output.includes("404 Not Found"))) {
		return false;
	}

	throw new Error(output ? `Failed to query ${name}@${version}\n${output}` : `Failed to query ${name}@${version}`);
}

function useProvenance() {
	return process.env.GITHUB_ACTIONS === "true";
}

function assertReleaseVersions(packageVersions) {
	const dPiVersion = packageVersions.get(dPiPackageName);
	if (!dPiVersion) {
		throw new Error(`${dPiPackageName} version is missing`);
	}

	const codingAgentVersion = packageVersions.get(codingAgentPackageName);
	if (!codingAgentVersion) {
		throw new Error(`${codingAgentPackageName} version is missing`);
	}

	// The two @sheason/* packages are versioned independently. The fork
	// bumped them lockstep in the v0.78.x → v0.79.x sync (the coding-agent
	// version ended with `-sheason.<d-pi-version>` to prove the pairing)
	// but that suffix was only meaningful while we also published the
	// upstream @earendil-works/* packages under the same release train.
	// Now that the upstream packages are no longer in this pipeline, the
	// lockstep requirement is gone; each package is released on its own
	// cadence. We still sanity-check that both versions parse as semver
	// so the caller gets a clear error if either is malformed.

	if (!SEMVER_RE.test(dPiVersion)) {
		throw new Error(`${dPiPackageName} version ${dPiVersion} is not semver`);
	}
	if (!SEMVER_RE.test(codingAgentVersion)) {
		throw new Error(`${codingAgentPackageName} version ${codingAgentVersion} is not semver`);
	}

	return { dPiVersion, codingAgentVersion };
}

const packageVersions = new Map();
for (const pkg of packages) {
	const packageJson = readPackageJson(pkg.directory);
	if (packageJson.name !== pkg.name) {
		throw new Error(`${pkg.directory}/package.json has name ${packageJson.name}, expected ${pkg.name}`);
	}
	packageVersions.set(pkg.name, packageJson.version);
}

const { dPiVersion, codingAgentVersion } = assertReleaseVersions(packageVersions);

console.log(
	`Publishing ${codingAgentPackageName} at ${codingAgentVersion} and ${dPiPackageName} at ${dPiVersion}${dryRun ? " (dry run)" : ""}\n`,
);

for (const pkg of packages) {
	const version = packageVersions.get(pkg.name);
	assertBuildOutputExists(pkg.directory);
	const published = isPublished(pkg.name, version);

	if (dryRun) {
		if (published) {
			console.log(`${pkg.name}@${version} is already published; validating package contents only.`);
		} else {
			console.log(`${pkg.name}@${version} is not published; validating package contents before publish.`);
		}
		validatePack(pkg.directory);
		console.log();
		continue;
	}

	if (published) {
		console.log(`Skipping ${pkg.name}@${version}: already published\n`);
		continue;
	}

	const publishArgs = ["publish", "--access", "public", "--ignore-scripts"];
	if (useProvenance()) {
		publishArgs.push("--provenance");
	}
	run("npm", publishArgs, { cwd: pkg.directory });
	console.log();
}
