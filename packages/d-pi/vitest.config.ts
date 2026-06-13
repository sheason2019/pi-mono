import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const aiSrcIndex = fileURLToPath(new URL("../ai/src/index.ts", import.meta.url));
const aiSrcOAuth = fileURLToPath(new URL("../ai/src/oauth.ts", import.meta.url));
const agentSrcIndex = fileURLToPath(new URL("../agent/src/index.ts", import.meta.url));
const codingAgentSrcIndex = fileURLToPath(new URL("../coding-agent/src/index.ts", import.meta.url));
const codingAgentSrcWorker = fileURLToPath(new URL("../coding-agent/src/d-pi-worker.ts", import.meta.url));
const tuiSrcIndex = fileURLToPath(new URL("../tui/src/index.ts", import.meta.url));

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		testTimeout: 30000,
		exclude: ["**/node_modules/**", "**/dist/**", "test/release-package-metadata.test.mjs"],
	},
	resolve: {
		alias: [
			{ find: /^@earendil-works\/pi-ai$/, replacement: aiSrcIndex },
			{ find: /^@earendil-works\/pi-ai\/oauth$/, replacement: aiSrcOAuth },
			{ find: /^@earendil-works\/pi-agent-core$/, replacement: agentSrcIndex },
			{ find: /^@earendil-works\/pi-coding-agent$/, replacement: codingAgentSrcIndex },
			{ find: /^@earendil-works\/pi-coding-agent\/d-pi-worker$/, replacement: codingAgentSrcWorker },
			{ find: /^@earendil-works\/pi-tui$/, replacement: tuiSrcIndex },
			{ find: /^@sheason\/pi-coding-agent$/, replacement: codingAgentSrcIndex },
			{ find: /^@sheason\/pi-coding-agent\/d-pi-worker$/, replacement: codingAgentSrcWorker },
		],
	},
});
