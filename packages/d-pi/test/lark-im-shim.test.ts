import { describe, expect, it } from "vitest";
import { transformLine } from "../src/sources/lark-im-shim.ts";

describe("lark-im-shim transformLine", () => {
	it("translates a valid lark message event into a JSONRPC notification", () => {
		const input = JSON.stringify({
			type: "im.message.receive_v1",
			event: {
				sender: { sender_id: { open_id: "ou_test" } },
				message: {
					message_id: "om_xxx",
					chat_id: "oc_xxx",
					content: JSON.stringify([{ tag: "text", text: "hello" }]),
				},
			},
		});

		const out = transformLine(input);
		expect(out).not.toBeNull();
		const parsed = JSON.parse(out!);
		expect(parsed.jsonrpc).toBe("2.0");
		expect(parsed.method).toBe("events.emit");
		expect(parsed.params.type).toBe("lark.message");
		expect(parsed.params.id).toBe("om_xxx");
		expect(parsed.params.priority).toBe("follow-up");
		expect(parsed.params.data).toBeDefined();
	});

	it("passes through the inner event payload under params.data", () => {
		const inner = {
			sender: { sender_id: { open_id: "ou_test" } },
			message: { message_id: "om_xxx", chat_id: "oc_xxx" },
		};
		const input = JSON.stringify({ type: "im.message.receive_v1", event: inner });

		const out = transformLine(input);
		const parsed = JSON.parse(out!);
		expect(parsed.params.data).toEqual(inner);
	});

	it("returns null for non-message events (ready / error / heartbeat)", () => {
		const cases = [
			JSON.stringify({ type: "system.ready" }),
			JSON.stringify({ type: "error", error: "bus down" }),
			JSON.stringify({ event: { no_message_field: true } }),
		];
		for (const c of cases) {
			expect(transformLine(c)).toBeNull();
		}
	});

	it("returns null for events missing message_id", () => {
		const input = JSON.stringify({
			event: { message: { chat_id: "oc_xxx" } }, // no message_id
		});
		expect(transformLine(input)).toBeNull();
	});

	it("returns null for invalid JSON without throwing", () => {
		const edges = ["", " ", "not json {", "null", "[]"];
		for (const edge of edges) {
			expect(transformLine(edge)).toBeNull();
		}
	});

	it("accepts events where the message object is at the top level (no envelope)", () => {
		// Some lark-cli output variants put fields directly at the top level
		// rather than under an `event` envelope. The shim should fall back.
		const input = JSON.stringify({
			message: { message_id: "om_top", chat_id: "oc_top" },
		});

		const out = transformLine(input);
		expect(out).not.toBeNull();
		const parsed = JSON.parse(out!);
		expect(parsed.params.id).toBe("om_top");
	});

	it("emits exactly one notification per non-empty input line", () => {
		const input = JSON.stringify({
			event: { message: { message_id: "om_x", chat_id: "oc_x" } },
		});

		const out = transformLine(input);
		expect(out).not.toBeNull();
		// Each notification must end with exactly one trailing newline when
		// piped through stdout; the wrapper of transformLine is responsible.
		// transformLine itself returns a single JSON string with no trailing
		// newline (the caller appends `\n`).
		expect(out!.endsWith("\n")).toBe(false);
		// The caller must produce valid JSON without leading whitespace.
		expect(() => JSON.parse(out!)).not.toThrow();
	});
});
