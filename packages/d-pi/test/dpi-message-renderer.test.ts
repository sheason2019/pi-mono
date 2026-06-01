import { type ExtensionAPI, initTheme, type MessageRenderer } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { createDPiExtension } from "../src/extension/index.ts";
import { injectMeta } from "../src/extension/message-meta.ts";

const fakeTheme = {
	bg: (_name: string, text: string) => text,
	fg: (_name: string, text: string) => text,
};

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function getDPiMessageRenderer(): MessageRenderer {
	let renderer: MessageRenderer | undefined;
	const { factory } = createDPiExtension({ mode: "client", hubUrl: "http://localhost:9090" });
	const api = {
		registerMessageRenderer: (_customType: string, nextRenderer: MessageRenderer) => {
			renderer = nextRenderer;
		},
		registerCommand: () => {},
	} as unknown as ExtensionAPI;
	factory(api);
	if (!renderer) {
		throw new Error("d-pi message renderer was not registered");
	}
	return renderer;
}

describe("d-pi message renderer", () => {
	it("renders meta as a header and message body as a user message bubble", () => {
		initTheme("dark");
		const renderer = getDPiMessageRenderer();
		const component = renderer(
			{
				role: "custom",
				customType: "d-pi-message",
				content: injectMeta("hello **world**", "agent", "agent-1"),
				display: true,
				details: undefined,
				timestamp: Date.now(),
			},
			{ expanded: false },
			fakeTheme as never,
		) as Component | undefined;

		expect(component).toBeDefined();
		const rendered = component!.render(80).map(stripAnsi);
		const text = rendered.join("\n");

		expect(text).toContain("agent:agent-1");
		expect(text).toContain("hello world");
		expect(text).not.toContain("[meta(");
		expect(rendered.some((line) => visibleWidth(line) === 80)).toBe(true);
	});
});
