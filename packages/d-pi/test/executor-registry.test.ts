import { beforeEach, describe, expect, it } from "vitest";
import { ExecutorRegistry } from "../src/hub/executor-registry.ts";

describe("ExecutorRegistry", () => {
	let registry: ExecutorRegistry;

	beforeEach(() => {
		registry = new ExecutorRegistry();
	});

	it("registers an executor under a connectId", () => {
		registry.register("c1", { cwd: "/tmp", sseConn: { send: () => {} } });
		expect(registry.get("c1")).toBeDefined();
		expect(registry.get("c1")!.cwd).toBe("/tmp");
	});

	it("rejects duplicate registration of the same connectId", () => {
		registry.register("c1", { cwd: "/tmp", sseConn: { send: () => {} } });
		expect(() => registry.register("c1", { cwd: "/other", sseConn: { send: () => {} } })).toThrow(
			/already registered/i,
		);
	});

	it("deregisters and returns true when connectId exists", () => {
		registry.register("c1", { cwd: "/tmp", sseConn: { send: () => {} } });
		expect(registry.deregister("c1")).toBe(true);
		expect(registry.get("c1")).toBeUndefined();
	});

	it("deregister returns false when connectId unknown", () => {
		expect(registry.deregister("nope")).toBe(false);
	});

	it("stores and resolves pending calls by callId", () => {
		registry.register("c1", { cwd: "/tmp", sseConn: { send: () => {} } });
		const fakeRes = { writeHead: () => {}, end: () => {} } as never;
		registry.addPending("c1", "call-1", fakeRes);
		expect(registry.getPending("c1", "call-1")).toBe(fakeRes);
		registry.removePending("c1", "call-1");
		expect(registry.getPending("c1", "call-1")).toBeUndefined();
	});

	it("deregister rejects all pending calls with an error", () => {
		registry.register("c1", { cwd: "/tmp", sseConn: { send: () => {} } });
		let captured: unknown;
		const fakeRes = {
			writeHead: () => {},
			end: (body: string) => {
				captured = JSON.parse(body);
			},
		} as never;
		registry.addPending("c1", "call-1", fakeRes);
		registry.deregister("c1");
		expect(captured).toEqual({ ok: false, error: expect.stringContaining("disconnected") });
	});
});
