import { cleanWorkspace } from "../workspace.js";

export function runClean(cwd: string = process.cwd()): number {
	const paths = cleanWorkspace(cwd);
	console.log(`Cleaned pi-hub workspace: ${paths.workspaceDir}`);
	return 0;
}
