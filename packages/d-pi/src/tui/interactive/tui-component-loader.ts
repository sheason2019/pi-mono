import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import dPiMessageComponent from "../../public/d-pi-message.ts";
import type { MessageRenderer } from "../../tui-components/tui-component-definition.ts";
import { isAgentTuiComponentDefinition } from "../../tui-components/tui-component-discovery.ts";

export type DPiMessageRendererRegistry = Record<string, MessageRenderer<unknown>>;

interface TuiComponentsManifest {
	components?: Array<{ name?: string; url?: string }>;
}

export interface LoadDPiConnectTuiComponentsOptions {
	hubUrl: string;
	authHeaders?: Readonly<Record<string, string>>;
	fetch?: typeof fetch;
}

export async function loadDPiConnectTuiComponents(
	options: LoadDPiConnectTuiComponentsOptions,
): Promise<DPiMessageRendererRegistry> {
	const registry: DPiMessageRendererRegistry = {
		[dPiMessageComponent.customType]: dPiMessageComponent.render as MessageRenderer<unknown>,
	};
	const fetchFn = options.fetch ?? fetch;
	const manifestResponse = await fetchFn(`${options.hubUrl.replace(/\/+$/, "")}/_hub/tui-components`, {
		headers: options.authHeaders,
	});
	if (!manifestResponse.ok) {
		return registry;
	}
	const manifest = (await manifestResponse.json()) as TuiComponentsManifest;
	for (const component of manifest.components ?? []) {
		if (typeof component.name !== "string" || typeof component.url !== "string") {
			continue;
		}
		const sourceResponse = await fetchFn(component.url, { headers: options.authHeaders });
		if (!sourceResponse.ok) {
			continue;
		}
		const source = await sourceResponse.text();
		const loaded = await importTuiComponentSource(component.name, source);
		if (loaded) {
			registry[loaded.customType] = loaded.render as MessageRenderer<unknown>;
		}
	}
	return registry;
}

function resolveDPiPackageDir(): string {
	const require = createRequire(import.meta.url);
	try {
		return dirname(require.resolve("@sheason/d-pi/package.json"));
	} catch {
		let current = fileURLToPath(import.meta.url);
		while (current !== dirname(current)) {
			try {
				const pkgPath = join(current, "package.json");
				const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { name?: string };
				if (pkg.name === "@sheason/d-pi") {
					return current;
				}
			} catch {
				// not found, keep going up
			}
			current = dirname(current);
		}
		throw new Error("Could not resolve @sheason/d-pi package directory");
	}
}

async function importTuiComponentSource(
	name: string,
	source: string,
): Promise<
	| {
			customType: string;
			render: MessageRenderer<unknown>;
	  }
	| undefined
> {
	const packageDir = resolveDPiPackageDir();
	const dir = join(packageDir, ".tui-component-cache");
	mkdirSync(dir, { recursive: true });
	const filePath = join(dir, `${safeModuleName(name)}-${Date.now()}-${Math.random().toString(36).slice(2)}.ts`);
	writeFileSync(filePath, source, "utf-8");
	const module = (await import(/* @vite-ignore */ pathToFileURL(filePath).href)) as { default?: unknown };
	return isAgentTuiComponentDefinition(module.default) ? module.default : undefined;
}

function safeModuleName(name: string): string {
	return name.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/\.ts$/, "");
}
