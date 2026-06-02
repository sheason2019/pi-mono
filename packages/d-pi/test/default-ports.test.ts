import { describe, expect, it } from "vitest";
import { DEFAULT_AGENT_PORT_START, DEFAULT_HUB_PORT } from "../src/defaults.ts";

describe("d-pi default ports", () => {
	it("uses high default ports to avoid common local services", () => {
		expect(DEFAULT_HUB_PORT).toBe(39090);
		expect(DEFAULT_AGENT_PORT_START).toBe(39091);
	});
});
