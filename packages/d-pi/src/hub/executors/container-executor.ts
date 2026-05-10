import { type ChildProcess, spawn as nodeSpawn } from "node:child_process";
import type { AgentExecutorConfig } from "../agents/types.js";

export interface StartNodeContainerExecutorInput {
	cwd: string;
	hubUrl: string;
	agentId: string;
	executor: AgentExecutorConfig;
}

export interface NodeContainerExecutorHandle {
	readonly process: ChildProcess;
	stop(): void;
}

export type SpawnProcess = (
	command: string,
	args: string[],
	options: { cwd: string; stdio: ["ignore", "pipe", "pipe"] },
) => ChildProcess;

export interface NodeContainerExecutorLauncherOptions {
	spawn?: SpawnProcess;
}

function defaultContainerName(agentId: string, executorId: string): string {
	return `d-pi-${agentId}-${executorId}`.replace(/[^a-zA-Z0-9_.-]+/g, "-");
}

export class NodeContainerExecutorLauncher {
	private readonly spawn: SpawnProcess;

	constructor(options: NodeContainerExecutorLauncherOptions = {}) {
		this.spawn = options.spawn ?? nodeSpawn;
	}

	start(input: StartNodeContainerExecutorInput): NodeContainerExecutorHandle {
		const { executor } = input;
		const args = [
			"run",
			"--rm",
			"--name",
			executor.containerName ?? defaultContainerName(input.agentId, executor.id),
			"-e",
			`D_PI_TOKEN=${executor.token}`,
			"-e",
			`D_PI_HUB_URL=${input.hubUrl}`,
			"-e",
			`D_PI_AGENT_ID=${input.agentId}`,
			"-e",
			`D_PI_PEER_ID=${executor.peerId}`,
		];
		for (const [key, value] of Object.entries(executor.env ?? {})) {
			args.push("-e", `${key}=${value}`);
		}
		if (executor.workdir) {
			args.push("-w", executor.workdir);
		}
		args.push(executor.image, ...executor.command);
		const child = this.spawn("docker", args, { cwd: input.cwd, stdio: ["ignore", "pipe", "pipe"] });
		return {
			process: child,
			stop() {
				child.kill("SIGTERM");
			},
		};
	}
}
