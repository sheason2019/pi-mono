/**
 * In-memory image bytes keyed by `imageId` (hub protocol), with deep hydration
 * of snapshot/live payloads that use image refs (`data: ""`).
 */
export interface ImagePayload {
	imageId: string;
	mimeType: string;
	data: string;
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

function isImageRef(x: unknown): x is { type: "image"; imageId: string; data: "" } & Record<string, unknown> {
	if (!isPlainObject(x)) {
		return false;
	}
	return x.type === "image" && x.data === "" && typeof x.imageId === "string" && x.imageId.length > 0;
}

export class PeerImageCache {
	private readonly byId = new Map<string, ImagePayload>();

	store(payload: ImagePayload): void {
		this.byId.set(payload.imageId, { ...payload });
	}

	get(imageId: string): ImagePayload | undefined {
		return this.byId.get(imageId);
	}

	hydrate<T>(value: T): T {
		return this.hydrateValue(value) as T;
	}

	collectMissingImageIds(value: unknown): string[] {
		const seen = new Set<string>();
		const out: string[] = [];
		const visit = (v: unknown): void => {
			if (v === null || typeof v !== "object") {
				return;
			}
			if (Array.isArray(v)) {
				for (const el of v) {
					visit(el);
				}
				return;
			}
			if (isImageRef(v) && !this.byId.has(v.imageId) && !seen.has(v.imageId)) {
				seen.add(v.imageId);
				out.push(v.imageId);
				return;
			}
			if (isPlainObject(v) && (v as { type?: unknown }).type === "image") {
				return;
			}
			if (isPlainObject(v)) {
				for (const k of Object.keys(v)) {
					visit(v[k]);
				}
			}
		};
		visit(value);
		return out;
	}

	private hydrateValue(value: unknown): unknown {
		if (value === null || typeof value !== "object") {
			return value;
		}
		if (Array.isArray(value)) {
			return this.hydrateArray(value);
		}
		if (isImageRef(value)) {
			const hit = this.byId.get(value.imageId);
			if (hit) {
				return { ...value, data: hit.data, mimeType: hit.mimeType, imageId: hit.imageId };
			}
			return value;
		}
		if (isPlainObject(value)) {
			return this.hydratePlainObject(value);
		}
		return value;
	}

	private hydrateArray(value: unknown[]): unknown {
		let changed = false;
		const out: unknown[] = new Array(value.length);
		for (let i = 0; i < value.length; i++) {
			const el = value[i];
			const next = this.hydrateValue(el);
			if (next !== el) {
				changed = true;
			}
			out[i] = next;
		}
		return changed ? out : value;
	}

	private hydratePlainObject(x: Record<string, unknown>): unknown {
		let changed = false;
		const result: Record<string, unknown> = {};
		for (const k of Object.keys(x)) {
			const el = x[k];
			const next = this.hydrateValue(el);
			if (next !== el) {
				changed = true;
			}
			result[k] = next;
		}
		return changed ? result : x;
	}
}
