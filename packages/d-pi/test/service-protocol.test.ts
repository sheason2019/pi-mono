import { describe, expect, it } from "vitest";
import {
	type DPiServiceActionRequest,
	type DPiServiceActionResult,
	type DPiServiceEvent,
	type DPiServiceSnapshot,
	dPiServiceError,
	isDPiJsonValue,
	isDPiServiceError,
	isDPiServiceSnapshot,
	toDPiJsonValue,
} from "../src/service/protocol.ts";

describe("d-pi service protocol", () => {
	it("round-trips snapshots through JSON", () => {
		const snapshot: DPiServiceSnapshot = {
			agentName: "root",
			state: {
				status: "ready",
				messages: [{ role: "assistant", content: "hello" }],
			},
		};

		const parsed = JSON.parse(JSON.stringify(snapshot)) as unknown;

		expect(isDPiServiceSnapshot(parsed)).toBe(true);
		expect(parsed).toEqual(snapshot);
	});

	it("round-trips stable error envelopes and rejects non-errors", () => {
		const error = dPiServiceError("not_found", "Agent not found", { agentName: "missing" });
		const parsed = JSON.parse(JSON.stringify(error)) as unknown;

		expect(isDPiServiceError(parsed)).toBe(true);
		expect(parsed).toEqual({
			error: {
				code: "not_found",
				message: "Agent not found",
				details: { agentName: "missing" },
			},
		});
		expect(isDPiServiceError({ error: "Agent not found" })).toBe(false);
		expect(isDPiServiceError({ ok: true })).toBe(false);
	});

	it("keeps service events JSON-safe", () => {
		const snapshot: DPiServiceSnapshot = { agentName: "root", state: { status: "ready" } };
		const events: DPiServiceEvent[] = [
			{ type: "snapshot", snapshot },
			{ type: "runtime", event: "turn_start" },
			{ type: "worker", event: "token", data: { text: "hi" } },
		];

		const parsed = JSON.parse(JSON.stringify(events)) as unknown;

		expect(parsed).toEqual(events);
	});

	it("round-trips action requests and results", () => {
		const request: DPiServiceActionRequest = {
			text: "ship it",
			options: {
				images: [{ url: "file:///tmp/image.png", mediaType: "image/png" }],
			},
		};
		const ok: DPiServiceActionResult = { ok: true };
		const error: DPiServiceActionResult = dPiServiceError("bad_request", "text is required");

		expect(JSON.parse(JSON.stringify(request))).toEqual(request);
		expect(JSON.parse(JSON.stringify(ok))).toEqual(ok);
		expect(isDPiServiceError(JSON.parse(JSON.stringify(error)) as unknown)).toBe(true);
	});

	it("accepts only JSON-safe protocol values", () => {
		const validValues: unknown[] = [
			null,
			true,
			"hello",
			1.5,
			["nested", { ok: true }],
			{ status: "ready", count: 1 },
		];

		for (const value of validValues) {
			expect(isDPiJsonValue(value)).toBe(true);
			expect(toDPiJsonValue(value)).toEqual(value);
		}
	});

	it("rejects values that cannot be represented safely as JSON", () => {
		class ClassInstance {
			readonly value = "not plain";
		}
		const cycle: Record<string, unknown> = {};
		cycle.self = cycle;
		const sparseArray: unknown[] = [];
		sparseArray[1] = "hole";
		const arrayWithDroppedProperty: unknown[] & { extra?: unknown } = ["kept"];
		arrayWithDroppedProperty.extra = () => "dropped";
		const invalidValues: unknown[] = [
			undefined,
			() => "nope",
			Symbol("nope"),
			Number.POSITIVE_INFINITY,
			Number.NaN,
			1n,
			cycle,
			sparseArray,
			arrayWithDroppedProperty,
			new ClassInstance(),
		];

		for (const value of invalidValues) {
			expect(isDPiJsonValue(value)).toBe(false);
			expect(() => toDPiJsonValue(value)).toThrow(TypeError);
		}
	});

	it("rejects snapshots and error details that are not JSON-safe", () => {
		expect(isDPiServiceSnapshot({ agentName: "root", state: undefined })).toBe(false);
		expect(isDPiServiceSnapshot({ agentName: "root", state: { status: "ready" }, runtime: Number.NaN })).toBe(false);
		expect(
			isDPiServiceError({
				error: {
					code: "worker_error",
					message: "Worker request failed",
					details: { body: 1n },
				},
			}),
		).toBe(false);
	});
});
