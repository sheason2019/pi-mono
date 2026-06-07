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
	},
	resolve: {
		alias: [
			{ find: /^@sheason\/pi-ai$/, replacement: aiSrcIndex },
			{ find: /^@sheason\/pi-ai\/oauth$/, replacement: aiSrcOAuth },
			{ find: /^@sheason\/pi-agent-core$/, replacement: agentSrcIndex },
			{ find: /^@sheason\/pi-coding-agent$/, replacement: codingAgentSrcIndex },
			{ find: /^@sheason\/pi-coding-agent\/d-pi-worker$/, replacement: codingAgentSrcWorker },
			{ find: /^@sheason\/pi-tui$/, replacement: tuiSrcIndex },
		],
	},
});
