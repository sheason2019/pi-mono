import type { Api, Model } from "@earendil-works/pi-ai";
import type { DPiModelInfo } from "./types.ts";

export interface DPiModelManagerOptions {
	model: Model<Api>;
}

function modelInfo(model: Model<Api>): DPiModelInfo {
	return {
		id: model.id,
		provider: model.provider,
		displayName: model.name,
		contextWindow: model.contextWindow,
		reasoning: model.reasoning,
	};
}

export class DPiModelManager {
	private model: Model<Api>;

	constructor(options: DPiModelManagerOptions) {
		this.model = options.model;
	}

	getModel(): Model<Api> {
		return this.model;
	}

	setModel(model: Model<Api>): void {
		this.model = model;
	}

	getModelInfo(): DPiModelInfo {
		return modelInfo(this.model);
	}
}
