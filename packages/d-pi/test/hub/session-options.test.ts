import type { Model } from "@sheason/pi-ai";
import { describe, expect, it } from "vitest";
import { DEFAULT_AVAILABLE_THINKING_LEVELS, serializeAvailableModels } from "../../src/hub/session/session-options.js";

describe("session options", () => {
	it("serializes hub model metadata for remote selectors", () => {
		const models = [
			{
				id: "gpt-4.1",
				name: "GPT 4.1",
				provider: "openai",
				reasoning: true,
			},
			{
				id: "claude-sonnet-4-20250514",
				name: "Claude Sonnet 4",
				provider: "anthropic",
				reasoning: true,
			},
		] as Array<Model<any>>;

		expect(serializeAvailableModels(models)).toEqual([
			{
				resourceId: "anthropic:claude-sonnet-4-20250514",
				providerResourceId: undefined,
				provider: "anthropic",
				modelId: "claude-sonnet-4-20250514",
				label: "Claude Sonnet 4",
				reasoning: true,
				contextWindow: undefined,
			},
			{
				resourceId: "openai:gpt-4.1",
				providerResourceId: undefined,
				provider: "openai",
				modelId: "gpt-4.1",
				label: "GPT 4.1",
				reasoning: true,
				contextWindow: undefined,
			},
		]);
		expect(DEFAULT_AVAILABLE_THINKING_LEVELS).toEqual(["off", "minimal", "low", "medium", "high", "xhigh"]);
	});
});
