import type { Api, KnownProvider, Model, Provider } from "@earendil-works/pi-ai";
import { getModels } from "@earendil-works/pi-ai";
import { createDPiRuntimeError } from "./errors.ts";
import type { DPiModelInfo } from "./types.ts";

export interface DPiModelSpec {
	provider: Provider;
	model: string;
}

export interface DPiModelManagerOptions {
	defaultModel: string | DPiModelSpec | Model<Api>;
}

function parseModelSpec(spec: string | DPiModelSpec): DPiModelSpec {
	if (typeof spec !== "string") {
		return { provider: spec.provider, model: spec.model };
	}
	const separatorIndex = spec.indexOf("/");
	if (separatorIndex <= 0 || separatorIndex === spec.length - 1) {
		throw createDPiRuntimeError("missing_model", `Unknown model spec: ${spec}`, {
			details: { spec },
		});
	}
	return {
		provider: spec.slice(0, separatorIndex),
		model: spec.slice(separatorIndex + 1),
	};
}

function modelInfo(model: Model<Api>): DPiModelInfo {
	return {
		id: model.id,
		provider: model.provider,
		displayName: model.name,
		contextWindow: model.contextWindow,
	};
}

export class DPiModelManager {
	private currentModel: Model<Api>;

	constructor(options: DPiModelManagerOptions) {
		this.currentModel = this.resolveModel(options.defaultModel);
	}

	setModelSpec(spec: string | DPiModelSpec | Model<Api>): void {
		this.currentModel = this.resolveModel(spec);
	}

	getModel(): Model<Api> {
		return this.currentModel;
	}

	getModelInfo(): DPiModelInfo {
		return modelInfo(this.currentModel);
	}

	private resolveModel(specInput: string | DPiModelSpec | Model<Api>): Model<Api> {
		if (isModel(specInput)) {
			return specInput;
		}
		const spec = parseModelSpec(specInput);
		const models: readonly Model<Api>[] = getModels(spec.provider as KnownProvider);
		const model = models.find((candidate) => candidate.id === spec.model);
		if (!model) {
			throw createDPiRuntimeError("missing_model", `Unknown model spec: ${spec.provider}/${spec.model}`, {
				details: { provider: spec.provider, model: spec.model },
			});
		}
		return model;
	}
}

function isModel(value: string | DPiModelSpec | Model<Api>): value is Model<Api> {
	return typeof value === "object" && "id" in value && "api" in value && "baseUrl" in value;
}
