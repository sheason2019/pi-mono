import { installBuiltInSkills } from "../../skills/install-built-ins.js";

export interface RunAddSkillsOptions {
	cwd?: string;
	log?: (message: string) => void;
}

export function runAddSkills(options: RunAddSkillsOptions = {}): { installed: string[] } {
	return installBuiltInSkills({
		cwd: options.cwd ?? process.cwd(),
		log: options.log ?? console.log,
	});
}
