export const DPI_NATIVE_CONNECT_BUILTIN_COMMANDS = [
	"settings",
	"export",
	"import",
	"share",
	"copy",
	"name",
	"session",
	"changelog",
	"hotkeys",
	"trust",
	"new",
	"compact",
	"resume",
	"reload",
	"quit",
] as const;

export type DPiNativeConnectBuiltinCommand = (typeof DPI_NATIVE_CONNECT_BUILTIN_COMMANDS)[number];

export const DPI_NATIVE_CONNECT_UNAVAILABLE_COMMANDS = {
	export: "Not available in connect mode",
	import: "Not available in connect mode",
	share: "Not available in connect mode",
} as const satisfies Partial<Record<DPiNativeConnectBuiltinCommand, string>>;

export const DPI_NATIVE_CONNECT_PROTOCOL_QUERIES = ["state", "messages", "settings", "sessions", "commands"] as const;

export const DPI_NATIVE_CONNECT_PROTOCOL_ACTIONS = [
	"prompt",
	"steer",
	"follow-up",
	"abort",
	"clear-queue",
	"compact",
	"new-session",
	"switch-session",
	"name",
	"reload",
	"settings",
] as const;

export const DPI_NATIVE_CONNECT_UI_TREE = [
	"headerContainer",
	"chatContainer",
	"pendingMessagesContainer",
	"statusContainer",
	"widgetContainerAbove",
	"editorContainer",
	"widgetContainerBelow",
	"footer",
] as const;
