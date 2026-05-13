import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPublishPackageJson, writePublishPackage } from "../scripts/write-publish-package.mjs";

const packageRoot = join(import.meta.dirname, "..");
const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function readSourceFiles(dir: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(dir)) {
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) {
			files.push(...readSourceFiles(path));
			continue;
		}
		if (path.endsWith(".ts")) {
			files.push(path);
		}
	}
	return files;
}

describe("d-pi package distribution", () => {
	it("uses rspack for the distributable CLI build", () => {
		const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
			bin?: Record<string, string>;
			dependencies?: Record<string, string>;
			devDependencies?: Record<string, string>;
			main?: string;
			private?: boolean;
			scripts?: Record<string, string>;
			types?: string;
		};

		expect(pkg.private).toBe(true);
		expect(pkg.main).toBeUndefined();
		expect(pkg.types).toBeUndefined();
		expect(pkg.devDependencies ?? {}).toHaveProperty("@rspack/core");
		expect(pkg.devDependencies ?? {}).toHaveProperty("@rspack/cli");
		expect(pkg.devDependencies ?? {}).not.toHaveProperty("@rslib/core");
		expect(pkg.bin?.["d-pi"]).toBe("dist/cli.cjs");
		expect(pkg.scripts?.build).toContain("build:deps");
		expect(pkg.scripts?.build).toContain("rspack");
		expect(pkg.scripts?.build).toContain("chmod +x dist/cli.cjs");
		expect(pkg.scripts?.build).toContain("write-publish-package.mjs");
		expect(pkg.scripts?.["build:deps"]).toContain("npm --prefix ../tui run build");
		expect(pkg.scripts?.["build:deps"]).toContain("npm --prefix ../ai run build");
		expect(pkg.scripts?.["build:deps"]).toContain("npm --prefix ../coding-agent run build");
		expect(pkg.scripts?.["publish:dry"]).toContain("cd dist && npm pack --dry-run");
		expect(pkg.scripts?.["publish:dist"]).toContain("cd dist && npm publish --access public");
		expect(pkg.scripts?.build).not.toContain("rslib");
		expect(pkg.scripts?.build).not.toContain("tsgo");
	});

	it("generates a minimal publish manifest for the dist package", () => {
		const sourcePackage = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
		const manifest = createPublishPackageJson(sourcePackage);

		expect(manifest.name).toBe("@sheason/d-pi");
		expect(manifest.bin).toEqual({ "d-pi": "cli.cjs" });
		expect(manifest.private).toBeUndefined();
		expect(manifest.dependencies).toEqual({
			"@libsql/client": "^0.17.3",
			"@node-rs/jieba": "^2.0.1",
			"socket.io-client": "^4.8.3",
		});
		expect(manifest.dependencies).not.toHaveProperty("better-sqlite3");
		expect(manifest.dependencies).not.toHaveProperty("drizzle-orm");
		expect(manifest.devDependencies).toBeUndefined();
		expect(manifest.scripts).toBeUndefined();
		expect(manifest.type).toBeUndefined();
		expect(manifest.files).toBeUndefined();

		const distDir = mkdtempSync(join(tmpdir(), "d-pi-publish-dist-"));
		tempDirs.push(distDir);
		writePublishPackage({ packageRoot, distDir });
		const written = JSON.parse(readFileSync(join(distDir, "package.json"), "utf8"));
		expect(written).toEqual(manifest);
	});

	it("does not bake source checkout paths into the generated bundle", () => {
		const cliBundle = join(packageRoot, "dist", "cli.cjs");
		if (!existsSync(cliBundle) || !statSync(cliBundle).isFile()) {
			return;
		}
		const bundle = readFileSync(cliBundle, "utf8");

		expect(bundle).not.toContain("/Users/bytedance/workspace/pi-mono");
		expect(bundle).not.toContain("file:///Users/bytedance");
		expect(bundle).not.toContain("packages/d-pi/src");
		expect(bundle).not.toContain("packages/coding-agent/src");
	});

	it("keeps warning cleanup explicit instead of suppressing all warnings", () => {
		const rspackConfig = readFileSync(join(packageRoot, "rspack.config.mjs"), "utf8");

		expect(rspackConfig).not.toContain("ignoreWarnings");
		expect(rspackConfig).toContain("importMetaResolve");
		expect(rspackConfig).toContain("bufferutil");
		expect(rspackConfig).toContain("utf-8-validate");
		expect(rspackConfig).toContain("node_modules\\/jiti\\/lib\\/jiti\\.mjs");
		expect(rspackConfig).toContain("NormalModuleReplacementPlugin");
		expect(rspackConfig).toContain("../ai/dist/env-api-keys.js");
		expect(rspackConfig).toContain("src/shims/env-api-keys-node.js");
		expect(rspackConfig).toContain("coding-agent\\/dist\\/core\\/extensions\\/loader");
	});

	it("uses workspace package outputs instead of sibling source aliases", () => {
		const rspackConfig = readFileSync(join(packageRoot, "rspack.config.mjs"), "utf8");

		for (const sourceAlias of [
			"../agent/src/index.ts",
			"../ai/src/index.ts",
			"../coding-agent/src/index.ts",
			"../tui/src/index.ts",
		]) {
			expect(rspackConfig).not.toContain(sourceAlias);
		}
		expect(rspackConfig).not.toContain("../ai/src/env-api-keys.ts");
	});

	it("copies coding-agent runtime assets from built package outputs", () => {
		const rspackConfig = readFileSync(join(packageRoot, "rspack.config.mjs"), "utf8");

		expect(rspackConfig).toContain("../coding-agent/dist/modes/interactive/theme");
		expect(rspackConfig).toContain("dist/modes/interactive/theme");
		expect(rspackConfig).toContain("../coding-agent/dist/core/export-html");
		expect(rspackConfig).toContain("dist/core/export-html");
	});

	it("keeps the workspace lockfile bin metadata aligned with the package", () => {
		const lockfile = JSON.parse(readFileSync(join(packageRoot, "..", "..", "package-lock.json"), "utf8")) as {
			packages?: Record<string, { bin?: Record<string, string> }>;
		};

		expect(lockfile.packages?.["packages/d-pi"]?.bin?.["d-pi"]).toBe("dist/cli.cjs");
	});

	it("lets rspack handle the Node ESM bundle boundary directly", () => {
		const config = readFileSync(join(packageRoot, "rspack.config.mjs"), "utf8");

		expect(config).not.toContain("builtinModules");
		expect(config).not.toContain("externalsType");
		expect(config).not.toContain("node-commonjs");
	});

	it("injects version and runtime asset roots through the bundle boundary", () => {
		const config = readFileSync(join(packageRoot, "rspack.config.mjs"), "utf8");
		const versionSource = readFileSync(join(packageRoot, "src", "version.ts"), "utf8");
		const socketServerSource = readFileSync(
			join(packageRoot, "src", "hub", "transport", "socket-hub-server.ts"),
			"utf8",
		);
		const skillsSource = readFileSync(join(packageRoot, "src", "skills", "install-built-ins.ts"), "utf8");

		expect(config).toContain("__D_PI_VERSION__");
		expect(config).toContain("__D_PI_BUNDLE_DIR__");
		expect(versionSource).not.toContain("package.json");
		expect(versionSource).not.toContain("import.meta.url");
		expect(socketServerSource).not.toContain("fileURLToPath(import.meta.url)");
		expect(skillsSource).not.toContain("fileURLToPath(import.meta.url)");
	});

	it("does not expose internal monorepo packages as runtime dependencies", () => {
		const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
			dependencies?: Record<string, string>;
			bundledDependencies?: string[];
		};

		for (const packageName of [
			"@earendil-works/pi-agent-core",
			"@earendil-works/pi-ai",
			"@earendil-works/pi-coding-agent",
			"@mariozechner/pi-skill",
			"@earendil-works/pi-tui",
			"@sheason/d-pi-web-ui",
		]) {
			expect(pkg.dependencies ?? {}).not.toHaveProperty(packageName);
			expect(pkg.bundledDependencies ?? []).not.toContain(packageName);
		}
	});

	it("does not reference removed asset-only packages from source", () => {
		for (const file of readSourceFiles(join(packageRoot, "src"))) {
			expect(readFileSync(file, "utf8"), file).not.toContain("@mariozechner/pi-skill");
			expect(readFileSync(file, "utf8"), file).not.toContain("@sheason/d-pi-web-ui");
		}
	});
});
