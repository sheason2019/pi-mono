import { describe, expect, it } from "vitest";
import type { PublicOrgAgent } from "../src/d-pi-hub-protocol.js";
import {
	createPublicOrgTreeLayout,
	getPublicOrgTreePlaneStyle,
	getPublicOrgTreeScaledViewportStyle,
	normalizePublicOrgTreeZoom,
} from "../src/d-pi-public-org.js";

function agent(id: string, parentId?: string): PublicOrgAgent {
	return {
		id,
		name: id,
		parentId,
		kind: parentId ? "child" : "root",
		lifecycle: "persistent",
		activationStatus: "running",
		isRunning: false,
		peerCount: 0,
		hasError: false,
		hasProviderError: false,
		model: { provider: "openai", modelId: `model-${id}` },
	};
}

describe("public org tree layout", () => {
	it("spreads sibling cards vertically and connects card edges", () => {
		const layout = createPublicOrgTreeLayout([
			agent("root"),
			agent("child-a", "root"),
			agent("child-b", "root"),
			agent("child-c", "root"),
		]);

		const root = layout.nodes.find((node) => node.agent.id === "root");
		const childA = layout.nodes.find((node) => node.agent.id === "child-a");
		const childB = layout.nodes.find((node) => node.agent.id === "child-b");
		const rootToChildA = layout.edges.find((edge) => edge.parentId === "root" && edge.childId === "child-a");

		expect(root).toBeDefined();
		expect(childA).toBeDefined();
		expect(childB).toBeDefined();
		expect(rootToChildA).toBeDefined();
		expect(childB!.y - childA!.y).toBeGreaterThanOrEqual(layout.card.height + layout.gap.y);
		expect(rootToChildA!.from.x).toBe(root!.x + layout.card.width);
		expect(rootToChildA!.to.x).toBe(childA!.x);
		expect(rootToChildA!.from.y).toBe(root!.y + layout.card.height / 2);
		expect(rootToChildA!.to.y).toBe(childA!.y + layout.card.height / 2);
	});

	it("keeps the SVG plane in the same fixed pixel coordinate system as HTML cards", () => {
		const layout = createPublicOrgTreeLayout([agent("root"), agent("child-a", "root")]);

		expect(getPublicOrgTreePlaneStyle(layout)).toBe(`width:${layout.width}px;height:${layout.height}px;`);
	});

	it("scales the shared plane while reserving matching viewport space", () => {
		const layout = createPublicOrgTreeLayout([agent("root"), agent("child-a", "root")]);

		expect(getPublicOrgTreeScaledViewportStyle(layout, 0.75)).toBe(
			`width:${layout.width * 0.8}px;height:${layout.height * 0.8}px;`,
		);
		expect(getPublicOrgTreePlaneStyle(layout, 0.75)).toBe(
			`width:${layout.width}px;height:${layout.height}px;transform:scale(0.8);transform-origin:top left;`,
		);
	});

	it("clamps tree zoom to a readable range", () => {
		expect(normalizePublicOrgTreeZoom(0.1)).toBe(0.5);
		expect(normalizePublicOrgTreeZoom(1.26)).toBe(1.3);
		expect(normalizePublicOrgTreeZoom(3)).toBe(1.8);
	});
});
