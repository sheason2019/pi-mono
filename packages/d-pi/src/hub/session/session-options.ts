import type { Model } from "@earendil-works/pi-ai";

export interface HubAvailableModel {
	resourceId?: string;
	providerResourceId?: string;
	provider: string;
	modelId: string;
	label: string;
	reasoning?: boolean;
	contextWindow?: number;
}

export const DEFAULT_AVAILABLE_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

type HubModel = Model<any> & {
	resourceId?: string;
	providerResourceId?: string;
};

export function serializeAvailableModels(models: Array<Model<any>>): HubAvailableModel[] {
	return [...models]
		.sort((left, right) => {
			const providerCompare = left.provider.localeCompare(right.provider);
			if (providerCompare !== 0) {
				return providerCompare;
			}
			return left.id.localeCompare(right.id);
		})
		.map((model) => {
			const hubModel = model as HubModel;
			return {
				resourceId: hubModel.resourceId ?? `${hubModel.provider}:${hubModel.id}`,
				providerResourceId: hubModel.providerResourceId,
				provider: model.provider,
				modelId: model.id,
				label: model.name,
				reasoning: model.reasoning,
				contextWindow: model.contextWindow,
			};
		});
}
