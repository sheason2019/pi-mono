import { importWorkspaceArchive } from "../workspace.js";

function printImportHelp(): void {
	console.log(`Usage: d-pi hub import <archive.tar> [--force]

Import workspace state from a tar archive created by "d-pi hub export".

Behavior:
  - Restores .pi-hub/, .pi/, and .child-agent/ into the current working directory.
  - Refuses to overwrite an existing .pi-hub/, .pi/, or .child-agent/ directory by default.
  - Use --force to replace existing workspace state.
  - Rejects archive entries outside .pi-hub/, .pi/, and .child-agent/.

Examples:
  d-pi hub import ./workspace.tar
  d-pi hub import ./workspace.tar --force
`);
}

export function runImport(args: string[] = process.argv.slice(3), cwd: string = process.cwd()): number {
	if (args.includes("--help") || args.includes("-h")) {
		printImportHelp();
		return 0;
	}
	const archivePath = args.find((arg) => arg !== "--force");
	const unknown = args.filter((arg) => arg !== "--force" && arg !== archivePath);
	if (!archivePath || unknown.length > 0) {
		printImportHelp();
		return 1;
	}
	const result = importWorkspaceArchive(archivePath, cwd, { force: args.includes("--force") });
	console.log(`Imported D-Pi hub workspace archive: ${result.archivePath}`);
	console.log(`Included: ${result.includedRoots.join(", ")}`);
	return 0;
}
