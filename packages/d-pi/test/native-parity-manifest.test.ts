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
			"trust",
			"new",
			"compact",
			"resume",
			"reload",
			"quit",
		]);
	});

	it("freezes the native connect protocol query/action surface", () => {
		expect(DPI_NATIVE_CONNECT_PROTOCOL_QUERIES).toEqual(["state", "messages", "settings", "sessions", "commands"]);
		expect(DPI_NATIVE_CONNECT_PROTOCOL_ACTIONS).toEqual([
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
		]);
	});

	it("freezes the native connect unavailable command copy", () => {
		expect(DPI_NATIVE_CONNECT_UNAVAILABLE_COMMANDS).toEqual({
			export: "Not available in connect mode",
			import: "Not available in connect mode",
			share: "Not available in connect mode",
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
