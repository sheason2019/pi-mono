import { readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const CLIENT_CAPABILITY_FILENAME = ".d-pi-tui-components-capability.ts";
const PARENT_AGENT_IMPORT_RE = /import\s+parentAgent\s+from\s+["'](\.\.\/[^"']+\/agent\.ts)["'];?/g;

function toPosixPath(path: string): string {
	return path.split(sep).join("/");
}

function isPathInside(path: string, parent: string): boolean {
	const rel = relative(parent, path);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function collectAgentDefinitionFiles(agentDir: string, workspaceRoot: string | undefined): string[] {
	const resolvedAgentDir = resolve(agentDir);
	const agentsRoot = workspaceRoot ? resolve(workspaceRoot, "agents") : resolve(resolvedAgentDir, "..");
	const visited = new Set<string>();
	const files: string[] = [];

	const visit = (filePath: string) => {
		const resolvedPath = resolve(filePath);
		if (visited.has(resolvedPath)) {
			return;
		}
		if (!isPathInside(resolvedPath, agentsRoot)) {
			throw new Error(`Agent definition loadable escapes agents root: ${resolvedPath}`);
		}
		visited.add(resolvedPath);
		files.push(toPosixPath(relative(resolvedAgentDir, resolvedPath)));

		const source = readFileSync(resolvedPath, "utf-8");
		for (const match of source.matchAll(PARENT_AGENT_IMPORT_RE)) {
			visit(resolve(dirname(resolvedPath), match[1]));
		}
	};

	visit(join(resolvedAgentDir, "agent.ts"));
	return files;
}

function buildClientCapabilitySource(loadableFiles: string[]): string {
	return `/* @pi-client-loadable-files: ${JSON.stringify(loadableFiles)} */
import agentDefinition from "./agent.ts";
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
}

export function ensureAgentTuiComponentsClientCapability(
	agentDir: string,
	options: { workspaceRoot?: string } = {},
): string {
	const capabilityPath = join(agentDir, CLIENT_CAPABILITY_FILENAME);
	const loadableFiles = collectAgentDefinitionFiles(agentDir, options.workspaceRoot);
	writeFileSync(capabilityPath, buildClientCapabilitySource(loadableFiles));
	return capabilityPath;
}
