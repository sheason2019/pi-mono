import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import rspack from "@rspack/core";

const packageRoot = dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8"));
const packageVersion = packageJson.version;
const aiEnvApiKeysDistPath = resolve(packageRoot, "../ai/dist/env-api-keys.js").replace(
	/[.*+?^${}()|[\]\\]/g,
	"\\$&",
);
const dPiNodeEnvApiKeysPath = resolve(packageRoot, "src/shims/env-api-keys-node.js");
const nodeImportMetaResolveLoaderPath = resolve(packageRoot, "scripts/rspack-node-import-meta-resolve-loader.cjs");

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
		},
		extensionAlias: {
			".js": [".ts", ".tsx", ".js"],
			".mjs": [".mts", ".mjs"],
		},
		extensions: ["...", ".ts", ".tsx"],
	},
	externals: {
		"@libsql/client": "commonjs @libsql/client",
		"@node-rs/jieba": "commonjs @node-rs/jieba",
		"@node-rs/jieba/dict.js": "commonjs @node-rs/jieba/dict.js",
		bufferutil: "commonjs bufferutil",
		"socket.io-client": "commonjs socket.io-client",
		"utf-8-validate": "commonjs utf-8-validate",
	},
	module: {
		parser: {
			javascript: {
				importMetaResolve: true,
			},
			"javascript/auto": {
				importMetaResolve: true,
			},
			"javascript/esm": {
				importMetaResolve: true,
			},
		},
		rules: [
			{
				test: /packages\/coding-agent\/dist\/core\/extensions\/loader\.js$/,
				loader: nodeImportMetaResolveLoaderPath,
			},
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
				test: /node_modules\/jiti\/lib\/jiti\.mjs$/,
				parser: {
					exprContextCritical: false,
				},
			},
			{
				test: /packages\/(?:ai\/dist\/(?:env-api-keys|providers\/(?:openai-codex-responses|register-builtins))|coding-agent\/dist\/core\/extensions\/loader)\.js$/,
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
		new rspack.NormalModuleReplacementPlugin(new RegExp(`^${aiEnvApiKeysDistPath}$`), dPiNodeEnvApiKeysPath),
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
					from: resolve(packageRoot, "../coding-agent/dist/modes/interactive/theme"),
					to: "dist/modes/interactive/theme",
				},
				{
					from: resolve(packageRoot, "../coding-agent/dist/core/export-html"),
					to: "dist/core/export-html",
				},
			],
		}),
	],
};
