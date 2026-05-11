import { describe, expect, it, vi } from "vitest";

vi.mock("../src/utils/photon.js", () => ({
	loadPhoton: vi.fn(async () => null),
}));

import { resizeImage } from "../src/utils/image-resize.js";

const TINY_PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP8z8DwnwEJMDGgAcQBAL9dBAjzsQWYAAAAAElFTkSuQmCC";

describe("resizeImage without Photon", () => {
	it("returns an already-small image instead of omitting it", async () => {
		const result = await resizeImage(
			{ type: "image", data: TINY_PNG, mimeType: "image/png" },
			{ maxWidth: 100, maxHeight: 100, maxBytes: 1024 * 1024 },
		);

		expect(result).toEqual({
			data: TINY_PNG,
			mimeType: "image/png",
			originalWidth: 2,
			originalHeight: 2,
			width: 2,
			height: 2,
			wasResized: false,
		});
	});
});
