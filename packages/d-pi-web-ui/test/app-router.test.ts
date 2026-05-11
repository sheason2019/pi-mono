import { describe, expect, it } from "vitest";
import { getRootAppView } from "../src/app-router.js";

describe("D-Pi Web UI root router", () => {
	it("uses the public org dashboard for the root path", () => {
		expect(getRootAppView("/")).toBe("public-org");
		expect(getRootAppView("/index.html")).toBe("public-org");
	});

	it("preserves legacy root token links for the agent UI", () => {
		expect(getRootAppView("/", "?token=dpi_test")).toBe("agent-ui");
		expect(getRootAppView("/index.html", "?token=dpi_test")).toBe("agent-ui");
	});

	it("keeps agent routes on the token-protected control UI", () => {
		expect(getRootAppView("/agents/root")).toBe("agent-ui");
		expect(getRootAppView("/agents/child-a")).toBe("agent-ui");
	});
});
