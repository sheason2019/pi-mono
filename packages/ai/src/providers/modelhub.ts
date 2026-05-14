import { getEnvApiKey } from "../env-api-keys.js";
import { clampThinkingLevel } from "../models.js";
import type { AssistantMessageEventStream, Context, Model, SimpleStreamOptions, StreamFunction } from "../types.js";
import { type OpenAICompletionsOptions, streamOpenAIChatCompletions } from "./openai-completions.js";
import { buildBaseOptions } from "./simple-options.js";

export type ModelHubOptions = OpenAICompletionsOptions;

const MODELHUB_COMPLETIONS_PATH = "/api/modelhub/online/v2/crawl";

const MODELHUB_COMPAT = {
	supportsStore: false,
	supportsDeveloperRole: false,
	supportsReasoningEffort: false,
	supportsUsageInStreaming: true,
	maxTokensField: "max_tokens",
	supportsStrictMode: false,
	supportsLongCacheRetention: false,
} as const;

function getModelHubApiKey(
	model: Model<"modelhub-completions">,
	options?: ModelHubOptions | SimpleStreamOptions,
): string {
	const apiKey = options?.apiKey || getEnvApiKey(model.provider) || getEnvApiKey("modelhub");
	if (!apiKey) {
		throw new Error(`No API key for provider: ${model.provider}. Set MODELHUB_AK or MODELHUB_API_KEY.`);
	}
	return apiKey;
}

export const streamModelHubCompletions: StreamFunction<"modelhub-completions", ModelHubOptions> = (
	model: Model<"modelhub-completions">,
	context: Context,
	options?: ModelHubOptions,
): AssistantMessageEventStream => {
	const apiKey = getModelHubApiKey(model, options);
	return streamOpenAIChatCompletions(
		model,
		context,
		{ ...options, apiKey },
		{
			compat: MODELHUB_COMPAT,
			clientHeaders: { Authorization: null },
			requestOptions: {
				path: MODELHUB_COMPLETIONS_PATH,
				query: { ak: apiKey },
			},
		},
	);
};

export const streamSimpleModelHubCompletions: StreamFunction<"modelhub-completions", SimpleStreamOptions> = (
	model: Model<"modelhub-completions">,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	const apiKey = getModelHubApiKey(model, options);
	const base = buildBaseOptions(model, options, apiKey);
	const clampedReasoning = options?.reasoning ? clampThinkingLevel(model, options.reasoning) : undefined;
	const reasoningEffort = clampedReasoning === "off" ? undefined : clampedReasoning;

	return streamModelHubCompletions(model, context, {
		...base,
		reasoningEffort,
	} satisfies ModelHubOptions);
};
