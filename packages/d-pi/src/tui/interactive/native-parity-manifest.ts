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
	"fork",
	"clone",
	"tree",
	"trust",
	"login",
	"logout",
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
	login: "Not available in connect mode — configure auth on the server",
	logout: "Not available in connect mode — configure auth on the server",
} as const satisfies Partial<Record<DPiNativeConnectBuiltinCommand, string>>;

export const DPI_NATIVE_CONNECT_PROTOCOL_QUERIES = [
	"state",
	"messages",
	"settings",
	"tree",
	"user-messages",
	"sessions",
	"commands",
	"client-extensions",
] as const;

export const DPI_NATIVE_CONNECT_PROTOCOL_ACTIONS = [
	"prompt",
	"steer",
	"follow-up",
	"abort",
	"abort-bash",
	"clear-queue",
	"compact",
	"set-thinking-level",
	"cycle-thinking-level",
	"new-session",
	"switch-session",
	"fork",
	"name",
	"label",
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
