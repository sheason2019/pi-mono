const EXTENSION_MODULE_ALIASES_ENV = "PI_EXTENSION_MODULE_ALIASES";

export function getDPiPackageEntryPath(): string {
	return new URL(`./index${import.meta.url.endsWith(".ts") ? ".ts" : ".js"}`, import.meta.url).pathname;
}

export function applyDPiExtensionModuleAlias(env: Record<string, string | undefined>): void {
	let aliases: Record<string, string> = {};
	const raw = env[EXTENSION_MODULE_ALIASES_ENV];
	if (raw) {
		try {
			const parsed = JSON.parse(raw) as unknown;
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				aliases = Object.fromEntries(
					Object.entries(parsed).filter(
						(entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0,
					),
				);
			}
		} catch {
			aliases = {};
		}
	}
	aliases["@sheason/d-pi"] = getDPiPackageEntryPath();
	env[EXTENSION_MODULE_ALIASES_ENV] = JSON.stringify(aliases);
}
