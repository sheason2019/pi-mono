import { stripVTControlCharacters } from "node:util";
import { initTheme } from "@sheason/pi-coding-agent";
import { CURSOR_MARKER } from "@sheason/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { RemoteModelSelectorComponent } from "../../src/peer/tui/forked/components/model-selector.js";

describe("remote model selector", () => {
	it("filters models by search text and shows selected model details", () => {
		initTheme();
		const selector = new RemoteModelSelectorComponent(
			[
				{ provider: "openai", modelId: "gpt-4.1", label: "GPT 4.1", reasoning: true },
				{ provider: "anthropic", modelId: "claude-sonnet-4-20250514", label: "Claude Sonnet 4", reasoning: true },
			],
			{ provider: "openai", modelId: "gpt-4.1" },
			() => {},
			() => {},
		);

		selector.handleInput("c");
		const lines = selector.render(100).map((line) => stripVTControlCharacters(line));

		expect(lines.some((line) => line.includes("Select Model"))).toBe(true);
		expect(lines.some((line) => line.includes("Model Name: Claude Sonnet 4"))).toBe(true);
		expect(lines.some((line) => line.includes("claude-sonnet-4-20250514"))).toBe(true);
		expect(lines.every((line) => !line.includes("gpt-4.1 [openai]"))).toBe(true);
	});

	it("renders a bordered panel and forwards focus to the search input", () => {
		initTheme();
		const selector = new RemoteModelSelectorComponent(
			[{ provider: "openai", modelId: "gpt-4.1", label: "GPT 4.1", reasoning: true }],
			{ provider: "openai", modelId: "gpt-4.1" },
			() => {},
			() => {},
		);

		selector.focused = true;
		const rawLines = selector.render(80);
		const lines = rawLines.map((line) => stripVTControlCharacters(line));

		expect(lines[0]).toContain("─");
		expect(lines.at(-1)).toContain("─");
		expect(rawLines.some((line) => line.includes(CURSOR_MARKER))).toBe(true);
	});

	it("shows unprefixed provider names from config", () => {
		initTheme();
		const selector = new RemoteModelSelectorComponent(
			[
				{
					resourceId: "hub-model",
					provider: "ark-openai-compatible",
					modelId: "glm-5.1",
					label: "GLM-5.1",
					reasoning: true,
				},
				{
					resourceId: "peer-model",
					provider: "ark-openai-compatible",
					modelId: "glm-5.1",
					label: "GLM-5.1",
					reasoning: true,
				},
			],
			{ provider: "ark-openai-compatible", modelId: "glm-5.1" },
			() => {},
			() => {},
		);

		const lines = selector.render(140).map((line) => stripVTControlCharacters(line));

		expect(lines.some((line) => line.includes("glm-5.1 [ark-openai-compatible]"))).toBe(true);
		expect(lines.every((line) => !line.includes("hub_"))).toBe(true);
		expect(lines.every((line) => !line.includes("peer_"))).toBe(true);
		expect(lines.some((line) => line.includes("glm-5.1 [ark-openai-compatible] GLM-5.1 ✓"))).toBe(true);
	});

	it("reports async selection errors instead of leaving an unhandled rejection", async () => {
		initTheme();
		const onSelectError = vi.fn();
		const selector = new RemoteModelSelectorComponent(
			[{ resourceId: "model-1", provider: "openai", modelId: "gpt-4.1", label: "GPT 4.1", reasoning: true }],
			null,
			async () => {
				throw new Error("Hub agent runtime is not initialized.");
			},
			() => {},
			onSelectError,
		);

		selector.handleInput("\r");
		await vi.waitFor(() => expect(onSelectError).toHaveBeenCalledWith(expect.any(Error)));
	});
});
