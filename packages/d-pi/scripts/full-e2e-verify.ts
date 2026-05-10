import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

export type E2eVitestStep = {
	kind: "vitest";
	name: string;
	files: string[];
};

export type E2eCommandStep = {
	kind: "command";
	name: string;
	command: string;
	args: string[];
};

export type E2eStep = E2eVitestStep | E2eCommandStep;

export const E2E_STEPS: E2eStep[] = [
	{
		kind: "vitest",
		name: "hub-startup-security",
		files: [
			"test/hub/serve-tui.test.ts",
			"test/hub/auth-token-store.test.ts",
			"test/hub/hub-runtime-agents.test.ts",
		],
	},
	{
		kind: "vitest",
		name: "hub-peer-session",
		files: [
			"test/hub/socket-hub-server-agent-binding.test.ts",
			"test/hub/socket-hub-server-fanout.test.ts",
			"test/peer/socket-client.test.ts",
			"test/peer/peer-runtime.test.ts",
			"test/peer/hub-peer-roundtrip.test.ts",
		],
	},
	{
		kind: "vitest",
		name: "remote-tooling",
		files: [
			"test/hub/peer-tool-bridge-agent.test.ts",
			"test/hub/peer-tools-agent-isolation.test.ts",
			"test/hub/host-peer-tools.test.ts",
		],
	},
	{
		kind: "vitest",
		name: "sources-and-mcp",
		files: [
			"test/hub/source-host.test.ts",
			"test/hub/source-inbound-messages.test.ts",
			"test/hub/mcp-host-lifecycle.test.ts",
			"test/hub/mcp-client.test.ts",
		],
	},
	{
		kind: "command",
		name: "distribution-build",
		command: "npm",
		args: ["run", "prepare:publish"],
	},
	{
		kind: "vitest",
		name: "peer-ui-and-distribution",
		files: [
			"test/peer/forked-interactive-mode.test.ts",
			"test/peer/forked-streaming-render.test.ts",
			"test/package-distribution.test.ts",
		],
	},
];

export const E2E_TEST_GROUPS: E2eVitestStep[] = E2E_STEPS.filter((step): step is E2eVitestStep => {
	return step.kind === "vitest";
});

export function createVitestArgs(groups = E2E_TEST_GROUPS): string[] {
	return [
		"tsx",
		"../../node_modules/vitest/dist/cli.js",
		"--run",
		...groups.flatMap((group) => group.files),
	];
}

export function createCommandForStep(step: E2eStep): { command: string; args: string[] } {
	if (step.kind === "command") {
		return { command: step.command, args: step.args };
	}
	return { command: "npx", args: createVitestArgs([step]) };
}

export async function runFullE2eVerify({
	steps = E2E_STEPS,
	spawnCommand = spawn,
	cwd = new URL("..", import.meta.url).pathname,
}: {
	steps?: E2eStep[];
	spawnCommand?: typeof spawn;
	cwd?: string;
} = {}): Promise<void> {
	for (const step of steps) {
		await runStep(step, { spawnCommand, cwd });
	}
}

function runStep(
	step: E2eStep,
	options: {
		spawnCommand: typeof spawn;
		cwd: string;
	},
): Promise<void> {
	return new Promise((resolve, reject) => {
		const { command, args } = createCommandForStep(step);
		console.log(`\n[d-pi:e2e] ${step.name}`);
		console.log(`[d-pi:e2e] ${command} ${args.join(" ")}`);
		const child: ChildProcess = options.spawnCommand(command, args, {
			cwd: options.cwd,
			stdio: "inherit",
			env: {
				...process.env,
				PI_HEADLESS: process.env.PI_HEADLESS ?? "1",
			},
		});
		child.on("error", reject);
		child.on("exit", (code, signal) => {
			if (code === 0) {
				resolve();
				return;
			}
			reject(new Error(`${step.name} failed with ${signal ? `signal ${signal}` : `exit code ${code}`}`));
		});
	});
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
	runFullE2eVerify().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
