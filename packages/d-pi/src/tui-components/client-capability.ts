import { writeFileSync } from "node:fs";
import { join } from "node:path";

const CLIENT_CAPABILITY_FILENAME = ".d-pi-tui-components-capability.ts";

const CLIENT_CAPABILITY_SOURCE = `import agentDefinition from "./agent.ts";
import { installAgentTuiComponents } from "@sheason/d-pi";

export default function server() {}

export function client(pi) {
\tinstallAgentTuiComponents(agentDefinition, {
\t\tregisterTuiComponentRenderer(customType, render) {
\t\t\tpi.registerMessageRenderer(customType, render);
\t\t},
\t});
}
`;

export function ensureAgentTuiComponentsClientCapability(agentDir: string): string {
	const capabilityPath = join(agentDir, CLIENT_CAPABILITY_FILENAME);
	writeFileSync(capabilityPath, CLIENT_CAPABILITY_SOURCE);
	return capabilityPath;
}
