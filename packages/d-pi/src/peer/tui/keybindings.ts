import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as PiCodingAgent from "@sheason/pi-coding-agent";
import type { Keybinding, KeybindingDefinitions, KeybindingsConfig, KeyId } from "@sheason/pi-tui";

declare module "@sheason/pi-tui" {
	interface Keybindings {
		"app.connection.retry": true;
	}
}

const D_PI_KEYBINDINGS = {
	...PiCodingAgent.KEYBINDINGS,
	"app.connection.retry": {
		defaultKeys: "ctrl+r",
		description: "Retry remote connection",
	},
} as const satisfies KeybindingDefinitions;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toKeybindingsConfig(value: unknown): KeybindingsConfig {
	if (!isRecord(value)) {
		return {};
	}

	const config: KeybindingsConfig = {};
	for (const [key, binding] of Object.entries(value)) {
		if (typeof binding === "string") {
			config[key] = binding as KeyId;
			continue;
		}
		if (Array.isArray(binding) && binding.every((entry) => typeof entry === "string")) {
			config[key] = binding as KeyId[];
		}
	}
	return config;
}

function loadRawConfig(path: string): Record<string, unknown> | undefined {
	if (!existsSync(path)) {
		return undefined;
	}
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
		return isRecord(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

export class KeybindingsManager extends PiCodingAgent.KeybindingsManager {
	constructor(userBindings: KeybindingsConfig = {}, configPath?: string) {
		super(userBindings, configPath);
		(this as unknown as { definitions: KeybindingDefinitions }).definitions = D_PI_KEYBINDINGS;
		this.setUserBindings(userBindings);
	}

	static create(agentDir: string = PiCodingAgent.getAgentDir()): KeybindingsManager {
		const configPath = join(agentDir, "keybindings.json");
		const userBindings = KeybindingsManager.loadDpiFromFile(configPath);
		return new KeybindingsManager(userBindings, configPath);
	}

	private static loadDpiFromFile(path: string): KeybindingsConfig {
		const rawConfig = loadRawConfig(path);
		if (!rawConfig) {
			return {};
		}
		return toKeybindingsConfig(PiCodingAgent.migrateKeybindingsConfig(rawConfig).config);
	}
}

export type { Keybinding, KeyId, KeybindingsConfig };
