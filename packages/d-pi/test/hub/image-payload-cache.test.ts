import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	type ImagePayload,
	ImagePayloadCache,
	type MaterializedPeerPayload,
} from "../../src/hub/transport/image-payload-cache.js";

function hashImageId(mimeType: string, data: string): string {
	return createHash("sha256").update(mimeType).update("\0").update(data).digest("hex");
}

function imageIdOf(result: MaterializedPeerPayload<unknown>): string {
	return (result.value as unknown as { imageId: string }).imageId;
}

describe("ImagePayloadCache", () => {
	it("assigns the same imageId to identical mimeType and data", () => {
		const cache = new ImagePayloadCache();
		const payload = { type: "image" as const, mimeType: "image/png", data: "YmFzZTY0" };
		const a = cache.materializePeerPayload(payload);
		const b = cache.materializePeerPayload({ ...payload });
		expect(imageIdOf(a)).toBe(imageIdOf(b));
		expect(imageIdOf(a)).toBe(hashImageId("image/png", "YmFzZTY0"));
	});

	it("produces different imageId when mimeType or data differs", () => {
		const cache = new ImagePayloadCache();
		const p1 = { type: "image" as const, mimeType: "image/png", data: "YQ" };
		const p2 = { type: "image" as const, mimeType: "image/png", data: "Yg" };
		const p3 = { type: "image" as const, mimeType: "image/jpeg", data: "YQ" };
		const id1 = imageIdOf(cache.materializePeerPayload(p1));
		const id2 = imageIdOf(cache.materializePeerPayload(p2));
		const id3 = imageIdOf(cache.materializePeerPayload(p3));
		expect(id1).not.toBe(id2);
		expect(id1).not.toBe(id3);
		expect(id2).not.toBe(id3);
	});

	it("replaces image data with empty string and adds imageId on the value copy", () => {
		const cache = new ImagePayloadCache();
		const input = { type: "image", mimeType: "image/webp", data: "ZGF0YQ" };
		const { value, images } = cache.materializePeerPayload(input);
		expect(value).toEqual({ type: "image", mimeType: "image/webp", data: "", imageId: expect.any(String) });
		expect((value as { data: string }).data).toBe("");
		expect((value as unknown as { imageId: string }).imageId).toBeTruthy();
		expect(images).toHaveLength(1);
		expect(images[0]).toEqual({
			imageId: (value as unknown as { imageId: string }).imageId,
			mimeType: "image/webp",
			data: "ZGF0YQ",
		});
	});

	it("dedupes images in the collected list when the same image appears multiple times in one value", () => {
		const cache = new ImagePayloadCache();
		const block = { type: "image", mimeType: "image/png", data: "WDE=" };
		const input = { a: [block, { nested: block }], b: block };
		const { value, images } = cache.materializePeerPayload(input);
		type Out = { a: Array<{ imageId: string } | { nested: { imageId: string } }>; b: { imageId: string } };
		const v = value as unknown as Out;
		expect((v.a[0] as { imageId: string }).imageId).toBe(v.b.imageId);
		expect((v.a[1] as { nested: { imageId: string } }).nested.imageId).toBe(v.b.imageId);
		expect(images).toHaveLength(1);
		expect(images[0].data).toBe("WDE=");
	});

	it("does not mutate the original input object or nested image objects", () => {
		const cache = new ImagePayloadCache();
		const image = { type: "image", mimeType: "image/gif", data: "QUJD" };
		const input = { items: [image], other: 1 };
		const before = JSON.stringify(input);
		cache.materializePeerPayload(input);
		expect(JSON.stringify(input)).toBe(before);
		expect(image.data).toBe("QUJD");
		expect("imageId" in image).toBe(false);
	});

	it("get returns the cached full payload for a materialized imageId", () => {
		const cache = new ImagePayloadCache();
		const data = "c29tZUJ5dGVz";
		const { value, images } = cache.materializePeerPayload({ type: "image", mimeType: "image/svg+xml", data });
		const id = (value as unknown as { imageId: string }).imageId;
		const fromGet = cache.get(id);
		expect(fromGet).toBeDefined();
		expect(fromGet).toEqual(images[0]);
		const expected: ImagePayload = { imageId: id, mimeType: "image/svg+xml", data };
		expect(fromGet).toEqual(expected);
	});
});
