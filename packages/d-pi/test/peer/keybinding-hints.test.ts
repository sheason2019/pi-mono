import { initTheme } from "@sheason/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { buildForkedStartupHelp } from "../../src/peer/tui/forked/components/keybinding-hints.js";
import type { RemoteInteractiveCapabilities } from "../../src/peer/tui/interactive/remote-interactive-capabilities.js";

function createCapabilities(overrides: Partial<RemoteInteractiveCapabilities> = {}): RemoteInteractiveCapabilities {
	return {
		supportsCompact: true,
		supportsReload: true,
		supportsModelSelection: true,
		supportsSessionTree: false,
		supportsSessionCreation: false,
		supportsSessionResume: false,
		supportsSessionFork: false,
		supportsSessionClone: false,
		...overrides,
	};
}

describe("forked keybinding hints", () => {
	it("omits unsupported model and reload hints from startup help", () => {
		initTheme();
		const help = buildForkedStartupHelp(
			createCapabilities({
				supportsModelSelection: false,
				supportsReload: false,
			}),
		);

		expect(help.expanded).not.toContain("select model");
		expect(help.expanded).not.toContain("reload");
		expect(help.compact).not.toContain("model");
		expect(help.compact).not.toContain("reload");
		expect(help.expanded).toContain("interrupt");
		expect(help.compact).toContain("commands");
	});
});
