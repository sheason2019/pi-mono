import { cpSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { D_PI_BUILT_IN_SKILLS_DIR } from "../runtime/bundle-env.js";

export const PI_AGENT_CONFIG_EDITING_SKILL_NAME = "pi-agent-config-editing";
export const REPRODUCING_REAL_BUGS_WITH_E2E_SKILL_NAME = "reproducing-real-bugs-with-e2e";

export interface BuiltInSkill {
	name: string;
	sourceDir: string;
}

export interface InstallBuiltInSkillsOptions {
	cwd: string;
	log?: (message: string) => void;
}

export interface InstallBuiltInSkillsResult {
	installed: string[];
}

export function getBuiltInSkills(): BuiltInSkill[] {
	return [
		{
			name: PI_AGENT_CONFIG_EDITING_SKILL_NAME,
			sourceDir: join(D_PI_BUILT_IN_SKILLS_DIR, PI_AGENT_CONFIG_EDITING_SKILL_NAME),
		},
		{
			name: REPRODUCING_REAL_BUGS_WITH_E2E_SKILL_NAME,
			sourceDir: join(D_PI_BUILT_IN_SKILLS_DIR, REPRODUCING_REAL_BUGS_WITH_E2E_SKILL_NAME),
		},
	];
}

export function installBuiltInSkills(options: InstallBuiltInSkillsOptions): InstallBuiltInSkillsResult {
	const targetRoot = join(options.cwd, ".pi", "skills");
	const installed: string[] = [];
	mkdirSync(targetRoot, { recursive: true });

	for (const skill of getBuiltInSkills()) {
		const targetDir = join(targetRoot, skill.name);
		rmSync(targetDir, { recursive: true, force: true });
		cpSync(skill.sourceDir, targetDir, { recursive: true });
		const skillPath = join(targetDir, "SKILL.md");
		installed.push(skillPath);
		options.log?.(`Installed ${skill.name}: ${skillPath}`);
	}

	return { installed };
}
