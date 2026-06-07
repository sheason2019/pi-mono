import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const aiSrcIndex = fileURLToPath(new URL("../ai/src/index.ts", import.meta.url));
const agentSrcIndex = fileURLToPath(new URL("./src/index.ts", import.meta.url));

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		testTimeout: 30000, // 30 seconds for API calls
	},
	resolve: {
		alias: [
			{ find: /^@sheason\/pi-ai$/, replacement: aiSrcIndex },
			{ find: /^@sheason\/pi-agent-core$/, replacement: agentSrcIndex },
		],
	},
});
