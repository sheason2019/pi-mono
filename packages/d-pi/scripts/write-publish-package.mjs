import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultPackageRoot = dirname(scriptDir);

export function createPublishPackageJson(sourcePackage) {
	return {
		name: sourcePackage.name,
		version: sourcePackage.version,
		description: sourcePackage.description,
		type: "module",
		bin: {
			"d-pi": "cli.js",
		},
		keywords: sourcePackage.keywords,
		author: sourcePackage.author,
		license: sourcePackage.license,
		repository: sourcePackage.repository,
		engines: sourcePackage.engines,
		dependencies: sourcePackage.dependencies,
	};
}

export function writePublishPackage(options = {}) {
	const packageRoot = options.packageRoot ?? defaultPackageRoot;
	const distDir = options.distDir ?? join(packageRoot, "dist");
	const sourcePackage = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
	const publishPackage = createPublishPackageJson(sourcePackage);

	mkdirSync(distDir, { recursive: true });
	writeFileSync(join(distDir, "package.json"), `${JSON.stringify(publishPackage, null, "\t")}\n`);

	for (const fileName of ["README.md", "README.zh-CN.md"]) {
		const sourcePath = join(packageRoot, fileName);
		if (existsSync(sourcePath)) {
			copyFileSync(sourcePath, join(distDir, fileName));
		}
	}
}

if (import.meta.url === `file://${process.argv[1]}`) {
	writePublishPackage();
}
