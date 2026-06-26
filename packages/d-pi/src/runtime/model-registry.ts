import type { Api, Model } from "@earendil-works/pi-ai";

export interface ModelRegistry {
	find(provider: string, modelId: string): Model<Api> | undefined;
	getAll(): Model<Api>[];
	getAvailable?(): Promise<Model<Api>[]>;
	refresh(): void;
	getError?(): unknown;
}
