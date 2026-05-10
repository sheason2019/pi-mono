export type DPiSubcommand = "hub" | "peer";

export interface ResolvedDPiCommand {
	subcommand: DPiSubcommand;
	args: string[];
	env?: Record<string, string>;
}

function isSubcommand(value: string | undefined): value is DPiSubcommand {
	return value === "hub" || value === "peer";
}

export function getDPiHelpText(appName = "d-pi"): string {
	return `D-Pi

Usage:
  ${appName} <command> [args...]

Examples:
  ${appName} hub serve
  ${appName} peer --hub http://127.0.0.1:4317
  ${appName} --version

Commands:
  hub      Run the D-Pi hub with the remaining arguments
  peer     Run the D-Pi peer with the remaining arguments
  version  Show D-Pi version and hub protocol version (also: --version, -v)
  help     Show this help
`;
}

export function resolveDPiCommand(
	args: string[],
	sourceEnv: Record<string, string | undefined> = process.env,
): ResolvedDPiCommand | undefined {
	const [subcommand, ...rest] = args;
	if (!isSubcommand(subcommand)) {
		return undefined;
	}
	const env = getDPiCommandEnv(subcommand, rest, sourceEnv);
	return {
		subcommand,
		args: rest,
		...(env === undefined ? {} : { env }),
	};
}

function getDPiCommandEnv(
	subcommand: DPiSubcommand,
	args: readonly string[],
	sourceEnv: Record<string, string | undefined>,
): Record<string, string> | undefined {
	if (subcommand !== "hub" || args[0] !== "serve" || sourceEnv.PI_HUB_HOST?.trim()) {
		return undefined;
	}
	return { PI_HUB_HOST: "0.0.0.0" };
}
