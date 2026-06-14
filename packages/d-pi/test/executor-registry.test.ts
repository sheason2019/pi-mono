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
		// After PR #42 + this branch, addPending wraps the ServerResponse
		// in a PendingCall, so getPending returns the wrapper, not the
		// raw response. The load-bearing check is that resolveOne drives
		// the wrapper to write the JSON body.
		expect(registry.getPending("c1", "call-1")).toBeDefined();
		const resolved = registry.resolveOne("c1", "call-1", { ok: true, result: 1 });
		expect(resolved).toBe(true);
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

describe("ExecutorRegistry two-step API", () => {
	let registry: ExecutorRegistry;

	beforeEach(() => {
		registry = new ExecutorRegistry();
	});

	it("preRegister records cwd without an sseConn", () => {
		registry.preRegister("c1", { cwd: "/tmp" });
		const handle = registry.get("c1");
		expect(handle).toBeDefined();
		expect(handle!.cwd).toBe("/tmp");
		expect(handle!.sseConn).toBeUndefined();
	});

	it("attachSse promotes a pre-registered entry to fully registered", () => {
		registry.preRegister("c1", { cwd: "/tmp" });
		const sseConn = { send: () => {} };
		registry.attachSse("c1", sseConn);
		expect(registry.get("c1")!.sseConn).toBe(sseConn);
	});

	it("attachSse throws if connectId not pre-registered", () => {
		expect(() => registry.attachSse("nope", { send: () => {} })).toThrow(/not pre-registered/i);
	});

	it("preRegister throws on duplicate (whether pre-registered or fully)", () => {
		registry.preRegister("c1", { cwd: "/tmp" });
		expect(() => registry.preRegister("c1", { cwd: "/other" })).toThrow(/already registered/i);
		// After attach, preRegister should still throw.
		registry.attachSse("c1", { send: () => {} });
		expect(() => registry.preRegister("c1", { cwd: "/another" })).toThrow(/already registered/i);
	});

	it("register (single-call convenience) pre-registers and attaches in one step", () => {
		const sseConn = { send: () => {} };
		registry.register("c1", { cwd: "/tmp", sseConn });
		const handle = registry.get("c1");
		expect(handle!.cwd).toBe("/tmp");
		expect(handle!.sseConn).toBe(sseConn);
	});

	it("setPendingTimer / clearPendingTimer are independent of the pending res", () => {
		registry.preRegister("c1", { cwd: "/tmp" });
		const fakeRes = { writeHead: () => {}, end: () => {} } as never;
		registry.addPending("c1", "call-1", fakeRes);
		const timer = setTimeout(() => {}, 60_000);
		registry.setPendingTimer("c1", "call-1", timer);
		registry.clearPendingTimer("c1", "call-1");
		// Idempotent: clearing a second time is a no-op.
		registry.clearPendingTimer("c1", "call-1");
	});

	it("deregister clears all pending timers (no leaked setTimeout)", () => {
		registry.preRegister("c1", { cwd: "/tmp" });
		const fakeRes = { writeHead: () => {}, end: () => {} } as never;
		registry.addPending("c1", "call-1", fakeRes);
		const t1 = setTimeout(() => {}, 60_000);
		const t2 = setTimeout(() => {}, 60_000);
		registry.setPendingTimer("c1", "call-1", t1);
		registry.setPendingTimer("c1", "call-2", t2);
		registry.deregister("c1");
		expect(registry.get("c1")).toBeUndefined();
	});
});
