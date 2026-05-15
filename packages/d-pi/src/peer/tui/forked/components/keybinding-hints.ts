import { getKeybindings, type Keybinding, type KeyId } from "@sheason/pi-tui";
import { theme } from "../../components/index.js";
import type { RemoteInteractiveCapabilities } from "../../interactive/remote-interactive-capabilities.js";

function formatKeys(keys: KeyId[]): string {
	if (keys.length === 0) return "";
	if (keys.length === 1) return keys[0]!;
	return keys.join("/");
}

export function keyText(keybinding: Keybinding): string {
	return formatKeys(getKeybindings().getKeys(keybinding));
}

export function keyHint(keybinding: Keybinding, description: string): string {
	return theme.fg("dim", keyText(keybinding)) + theme.fg("muted", ` ${description}`);
}

export function rawKeyHint(key: string, description: string): string {
	return theme.fg("dim", key) + theme.fg("muted", ` ${description}`);
}

export interface ForkedStartupHelp {
	compact: string;
	expanded: string;
}

export function buildForkedStartupHelp(
	capabilities: Pick<RemoteInteractiveCapabilities, "supportsCompact" | "supportsReload" | "supportsModelSelection">,
): ForkedStartupHelp {
	const expandedHints = [
		keyHint("app.interrupt", "to interrupt"),
		keyHint("app.clear", "to clear"),
		rawKeyHint(`${keyText("app.clear")} twice`, "to exit"),
		keyHint("app.exit", "to exit (empty)"),
		keyHint("app.message.followUp", "to queue input"),
		keyHint("app.message.dequeue", "to restore queued"),
		rawKeyHint("/", "for commands"),
	];
	const compactHints = [
		keyHint("app.interrupt", "interrupt"),
		rawKeyHint(`${keyText("app.clear")}/${keyText("app.exit")}`, "clear/exit"),
		rawKeyHint("/", "commands"),
	];

	if (capabilities.supportsModelSelection) {
		expandedHints.push(keyHint("app.model.select", "to select model"));
		compactHints.push(rawKeyHint(keyText("app.model.select"), "model"));
	}
	if (capabilities.supportsCompact) {
		expandedHints.push(rawKeyHint("/compact", "to compact the session"));
		compactHints.push(rawKeyHint("/compact", "compact"));
	}
	if (capabilities.supportsReload) {
		expandedHints.push(rawKeyHint("/reload", "to reload hub resources"));
		compactHints.push(rawKeyHint("/reload", "reload"));
	}

	return {
		expanded: expandedHints.join("\n"),
		compact: compactHints.join(theme.fg("muted", " · ")),
	};
}
