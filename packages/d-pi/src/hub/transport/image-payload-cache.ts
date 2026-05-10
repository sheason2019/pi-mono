import { createHash } from "node:crypto";

export interface ImagePayload {
	imageId: string;
	mimeType: string;
	data: string;
}

export interface MaterializedPeerPayload<T> {
	value: T;
	images: ImagePayload[];
}

function computeImageId(mimeType: string, data: string): string {
	return createHash("sha256").update(mimeType).update("\0").update(data).digest("hex");
}

function isPlainObject(x: unknown): x is Record<string, unknown> {
	if (x === null || typeof x !== "object") {
		return false;
	}
	if (Array.isArray(x)) {
		return false;
	}
	const proto = Object.getPrototypeOf(x) as object | null;
	return proto === Object.prototype || proto === null;
}

function isImageObject(x: unknown): x is { type: "image"; data: string; mimeType: string } & Record<string, unknown> {
	if (!isPlainObject(x)) {
		return false;
	}
	return x.type === "image" && typeof x.data === "string" && typeof x.mimeType === "string";
}

export class ImagePayloadCache {
	private readonly byId = new Map<string, ImagePayload>();

	get(imageId: string): ImagePayload | undefined {
		return this.byId.get(imageId);
	}

	materializePeerPayload<T>(value: T): MaterializedPeerPayload<T> {
		const images: ImagePayload[] = [];
		const seenInCall = new Set<string>();
		const result = this.transformValue(value, images, seenInCall) as T;
		return { value: result, images };
	}

	private transformValue(value: unknown, images: ImagePayload[], seenInCall: Set<string>): unknown {
		if (value === null || typeof value !== "object") {
			return value;
		}
		if (Array.isArray(value)) {
			return this.transformArray(value, images, seenInCall);
		}
		if (isImageObject(value)) {
			return this.replaceImageNode(value, images, seenInCall);
		}
		if (isPlainObject(value)) {
			return this.transformPlainObject(value, images, seenInCall);
		}
		return value;
	}

	private transformArray(value: unknown[], images: ImagePayload[], seenInCall: Set<string>): unknown {
		let changed = false;
		const out: unknown[] = new Array(value.length);
		for (let i = 0; i < value.length; i++) {
			const el = value[i];
			const next = this.transformValue(el, images, seenInCall);
			if (next !== el) {
				changed = true;
			}
			out[i] = next;
		}
		return changed ? out : value;
	}

	private transformPlainObject(x: Record<string, unknown>, images: ImagePayload[], seenInCall: Set<string>): unknown {
		let changed = false;
		const result: Record<string, unknown> = {};
		for (const k of Object.keys(x)) {
			const el = x[k];
			const next = this.transformValue(el, images, seenInCall);
			if (next !== el) {
				changed = true;
			}
			result[k] = next;
		}
		return changed ? result : x;
	}

	private replaceImageNode(
		node: { type: "image"; data: string; mimeType: string } & Record<string, unknown>,
		images: ImagePayload[],
		seenInCall: Set<string>,
	): unknown {
		const { mimeType, data } = node;
		const imageId = computeImageId(mimeType, data);
		const payload: ImagePayload = { imageId, mimeType, data };
		this.byId.set(imageId, payload);
		if (!seenInCall.has(imageId)) {
			seenInCall.add(imageId);
			images.push(payload);
		}
		return { ...node, data: "", imageId };
	}
}
