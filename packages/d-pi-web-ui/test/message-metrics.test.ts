import { describe, expect, it } from "vitest";
import { formatRunDuration } from "../src/message-metrics.js";

describe("d-pi message metrics helpers", () => {
	it("formats run duration labels", () => {
		expect(formatRunDuration(2_000)).toBe("本轮用时: 00m02s");
		expect(formatRunDuration(2_000, "interrupted")).toBe("本轮用时: 00m02s（已中断）");
		expect(formatRunDuration(2_000, "error")).toBe("本轮用时: 00m02s（异常结束）");
	});
});
