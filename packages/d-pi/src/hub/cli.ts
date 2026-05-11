import { runAddSkills } from "./commands/add-skills.js";
import { runClean } from "./commands/clean.js";
import { runExport } from "./commands/export.js";
import { runImport } from "./commands/import.js";
import { runInit } from "./commands/init.js";
import { parseHubServeArgs, runServe } from "./commands/serve.js";
import { runStatus } from "./commands/status.js";
import { APP_NAME, VERSION } from "./config.js";

function printHelp(): void {
	console.log(`${APP_NAME} ${VERSION}

Usage:
  ${APP_NAME} <command>

Commands:
  add-skills  Install built-in pi agent guidance skills into .pi/skills
  init        Initialize a single-session D-Pi hub workspace
  serve       Start the D-Pi hub socket.io runtime
  export      Export .pi-hub and .pi workspace state to a tar archive
  import      Import .pi-hub and .pi workspace state from a tar archive
  clean       Remove D-Pi hub workspace state
  status      Show current D-Pi hub workspace status
  help        Show this help
  version     Show version

Examples:
  ${APP_NAME} init
  ${APP_NAME} serve
  ${APP_NAME} serve --panel
  ${APP_NAME} serve --allow-hub-no-model
  ${APP_NAME} export ./workspace.tar
  ${APP_NAME} import ./workspace.tar --force
`);
}

export async function runPiHubCli(args: string[] = process.argv.slice(2)): Promise<number> {
	const [command, ...rest] = args;

	switch (command) {
		case undefined:
		case "help":
		case "--help":
		case "-h":
			printHelp();
			return 0;
		case "version":
		case "--version":
		case "-v":
			console.log(VERSION);
			return 0;
		case "add-skills":
			runAddSkills();
			return 0;
		case "init":
			return runInit();
		case "serve":
			return runServe(process.cwd(), parseHubServeArgs(rest));
		case "export":
			return runExport(rest);
		case "import":
			return runImport(rest);
		case "clean":
			return runClean();
		case "status":
			return runStatus();
		default:
			console.error(`Unknown command: ${command}`);
			printHelp();
			return 1;
	}
}
