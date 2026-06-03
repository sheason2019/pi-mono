import { describe, expect, it } from "vitest";
import { extractMeta, injectMeta } from "../src/extension/message-meta.ts";

describe("connect meta with connectId", () => {
	it("round-trips connectId through inject/extract", () => {
		const text = "hello world";
		const meta = injectMeta(text, "connect", undefined, { connectId: "abc-123" });
		const extracted = extractMeta(meta);
		expect(extracted).not.toBeNull();
		expect(extracted!.meta.sourceType).toBe("connect");
		expect(extracted!.meta.connectId).toBe("abc-123");
		expect(extracted!.text).toBe(text);
	});

	it("omits connectId when not provided", () => {
		const text = "hello";
		const meta = injectMeta(text, "connect");
		const extracted = extractMeta(meta);
		expect(extracted!.meta.connectId).toBeUndefined();
	});

	it("does not add connectId for non-connect source types", () => {
		const meta = injectMeta("hi", "source", undefined, { connectId: "abc-123" });
		const extracted = extractMeta(meta);
		expect(extracted!.meta.connectId).toBeUndefined();
	});
});
