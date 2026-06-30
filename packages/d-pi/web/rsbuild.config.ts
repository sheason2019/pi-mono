import { defineConfig } from "@rsbuild/core";
import { pluginReact } from "@rsbuild/plugin-react";
import { pluginTailwindcss } from "@rsbuild/plugin-tailwindcss";
import path from "node:path";

export default defineConfig({
	plugins: [
		pluginReact({
			reactCompiler: true,
		}),
		pluginTailwindcss(),
	],
	html: {
		template: "./index.html",
	},
	server: {
		base: "/ui/",
		proxy: {
			"/api": "http://localhost:4848",
		},
	},
	output: {
		distPath: {
			root: "../dist/web",
		},
		assetPrefix: "/ui/",
		cleanDistPath: true,
	},
	source: {
		entry: {
			index: "./src/main.tsx",
		},
		alias: {
			"@": path.resolve(__dirname, "./src"),
		},
	},
	tools: {
		postcss: {
			postcssOptions: {
				plugins: ["@tailwindcss/postcss"],
			},
		},
	},
});
