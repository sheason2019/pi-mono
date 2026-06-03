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

	it("treats DPI_AUTH_TOKEN as optional (dev mode)", () => {
		const env = readExecutorEnv({
			DPI_HUB_URL: "http://h:1234",
			DPI_CONNECT_ID: "c1",
			DPI_CWD: "/tmp",
		});
		expect(env.authToken).toBeUndefined();
	});

	it("throws if any required var is missing", () => {
		expect(() => readExecutorEnv({})).toThrow(/DPI_HUB_URL/);
		expect(() => readExecutorEnv({ DPI_HUB_URL: "x" })).toThrow(/DPI_CONNECT_ID/);
		expect(() => readExecutorEnv({ DPI_HUB_URL: "x", DPI_CONNECT_ID: "c" })).toThrow(/DPI_CWD/);
	});

	it("does not require DPI_AUTH_TOKEN in the missing-vars list", () => {
		expect(() => readExecutorEnv({})).not.toThrow(/DPI_AUTH_TOKEN/);
	});
});
