import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

declare const __D_PI_BUNDLE_DIR__: string | undefined;
declare const __D_PI_VERSION__: string | undefined;

const sourceRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const sourcePackageRoot = dirname(sourceRoot);

export const D_PI_BUNDLE_DIR = typeof __D_PI_BUNDLE_DIR__ === "string" ? __D_PI_BUNDLE_DIR__ : sourceRoot;
export const D_PI_BUILT_IN_SKILLS_DIR = join(D_PI_BUNDLE_DIR, "skills");
export const D_PI_VERSION = typeof __D_PI_VERSION__ === "string" ? __D_PI_VERSION__ : readSourcePackageVersion();
export const D_PI_WEB_UI_DIST_DIR =
	typeof __D_PI_BUNDLE_DIR__ === "string"
		? join(D_PI_BUNDLE_DIR, "web-ui")
		: join(sourcePackageRoot, "../d-pi-web-ui/dist");

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
