import { describe, expect, it } from "vitest";
import {
	DPI_NATIVE_CONNECT_BUILTIN_COMMANDS,
	DPI_NATIVE_CONNECT_PROTOCOL_ACTIONS,
	DPI_NATIVE_CONNECT_PROTOCOL_QUERIES,
	DPI_NATIVE_CONNECT_UI_TREE,
	DPI_NATIVE_CONNECT_UNAVAILABLE_COMMANDS,
} from "../src/tui/interactive/native-parity-manifest.ts";

describe("native coding-agent connect parity manifest", () => {
	it("freezes the native connect builtin slash command surface", () => {
		expect(DPI_NATIVE_CONNECT_BUILTIN_COMMANDS).toEqual([
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
		]);
	});

	it("freezes the native connect protocol query/action surface", () => {
		expect(DPI_NATIVE_CONNECT_PROTOCOL_QUERIES).toEqual([
			"state",
			"messages",
			"settings",
			"tree",
			"user-messages",
			"sessions",
			"commands",
			"client-extensions",
		]);
		expect(DPI_NATIVE_CONNECT_PROTOCOL_ACTIONS).toEqual([
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
		]);
	});

	it("freezes the native connect unavailable command copy", () => {
		expect(DPI_NATIVE_CONNECT_UNAVAILABLE_COMMANDS).toEqual({
			export: "Not available in connect mode",
			import: "Not available in connect mode",
			share: "Not available in connect mode",
			login: "Not available in connect mode — configure auth on the server",
			logout: "Not available in connect mode — configure auth on the server",
		});
	});

	it("freezes the native interactive TUI tree order", () => {
		expect(DPI_NATIVE_CONNECT_UI_TREE).toEqual([
			"headerContainer",
			"chatContainer",
			"pendingMessagesContainer",
			"statusContainer",
			"widgetContainerAbove",
			"editorContainer",
			"widgetContainerBelow",
			"footer",
		]);
	});
});
