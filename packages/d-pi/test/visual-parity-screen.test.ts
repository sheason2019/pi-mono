import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

const enabled = process.env.DPI_VISUAL_PARITY === "1";
const describeIf = enabled ? describe : describe.skip;

interface ScreenPair {
	native: string;
	dpi: string;
}

describeIf("d-pi visual parity against native pi coding-agent", () => {
	it("prints and compares startup and prompt screens byte-for-byte", async () => {
		const prompt = process.env.DPI_VISUAL_PROMPT ?? "你好";
		const nativeCommand = process.env.DPI_VISUAL_NATIVE_CMD ?? "pi";
		const dpiCommand = process.env.DPI_VISUAL_DPI_CMD ?? "d-pi connect lixujie@http://localhost:39090";
		const nativeSession = `dpi-visual-native-${process.pid}`;
		const dpiSession = `dpi-visual-dpi-${process.pid}`;

		try {
			await startTmux(nativeSession, nativeCommand);
			await startTmux(dpiSession, dpiCommand);
			await sleep(3000);

			const startup = {
				native: await captureTmux(nativeSession),
				dpi: await captureTmux(dpiSession),
			};
			printPair("startup", startup);
			expect(startup.dpi).toBe(startup.native);

			await sendPrompt(nativeSession, prompt);
			await sendPrompt(dpiSession, prompt);
			await sleep(Number(process.env.DPI_VISUAL_PROMPT_WAIT_MS ?? 15000));

			const afterPrompt = {
				native: await captureTmux(nativeSession),
				dpi: await captureTmux(dpiSession),
			};
			printPair("after prompt", afterPrompt);
			expect(afterPrompt.dpi).toBe(afterPrompt.native);
		} finally {
			await killTmux(nativeSession);
			await killTmux(dpiSession);
		}
	}, 120000);
});

async function startTmux(session: string, command: string): Promise<void> {
	await killTmux(session);
	await execFileAsync("tmux", ["new-session", "-d", "-s", session, "-x", "120", "-y", "40", command]);
}

async function captureTmux(session: string): Promise<string> {
	const result = await execFileAsync("tmux", ["capture-pane", "-t", `${session}:0.0`, "-p", "-S", "-"]);
	return result.stdout;
}

async function sendPrompt(session: string, prompt: string): Promise<void> {
	await execFileAsync("tmux", ["send-keys", "-t", `${session}:0.0`, "-l", "--", prompt]);
	await execFileAsync("tmux", ["send-keys", "-t", `${session}:0.0`, "Enter"]);
}

async function killTmux(session: string): Promise<void> {
	try {
		await execFileAsync("tmux", ["kill-session", "-t", session]);
	} catch {
		// Missing sessions are fine; each test run owns only its generated names.
	}
}

async function sleep(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms));
}

function printPair(label: string, pair: ScreenPair): void {
	process.stdout.write(`\n===== native ${label} =====\n${pair.native}\n`);
	process.stdout.write(`\n===== d-pi ${label} =====\n${pair.dpi}\n`);
}
