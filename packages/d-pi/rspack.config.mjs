import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import rspack from "@rspack/core";

const packageRoot = dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8"));
const packageVersion = packageJson.version;
const aiEnvApiKeysPath = resolve(packageRoot, "../ai/src/env-api-keys.ts").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const dPiNodeEnvApiKeysPath = resolve(packageRoot, "src/shims/env-api-keys-node.ts");

export default {
	mode: "production",
	target: "node",
	entry: {
		cli: "./src/cli.ts",
	},
	output: {
		path: resolve(packageRoot, "dist"),
		filename: "cli.cjs",
		chunkFilename: "[name].cjs",
		clean: true,
	},
	resolve: {
		alias: {
			"@automerge/automerge$": resolve(
				packageRoot,
				"../../node_modules/@automerge/automerge/dist/mjs/entrypoints/fullfat_base64.js",
			),
			"@earendil-works/pi-agent-core": resolve(packageRoot, "../agent/src/index.ts"),
			"@earendil-works/pi-ai": resolve(packageRoot, "../ai/src/index.ts"),
			"@earendil-works/pi-ai/bedrock-provider": resolve(packageRoot, "../ai/src/bedrock-provider.ts"),
			"@earendil-works/pi-ai/oauth": resolve(packageRoot, "../ai/src/oauth.ts"),
			"@earendil-works/pi-coding-agent": resolve(packageRoot, "../coding-agent/src/index.ts"),
			"@earendil-works/pi-tui": resolve(packageRoot, "../tui/src/index.ts"),
			"jiti/static": resolve(packageRoot, "../../node_modules/jiti/lib/jiti.mjs"),
		},
		extensionAlias: {
			".js": [".ts", ".tsx", ".js"],
			".mjs": [".mts", ".mjs"],
		},
		extensions: ["...", ".ts", ".tsx"],
	},
	externals: {
		bufferutil: "commonjs bufferutil",
		"socket.io-client": "commonjs socket.io-client",
		"utf-8-validate": "commonjs utf-8-validate",
	},
	module: {
		rules: [
			{
				test: /\.[cm]?tsx?$/,
				exclude: /node_modules/,
				loader: "builtin:swc-loader",
				options: {
					jsc: {
						parser: {
							syntax: "typescript",
							tsx: true,
						},
						target: "es2022",
					},
				},
				parser: {
					exprContextCritical: false,
				},
			},
			{
				test: /node_modules\/@mariozechner\/jiti\/lib\/jiti\.mjs$/,
				parser: {
					exprContextCritical: false,
				},
			},
		],
	},
	optimization: {
		minimize: false,
	},
	plugins: [
		new rspack.DefinePlugin({
			__D_PI_BUNDLE_DIR__: "__dirname",
			__D_PI_VERSION__: JSON.stringify(packageVersion),
			"import.meta.url": 'module.require("node:url").pathToFileURL(module.filename).href',
		}),
		new rspack.NormalModuleReplacementPlugin(new RegExp(`^${aiEnvApiKeysPath}$`), dPiNodeEnvApiKeysPath),
		new rspack.BannerPlugin({
			banner: "#!/usr/bin/env node",
			raw: true,
			entryOnly: true,
		}),
		new rspack.CopyRspackPlugin({
			patterns: [
				{
					from: resolve(packageRoot, "../d-pi-web-ui/dist"),
					to: "web-ui",
				},
				{
					from: resolve(packageRoot, "src/skills/pi-agent-config-editing"),
					to: "skills/pi-agent-config-editing",
				},
				{
					from: resolve(packageRoot, "src/skills/reproducing-real-bugs-with-e2e"),
					to: "skills/reproducing-real-bugs-with-e2e",
				},
				{
					from: resolve(packageRoot, "../coding-agent/src/modes/interactive/theme"),
					to: "dist/modes/interactive/theme",
				},
				{
					from: resolve(packageRoot, "../coding-agent/src/core/export-html"),
					to: "dist/core/export-html",
					globOptions: {
						ignore: ["**/*.ts"],
					},
				},
			],
		}),
	],
};
