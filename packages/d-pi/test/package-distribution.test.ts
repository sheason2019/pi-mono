import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
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
	it("uses tsgo for the distributable CLI build", () => {
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
		expect(pkg.devDependencies ?? {}).not.toHaveProperty("@rspack/core");
		expect(pkg.devDependencies ?? {}).not.toHaveProperty("@rspack/cli");
		expect(pkg.bin?.["d-pi"]).toBe("dist/cli.js");
		expect(pkg.scripts?.build).toContain("build:deps");
		expect(pkg.scripts?.build).toContain("tsgo -p tsconfig.build.json");
		expect(pkg.scripts?.build).toContain("chmod +x dist/cli.js");
		expect(pkg.scripts?.build).toContain("copy-assets");
		expect(pkg.scripts?.build).toContain("write-publish-package.mjs");
		expect(pkg.scripts?.["build:deps"]).toContain("npm --prefix ../tui run build");
		expect(pkg.scripts?.["build:deps"]).toContain("npm --prefix ../ai run build");
		expect(pkg.scripts?.["build:deps"]).toContain("npm --prefix ../coding-agent run build");
		expect(pkg.scripts?.["publish:dry"]).toContain("cd dist && npm pack --dry-run");
		expect(pkg.scripts?.["publish:dist"]).toContain("cd dist && npm publish --access public");
	});

	it("generates a publish manifest for the dist package", () => {
		const sourcePackage = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
		const manifest = createPublishPackageJson(sourcePackage);

		expect(manifest.name).toBe("@sheason/d-pi");
		expect(manifest.type).toBe("module");
		expect(manifest.bin).toEqual({ "d-pi": "cli.js" });
		expect(manifest.private).toBeUndefined();
		expect(manifest.dependencies).toHaveProperty("@sheason/pi-ai");
		expect(manifest.dependencies).toHaveProperty("@sheason/pi-coding-agent");
		expect(manifest.dependencies).toHaveProperty("@earendil-works/pi-agent-core");
		expect(manifest.dependencies).toHaveProperty("@earendil-works/pi-tui");
		expect(manifest.devDependencies).toBeUndefined();
		expect(manifest.scripts).toBeUndefined();
		expect(manifest.files).toBeUndefined();

		const distDir = mkdtempSync(join(tmpdir(), "d-pi-publish-dist-"));
		tempDirs.push(distDir);
		writePublishPackage({ packageRoot, distDir });
		const written = JSON.parse(readFileSync(join(distDir, "package.json"), "utf8"));
		expect(written).toEqual(manifest);
	});

	it("exposes upstream packages as runtime dependencies", () => {
		const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
			dependencies?: Record<string, string>;
		};

		expect(pkg.dependencies ?? {}).toHaveProperty("@sheason/pi-ai");
		expect(pkg.dependencies ?? {}).toHaveProperty("@sheason/pi-coding-agent");
		expect(pkg.dependencies ?? {}).toHaveProperty("@earendil-works/pi-agent-core");
		expect(pkg.dependencies ?? {}).toHaveProperty("@earendil-works/pi-tui");
	});

	it("does not reference removed asset-only packages from source", () => {
		for (const file of readSourceFiles(join(packageRoot, "src"))) {
			expect(readFileSync(file, "utf8"), file).not.toContain("@mariozechner/pi-skill");
			expect(readFileSync(file, "utf8"), file).not.toContain("@sheason/d-pi-web-ui");
		}
	});

	it("resolves runtime paths from import.meta.url instead of DefinePlugin injections", () => {
		const bundleEnvSource = readFileSync(join(packageRoot, "src", "runtime", "bundle-env.ts"), "utf8");

		expect(bundleEnvSource).not.toContain("__D_PI_BUNDLE_DIR__");
		expect(bundleEnvSource).not.toContain("__D_PI_VERSION__");
		expect(bundleEnvSource).toContain("import.meta.url");
	});

	it("keeps the workspace lockfile bin metadata aligned with the package", () => {
		const lockfile = JSON.parse(readFileSync(join(packageRoot, "..", "..", "package-lock.json"), "utf8")) as {
			packages?: Record<string, { bin?: Record<string, string> }>;
		};

		expect(lockfile.packages?.["packages/d-pi"]?.bin?.["d-pi"]).toBe("dist/cli.js");
	});
});
