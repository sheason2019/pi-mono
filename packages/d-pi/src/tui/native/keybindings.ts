import { type KeybindingDefinitions, KeybindingsManager, type KeyId, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";

export interface DPiAppKeybindings {
	"app.interrupt": true;
	"app.exit": true;
	"app.editor.external": true;
	"app.message.followUp": true;
	"app.message.dequeue": true;
	"app.clipboard.pasteImage": true;
}

export type DPiAppKeybinding = keyof DPiAppKeybindings;

declare module "@earendil-works/pi-tui" {
	interface Keybindings extends DPiAppKeybindings {}
}

export const DPI_APP_KEYBINDINGS = {
	...TUI_KEYBINDINGS,
	"app.interrupt": { defaultKeys: "escape", description: "Cancel or abort" },
	"app.exit": { defaultKeys: "ctrl+d", description: "Exit when editor is empty" },
	"app.editor.external": { defaultKeys: "ctrl+g", description: "Open external editor" },
	"app.message.followUp": { defaultKeys: "alt+enter", description: "Queue follow-up message" },
	"app.message.dequeue": { defaultKeys: "alt+up", description: "Restore queued messages" },
	"app.clipboard.pasteImage": {
		defaultKeys: process.platform === "win32" ? ("alt+v" as KeyId) : ("ctrl+v" as KeyId),
		description: "Paste image from clipboard",
	},
} as const satisfies KeybindingDefinitions;

export function createDPiNativeKeybindings(): KeybindingsManager {
	return new KeybindingsManager(DPI_APP_KEYBINDINGS);
}
