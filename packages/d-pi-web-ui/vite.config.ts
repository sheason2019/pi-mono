import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";
import { defineConfig } from "vite";

const aiSourceDir = resolve(__dirname, "../ai/src");
const aiBrowserEnvApiKeys = resolve(aiSourceDir, "env-api-keys.browser.ts");

export default defineConfig({
	plugins: [
		{
			name: "d-pi-web-ui-pi-ai-browser-env-api-keys",
			enforce: "pre",
			resolveId(source, importer) {
				if (!importer?.startsWith(aiSourceDir)) return undefined;
				if (source === "./env-api-keys.js" || source === "../env-api-keys.js" || source === "../../env-api-keys.js") {
					return aiBrowserEnvApiKeys;
				}
				return undefined;
			},
		},
		tailwindcss(),
	],
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
		alias: [
			{
				find: /^@automerge\/automerge$/,
				replacement: resolve(
					__dirname,
					"../../node_modules/@automerge/automerge/dist/mjs/entrypoints/fullfat_base64.js",
				),
			},
			{ find: /^@earendil-works\/pi-agent-core$/, replacement: resolve(__dirname, "../agent/src/index.ts") },
			{ find: /^@earendil-works\/pi-ai$/, replacement: resolve(__dirname, "../ai/src/index.ts") },
			{ find: /^@earendil-works\/pi-web-ui$/, replacement: resolve(__dirname, "../web-ui/src/index.ts") },
		],
	},
});
