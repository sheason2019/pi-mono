import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { createEventBus } from "../../core/event-bus.ts";
import type { LoadExtensionsResult } from "../../core/extensions/index.ts";
import { loadExtensions } from "../../core/extensions/loader.ts";

export interface RemoteClientExtensionFile {
	path: string;
	content: string;
}

export interface RemoteClientExtensionBundle {
	path: string;
	entry: string;
	files: RemoteClientExtensionFile[];
}

function assertSafeRelativePath(path: string): void {
	if (!path || path.startsWith("/") || path === ".." || path.startsWith(`..${sep}`) || path.startsWith("../")) {
		throw new Error(`Unsafe remote extension file path: ${path}`);
	}
}

function resolveBundlePath(bundleDir: string, path: string): string {
	assertSafeRelativePath(path);
	const resolvedPath = resolve(bundleDir, path);
	const relativePath = relative(bundleDir, resolvedPath);
	assertSafeRelativePath(relativePath);
	return resolvedPath;
}

function writeBundle(bundle: RemoteClientExtensionBundle, baseDir: string): string {
	const bundleDir = join(baseDir, encodeURIComponent(bundle.path));
	mkdirSync(bundleDir, { recursive: true });
	for (const file of bundle.files) {
		const filePath = resolveBundlePath(bundleDir, file.path);
		mkdirSync(dirname(filePath), { recursive: true });
		writeFileSync(filePath, file.content, { flag: "w" });
	}
	const originalEntry = resolveBundlePath(bundleDir, bundle.entry);
	const shimPath = join(bundleDir, ".pi-client-entry.mjs");
	const importPath = `./${relative(dirname(shimPath), originalEntry).split(sep).join("/")}`;
	writeFileSync(shimPath, `import { client } from ${JSON.stringify(importPath)};\nexport default client;\n`, {
		flag: "w",
	});
	return shimPath;
}

export async function loadRemoteClientExtensions(url: string, cwd: string): Promise<LoadExtensionsResult> {
	const response = await fetch(`${url}/client-extensions`);
	if (!response.ok) {
		throw new Error(`Failed to load client extensions: ${response.status} ${response.statusText}`);
	}
	const bundles = (await response.json()) as RemoteClientExtensionBundle[];
	const syncDir = mkdtempSync(join(tmpdir(), "pi-remote-client-extensions-"));
	const entryPaths = bundles.map((bundle) => writeBundle(bundle, syncDir));
	const result = await loadExtensions(entryPaths, resolve(cwd), createEventBus());
	for (const extension of result.extensions) {
		const matchingBundle = bundles.find((bundle) =>
			extension.resolvedPath.startsWith(join(syncDir, encodeURIComponent(bundle.path))),
		);
		if (matchingBundle) {
			extension.path = `<remote-client:${matchingBundle.path}>`;
		}
	}
	return result;
}
