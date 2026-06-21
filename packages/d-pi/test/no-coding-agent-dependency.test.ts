import { opendir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";

const packageRootUrl = new URL("..", import.meta.url);
const packageRoot = fileURLToPath(packageRootUrl);
const scannedDirectories = [
	fileURLToPath(new URL("src", packageRootUrl)),
	fileURLToPath(new URL("test", packageRootUrl)),
];
const scannedFiles = [
	fileURLToPath(new URL("package.json", packageRootUrl)),
	fileURLToPath(new URL("tsconfig.build.json", packageRootUrl)),
	fileURLToPath(new URL("vitest.config.ts", packageRootUrl)),
];
const forbiddenTerms = ["@sheason/" + "pi-" + "coding-" + "agent", "pi-" + "coding-" + "agent"];

async function collectFiles(pathname: string): Promise<string[]> {
	const entries = await opendir(pathname);
	const files: string[] = [];
	for await (const entry of entries) {
		const child = join(pathname, entry.name);
		if (entry.isDirectory()) {
			files.push(...(await collectFiles(child)));
			continue;
		}
		if (entry.isFile()) {
			files.push(child);
		}
	}
	return files;
}

async function expandScannedFiles(): Promise<string[]> {
	const files: string[] = [];
	for (const directory of scannedDirectories) {
		files.push(...(await collectFiles(directory)));
	}
	for (const file of scannedFiles) {
		files.push(file);
	}
	return files.sort();
}

describe("d-pi runtime dependency inventory", () => {
	it("does not depend on the legacy coding agent package", async () => {
		const matches: Array<{ file: string; terms: string[] }> = [];
		for (const file of await expandScannedFiles()) {
			const text = await readFile(file, "utf8");
			const foundTerms = forbiddenTerms.filter((term) => text.includes(term));
			if (foundTerms.length === 0) {
				continue;
			}
			matches.push({
				file: relative(packageRoot, file),
				terms: foundTerms,
			});
		}

		if (matches.length > 0) {
			throw new Error(
				[
					"d-pi must not reference the legacy coding agent package after the remote-first runtime cutover.",
					"Forbidden dependency references found in:",
					...matches.map((match) => `- ${match.file} (${match.terms.join(", ")})`),
				].join("\n"),
			);
		}
	});
});
