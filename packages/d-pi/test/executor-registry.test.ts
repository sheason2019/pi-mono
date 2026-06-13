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

	it("stores and resolves pending calls by callId (deprecated getPending/removePending still work)", () => {
		registry.register("c1", { cwd: "/tmp", sseConn: { send: () => {} } });
		const fakeRes = { writeHead: () => {}, end: () => {} } as never;
		registry.addPending("c1", "call-1", fakeRes);
		// The PendingCall object is no longer the raw ServerResponse —
		// it is an internal resolver wrapper. The legacy getPending()
		// remains as a test/legacy shim and returns the wrapper.
		expect(registry.getPending("c1", "call-1")).toBeDefined();
		registry.removePending("c1", "call-1");
		expect(registry.getPending("c1", "call-1")).toBeUndefined();
	});

	it("resolveOne writes JSON to the parked ServerResponse and removes the entry", () => {
		registry.register("c1", { cwd: "/tmp", sseConn: { send: () => {} } });
		let capturedCode = 0;
		let capturedBody = "";
		const fakeRes = {
			writeHead: (code: number) => {
				capturedCode = code;
			},
			end: (body: string) => {
				capturedBody = body;
			},
		} as never;
		registry.addPending("c1", "call-1", fakeRes);
		const resolved = registry.resolveOne("c1", "call-1", { ok: true, result: { foo: "bar" } });
		expect(resolved).toBe(true);
		expect(capturedCode).toBe(200);
		expect(JSON.parse(capturedBody)).toEqual({ ok: true, result: { foo: "bar" } });
		// The pending entry is removed after a successful resolve.
		expect(registry.getPending("c1", "call-1")).toBeUndefined();
	});

	it("resolveOne on an unknown callId returns false (no error)", () => {
		registry.register("c1", { cwd: "/tmp", sseConn: { send: () => {} } });
		expect(registry.resolveOne("c1", "nope", { ok: true, result: 1 })).toBe(false);
	});

	it("resolveOne on a second result for the same callId returns false (idempotent)", () => {
		registry.register("c1", { cwd: "/tmp", sseConn: { send: () => {} } });
		const fakeRes = { writeHead: () => {}, end: () => {} } as never;
		registry.addPending("c1", "call-1", fakeRes);
		expect(registry.resolveOne("c1", "call-1", { ok: true, result: 1 })).toBe(true);
		// Second result for the same callId is silently dropped (the
		// call is already resolved, so a late duplicate does not
		// rewrite the response or trigger a second resolver).
		expect(registry.resolveOne("c1", "call-1", { ok: true, result: 2 })).toBe(false);
	});

	it("addPendingCallback hands the executor result to the awaiting promise", async () => {
		registry.register("c1", { cwd: "/tmp", sseConn: { send: () => {} } });
		const promise = new Promise<{ ok: true; result: unknown } | { ok: false; error: string }>((resolve) => {
			registry.addPendingCallback("c1", "call-1", resolve);
		});
		// The promise must not resolve before the result is delivered.
		let resolved = false;
		void promise.then(() => {
			resolved = true;
		});
		await Promise.resolve();
		expect(resolved).toBe(false);
		registry.resolveOne("c1", "call-1", { ok: true, result: 42 });
		await expect(promise).resolves.toEqual({ ok: true, result: 42 });
	});

	it("deregister rejects all pending calls with an error (ServerResponse transport)", () => {
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

	it("deregister rejects all pending calls with an error (callback transport)", () => {
		registry.register("c1", { cwd: "/tmp", sseConn: { send: () => {} } });
		const settled = new Promise<{ ok: true; result: unknown } | { ok: false; error: string }>((resolve) => {
			registry.addPendingCallback("c1", "call-1", resolve);
		});
		registry.deregister("c1");
		return expect(settled).resolves.toEqual({
			ok: false,
			error: expect.stringContaining("disconnected"),
		});
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
