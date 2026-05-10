import { describe, expect, it } from "vitest";
import { PeerImageCache } from "../../src/peer/state/peer-image-cache.js";

describe("PeerImageCache", () => {
	it("store records image bytes by imageId and get returns the payload", () => {
		const cache = new PeerImageCache();
		const payload = { imageId: "abc123", mimeType: "image/png", data: "YmFzZTY0" };
		cache.store(payload);
		expect(cache.get("abc123")).toEqual(payload);
		expect(cache.get("missing")).toBeUndefined();
	});

	it("hydrate replaces image refs with cached data and mimeType", () => {
		const cache = new PeerImageCache();
		cache.store({ imageId: "i1", mimeType: "image/png", data: "WDE=" });
		const ref = { type: "image" as const, imageId: "i1", data: "" as const, mimeType: "image/png" };
		const out = cache.hydrate({ items: [ref] });
		expect(out).toEqual({
			items: [{ type: "image", imageId: "i1", data: "WDE=", mimeType: "image/png" }],
		});
	});

	it("hydrate leaves unknown image refs unchanged", () => {
		const cache = new PeerImageCache();
		const ref = { type: "image" as const, imageId: "nope", data: "" as const, mimeType: "image/png" };
		const input = { x: ref };
		expect(cache.hydrate(input)).toEqual({ x: ref });
	});

	it("hydrate does not mutate the input", () => {
		const cache = new PeerImageCache();
		cache.store({ imageId: "i1", mimeType: "image/gif", data: "QUJD" });
		const inner = { type: "image" as const, imageId: "i1", data: "" as const, mimeType: "image/gif" };
		const input = { nested: { inner } };
		const copy = cache.hydrate(input);
		expect(copy).not.toBe(input);
		expect((input.nested as { inner: { data: string } }).inner.data).toBe("");
	});

	it("returns unchanged branches by reference when no hydration in that subtree", () => {
		const cache = new PeerImageCache();
		const untouched = { a: 1, b: [2, 3] };
		const ref = { type: "image" as const, imageId: "i1", data: "" as const, mimeType: "image/png" };
		cache.store({ imageId: "i1", mimeType: "image/png", data: "eA==" });
		const input = { untouched, other: ref };
		const out = cache.hydrate(input);
		expect(out.untouched).toBe(untouched);
		expect(out.other).not.toBe(ref);
	});

	it("collectMissingImageIds lists ref ids not present in cache, deduped", () => {
		const cache = new PeerImageCache();
		cache.store({ imageId: "known", mimeType: "image/png", data: "WDE=" });
		const a = { type: "image" as const, imageId: "a", data: "" as const, mimeType: "image/png" };
		const b = { type: "image" as const, imageId: "known", data: "" as const, mimeType: "image/png" };
		const c = { type: "image" as const, imageId: "b", data: "" as const, mimeType: "image/png" };
		const missing = cache.collectMissingImageIds([a, b, c]);
		expect(missing.sort()).toEqual(["a", "b"]);
	});
});
