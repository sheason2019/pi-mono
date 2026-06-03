import { describe, expect, it } from "vitest";
import { readExecutorEnv } from "../src/executor/env.ts";

describe("executor env", () => {
	it("parses required env vars", () => {
		const env = readExecutorEnv({
			DPI_HUB_URL: "http://h:1234",
			DPI_AUTH_TOKEN: "tok",
			DPI_CONNECT_ID: "c1",
			DPI_CWD: "/tmp",
		});
		expect(env).toEqual({
			hubUrl: "http://h:1234",
			authToken: "tok",
			connectId: "c1",
			cwd: "/tmp",
		});
	});

	it("throws if any var missing", () => {
		expect(() => readExecutorEnv({ DPI_HUB_URL: "x" })).toThrow(/DPI_AUTH_TOKEN/);
		expect(() => readExecutorEnv({ DPI_HUB_URL: "x", DPI_AUTH_TOKEN: "t" })).toThrow(/DPI_CONNECT_ID/);
		expect(() => readExecutorEnv({ DPI_HUB_URL: "x", DPI_AUTH_TOKEN: "t", DPI_CONNECT_ID: "c" })).toThrow(/DPI_CWD/);
	});

	it("throws listing all missing vars when many are absent", () => {
		expect(() => readExecutorEnv({})).toThrow(/DPI_HUB_URL/);
		expect(() => readExecutorEnv({})).toThrow(/DPI_AUTH_TOKEN/);
		expect(() => readExecutorEnv({})).toThrow(/DPI_CONNECT_ID/);
		expect(() => readExecutorEnv({})).toThrow(/DPI_CWD/);
	});
});
