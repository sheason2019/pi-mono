import { describe, expect, it } from "vitest";
import { transformLine } from "../src/sources/lark-health-shim.ts";

describe("lark-health-shim transformLine", () => {
	it("translates a valid [health-check] OK line into a JSONRPC notification", () => {
		const out = transformLine("[health-check] 2026-06-07T16:00:01Z lark-cli OK (bus_pid=894190)");
		expect(out).not.toBeNull();
		const parsed = JSON.parse(out!);
		expect(parsed.jsonrpc).toBe("2.0");
		expect(parsed.method).toBe("events.emit");
		expect(parsed.params.type).toBe("health.report");
		expect(parsed.params.timestamp).toBe("2026-06-07T16:00:01Z");
		expect(parsed.params.status).toBe("OK");
		expect(parsed.params.bus_pid).toBe(894190);
	});

	it("translates a FAILED status correctly", () => {
		const out = transformLine("[health-check] 2026-06-08T00:00:00Z lark-cli FAILED (bus_pid=42)");
		expect(out).not.toBeNull();
		const parsed = JSON.parse(out!);
		expect(parsed.params.status).toBe("FAILED");
		expect(parsed.params.bus_pid).toBe(42);
	});

	it("translates bus_pid=none to null", () => {
		const out = transformLine("[health-check] 2026-06-08T00:00:00Z lark-cli FAILED (bus_pid=none)");
		expect(out).not.toBeNull();
		const parsed = JSON.parse(out!);
		expect(parsed.params.bus_pid).toBeNull();
	});

	it("returns null for non-health lines (lark-cli startup noise)", () => {
		const cases = [
			"",
			" ",
			"[event] ready event_key=im.message.receive_v1",
			"random debug output",
			"[health-check] missing bus_pid field",
			"[health-check] 2026-06-07T16:00:01Z lark-cli OK",
		];
		for (const c of cases) {
			expect(transformLine(c)).toBeNull();
		}
	});

	it("returns null for malformed health lines without throwing", () => {
		// Wrong tag, wrong status, missing parens, etc.
		const cases = [
			"[other] 2026-06-07T16:00:01Z lark-cli OK (bus_pid=1)",
			"[health-check] not-a-timestamp lark-cli OK (bus_pid=1)",
			"[health-check] 2026-06-07T16:00:01Z unknown-status (bus_pid=1)",
			"[health-check] 2026-06-07T16:00:01Z lark-cli OK bus_pid=1",
			"[health-check] 2026-06-07T16:00:01Z lark-cli OK (bus_pid=)",
			"[health-check] 2026-06-07T16:00:01Z lark-cli OK (bus_pid=abc)",
		];
		for (const c of cases) {
			expect(transformLine(c)).toBeNull();
		}
	});

	it("emits exactly one notification per valid line with no trailing newline", () => {
		const out = transformLine("[health-check] 2026-06-07T16:00:01Z lark-cli OK (bus_pid=1)");
		expect(out).not.toBeNull();
		expect(out!.endsWith("\n")).toBe(false);
		expect(() => JSON.parse(out!)).not.toThrow();
	});
});
