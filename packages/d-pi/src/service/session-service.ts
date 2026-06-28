import { z } from "zod";
import type { DPiJsonValue, DPiServiceActionRequest } from "./protocol.ts";

export type DPiServiceActionName = "prompt" | "steer" | "follow-up";

export type WorkerActionBridge =
	| {
			action: "prompt";
			data: {
				text: string;
				options?: DPiJsonValue;
			};
	  }
	| {
			action: "steer" | "follow-up";
			data: {
				text: string;
				images?: DPiJsonValue;
			};
	  };

export function toWorkerSnapshotQuery(): "snapshot" {
	return "snapshot";
}

export function parseServiceActionName(action: string): DPiServiceActionName | undefined {
	if (action === "prompt" || action === "steer" || action === "follow-up") {
		return action;
	}
	return undefined;
}

export function toWorkerAction(action: DPiServiceActionName, request: DPiServiceActionRequest): WorkerActionBridge {
	if (action === "prompt") {
		return {
			action: "prompt",
			data: {
				text: request.text,
				...(request.options === undefined ? {} : { options: request.options }),
			},
		};
	}
	const images = extractImages(request.options);
	return {
		action,
		data: {
			text: request.text,
			...(images === undefined ? {} : { images }),
		},
	};
}

const optionsWithImagesSchema = z
	.object({
		images: z.unknown().optional(),
	})
	.passthrough();

function extractImages(options: DPiJsonValue | undefined): DPiJsonValue | undefined {
	const parsed = optionsWithImagesSchema.safeParse(options);
	if (!parsed.success) {
		return undefined;
	}
	return parsed.data.images as DPiJsonValue | undefined;
}
