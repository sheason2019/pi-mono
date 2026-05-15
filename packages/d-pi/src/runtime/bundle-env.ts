import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const sourceRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const sourcePackageRoot = dirname(sourceRoot);

export const D_PI_BUNDLE_DIR = sourceRoot;
export const D_PI_BUILT_IN_SKILLS_DIR = join(D_PI_BUNDLE_DIR, "skills");
export const D_PI_VERSION = readSourcePackageVersion();
export const D_PI_WEB_UI_DIST_DIR = join(D_PI_BUNDLE_DIR, "web-ui");

function readSourcePackageVersion(): string {
	try {
		const packageJson = JSON.parse(readFileSync(join(sourcePackageRoot, "package.json"), "utf8")) as {
			version?: unknown;
		};
		return typeof packageJson.version === "string" ? packageJson.version : "0.0.0-dev";
	} catch {
		return "0.0.0-dev";
	}
}
