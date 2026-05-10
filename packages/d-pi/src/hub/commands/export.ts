import { exportWorkspaceArchive } from "../workspace.js";

function printExportHelp(): void {
	console.log(`Usage: d-pi hub export <archive.tar>

Export the current workspace state into a single tar archive.

Included workspace roots:
  .pi-hub/  Hub runtime state, session history, and agent state
  .pi/      Workspace-local Pi configuration, sources, agents, and skills
  .child-agent/  Child agent workspaces and session history

Examples:
  d-pi hub export ./workspace.tar
`);
}

export function runExport(args: string[] = process.argv.slice(3), cwd: string = process.cwd()): number {
	if (args.includes("--help") || args.includes("-h")) {
		printExportHelp();
		return 0;
	}
	const archivePath = args[0];
	if (!archivePath || args.length !== 1) {
		printExportHelp();
		return 1;
	}
	const result = exportWorkspaceArchive(archivePath, cwd);
	console.log(`Exported D-Pi hub workspace archive: ${result.archivePath}`);
	console.log(`Included: ${result.includedRoots.join(", ")}`);
	return 0;
}
