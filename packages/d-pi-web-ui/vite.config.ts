import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [tailwindcss()],
	build: {
		chunkSizeWarningLimit: 4096,
		rollupOptions: {
			output: {
				manualChunks(id) {
					if (!id.includes("node_modules")) {
						return undefined;
					}
					if (id.includes("pdfjs-dist")) {
						return "vendor-pdfjs";
					}
					if (id.includes("katex")) {
						return "vendor-katex";
					}
					if (id.includes("@automerge")) {
						return "vendor-automerge";
					}
					if (id.includes("socket.io-client") || id.includes("engine.io-client")) {
						return "vendor-socket";
					}
					return undefined;
				},
			},
		},
	},
	resolve: {
		alias: {
			"@automerge/automerge": resolve(
				__dirname,
				"../../node_modules/@automerge/automerge/dist/mjs/entrypoints/fullfat_base64.js",
			),
			"@earendil-works/pi-agent-core": resolve(__dirname, "../agent/src/index.ts"),
			"@earendil-works/pi-ai": resolve(__dirname, "../ai/src/index.ts"),
			"@earendil-works/pi-web-ui": resolve(__dirname, "../web-ui/src/index.ts"),
		},
	},
});
