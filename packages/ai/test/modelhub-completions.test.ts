import { beforeEach, describe, expect, it, vi } from "vitest";
import { streamModelHubCompletions } from "../src/providers/modelhub.js";
import type { Model } from "../src/types.js";

interface FakeOpenAIClientOptions {
	apiKey: string;
	baseURL: string;
	dangerouslyAllowBrowser: boolean;
	defaultHeaders?: Record<string, string | null>;
}

interface CapturedRequestOptions {
	path?: string;
	query?: Record<string, string>;
}

const mockState = vi.hoisted(() => ({
	lastClientOptions: undefined as FakeOpenAIClientOptions | undefined,
	lastRequestOptions: undefined as CapturedRequestOptions | undefined,
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: (_params: unknown, requestOptions: CapturedRequestOptions) => {
					mockState.lastRequestOptions = requestOptions;
					const stream = {
						async *[Symbol.asyncIterator]() {
							yield {
								id: "chatcmpl-modelhub",
								model: "kimi-k2.5",
								choices: [{ index: 0, delta: { content: "hello" }, finish_reason: null }],
							};
							yield {
								id: "chatcmpl-modelhub",
								model: "kimi-k2.5",
								choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
								usage: {
									prompt_tokens: 3,
									completion_tokens: 2,
									total_tokens: 5,
								},
							};
						},
					};
					const promise = Promise.resolve(stream) as Promise<typeof stream> & {
						withResponse: () => Promise<{
							data: typeof stream;
							response: { status: number; headers: Headers };
						}>;
					};
					promise.withResponse = async () => ({
						data: stream,
						response: { status: 200, headers: new Headers() },
					});
					return promise;
				},
			},
		};

		constructor(options: FakeOpenAIClientOptions) {
			mockState.lastClientOptions = options;
		}
	}

	return { default: FakeOpenAI };
});

function modelHubModel(): Model<"modelhub-completions"> {
	return {
		id: "kimi-k2.5",
		name: "ModelHub kimi-k2.5",
		api: "modelhub-completions",
		provider: "modelhub",
		baseUrl: "https://aidp.bytedance.net",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 2_000_000,
		maxTokens: 32_000,
	};
}

describe("modelhub-completions", () => {
	beforeEach(() => {
		mockState.lastClientOptions = undefined;
		mockState.lastRequestOptions = undefined;
	});

	it("posts chat completions to the ModelHub crawl endpoint with ak query authentication", async () => {
		const message = await streamModelHubCompletions(
			modelHubModel(),
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "test-ak" },
		).result();

		expect(message.stopReason).toBe("stop");
		expect(message.content).toEqual([{ type: "text", text: "hello" }]);
		expect(mockState.lastClientOptions?.baseURL).toBe("https://aidp.bytedance.net");
		expect(mockState.lastClientOptions?.defaultHeaders?.Authorization).toBeNull();
		expect(mockState.lastRequestOptions?.path).toBe("/api/modelhub/online/v2/crawl");
		expect(mockState.lastRequestOptions?.query).toEqual({ ak: "test-ak" });
	});
});
