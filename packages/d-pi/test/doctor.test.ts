import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runDPiCli } from "../src/cli-runner.ts";
import { formatReport, runDoctor } from "../src/doctor.ts";
import { initWorkspace } from "../src/workspace/workspace.ts";

vi.mock("@earendil-works/pi-ai", async () => {
	const actual = await vi.importActual<typeof import("@earendil-works/pi-ai")>("@earendil-works/pi-ai");
	const mockStreamSimple = vi.fn().mockImplementation(async function* () {
		yield {
			type: "start",
			partial: {
				role: "assistant",
				content: [],
				api: "openai-responses",
				provider: "openai",
				model: "test",
				stopReason: null,
			},
		};
	});
	return {
		...actual,
		streamSimple: mockStreamSimple,
	};
});

let tmpRoot: string | undefined;

function freshDir(): string {
	tmpRoot = join(tmpdir(), `d-pi-doctor-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tmpRoot, { recursive: true });
	return tmpRoot;
}

describe("doctor", () => {
	afterEach(() => {
		if (tmpRoot) {
			rmSync(tmpRoot, { recursive: true, force: true });
			tmpRoot = undefined;
		}
	});

	it("reports error when not in a workspace", async () => {
		const dir = freshDir();
		const report = await runDoctor(dir);
		expect(report.isWorkspace).toBe(false);
		expect(report.checks.length).toBeGreaterThan(0);
		const wsCheck = report.checks.find((c) => c.name === "workspace");
		expect(wsCheck?.status).toBe("error");
		expect(report.summary.error).toBeGreaterThan(0);
	});

	it("runs against a freshly initialized workspace", async () => {
		const dir = freshDir();
		initWorkspace(dir);
		const report = await runDoctor(dir, { verifyModels: false });
		expect(report.isWorkspace).toBe(true);

		const wsCheck = report.checks.find((c) => c.name === "workspace");
		expect(wsCheck?.status).toBe("ok");

		const agentsCheck = report.checks.find((c) => c.name === "agents");
		expect(agentsCheck).toBeDefined();
		expect(agentsCheck?.status).toBe("ok");
		expect(agentsCheck?.message).toContain("1 agent");
		expect(agentsCheck?.details?.some((d) => d.includes("root"))).toBe(true);

		const modelsCheck = report.checks.find((c) => c.name === "models");
		expect(modelsCheck).toBeDefined();
		expect(modelsCheck?.status).toBe("warn");
		expect(modelsCheck?.message).toContain("No models");

		const skillsCheck = report.checks.find((c) => c.name === "skills");
		expect(skillsCheck).toBeDefined();

		const recentInputsCheck = report.checks.find((c) => c.name === "recent inputs");
		expect(recentInputsCheck).toBeDefined();

		const serveCheck = report.checks.find((c) => c.name === "serve readiness");
		expect(serveCheck).toBeDefined();
		expect(serveCheck?.status).toBe("ok");
	});

	it("formatReport produces readable output", async () => {
		const dir = freshDir();
		initWorkspace(dir);
		const report = await runDoctor(dir);
		const text = formatReport(report);
		expect(text).toContain("d-pi doctor");
		expect(text).toContain("[OK]");
		expect(text).toContain("[WARN]");
		expect(text).toContain("Summary:");
		expect(text).toContain("root");
	});

	it("CLI doctor command prints report", async () => {
		const dir = freshDir();
		initWorkspace(dir);
		let output = "";
		const runtime = {
			cwd: dir,
			homeDir: join(dir, "home"),
			stdout: (text: string) => {
				output += text;
			},
			stderr: () => {},
			write: (text: string) => {
				output += text;
			},
			isTTY: false,
		};
		await runDPiCli(["doctor"], runtime);
		expect(output).toContain("d-pi doctor");
		expect(output).toContain("[OK]");
		expect(output).toContain("workspace");
		expect(output).toContain("agents");
		expect(output).toContain("Summary:");
	});

	it("detects workspace with no agents directory", async () => {
		const dir = freshDir();
		mkdirSync(join(dir, ".dpi"));
		writeFileSync(join(dir, "package.json"), '{"name":"test"}');
		const report = await runDoctor(dir);
		const agentsCheck = report.checks.find((c) => c.name === "agents");
		expect(agentsCheck?.status).toBe("error");
		expect(report.summary.error).toBeGreaterThan(0);
	});

	it("counts skills in skill directories", async () => {
		const dir = freshDir();
		initWorkspace(dir);

		const workspaceSkillsDir = join(dir, "skills");
		mkdirSync(join(workspaceSkillsDir, "skill-a"), { recursive: true });
		writeFileSync(join(workspaceSkillsDir, "skill-a", "SKILL.md"), "# Skill A");
		mkdirSync(join(workspaceSkillsDir, "skill-b"));
		writeFileSync(join(workspaceSkillsDir, "skill-b", "SKILL.md"), "# Skill B");

		const agentSkillsDir = join(dir, "agents", "root", "skills");
		mkdirSync(join(agentSkillsDir, "skill-c"), { recursive: true });
		writeFileSync(join(agentSkillsDir, "skill-c", "SKILL.md"), "# Skill C");

		const report = await runDoctor(dir, { verifyModels: false });
		const skillsCheck = report.checks.find((c) => c.name === "skills");
		expect(skillsCheck).toBeDefined();
		expect(skillsCheck?.status).toBe("ok");
		expect(skillsCheck?.message).toContain("3 total skills");
		expect(skillsCheck?.details?.some((d) => d.includes("workspace") && d.includes("2 skills"))).toBe(true);
		expect(skillsCheck?.details?.some((d) => d.includes("agent:root") && d.includes("1 skill"))).toBe(true);
	});

	it("reads recent user inputs from session files", async () => {
		const dir = freshDir();
		initWorkspace(dir);

		const sessionDir = join(dir, "agents", "root", "session");
		mkdirSync(sessionDir, { recursive: true });

		const sessionLines = [
			JSON.stringify({ type: "message", message: { role: "user", content: "first input" } }),
			JSON.stringify({ type: "message", message: { role: "assistant", content: "reply 1" } }),
			JSON.stringify({ type: "message", message: { role: "user", content: "second input" } }),
			JSON.stringify({ type: "message", message: { role: "assistant", content: "reply 2" } }),
			JSON.stringify({ type: "message", message: { role: "user", content: "third input" } }),
		];
		writeFileSync(join(sessionDir, "test.jsonl"), `${sessionLines.join("\n")}\n`);

		const report = await runDoctor(dir, { verifyModels: false, recentInputsPerAgent: 5 });
		const recentCheck = report.checks.find((c) => c.name === "recent inputs");
		expect(recentCheck).toBeDefined();
		expect(recentCheck?.status).toBe("info");
		expect(recentCheck?.details?.some((d) => d.includes("third input"))).toBe(true);
		expect(recentCheck?.details?.some((d) => d.includes("second input"))).toBe(true);
		expect(recentCheck?.details?.some((d) => d.includes("first input"))).toBe(true);
	});

	it("lists models from agent configs without verification", async () => {
		const dir = freshDir();
		initWorkspace(dir);

		const agentTsContent = `
import { defineAgent, defineModel, defineOpenAIProvider } from "@sheason/d-pi";

export default defineAgent({
  description: "Root agent",
  model: defineModel({
    provider: defineOpenAIProvider({ apiKey: "test-key" }),
    name: "gpt-4o",
    id: "openai/gpt-4o",
    contextWindow: 128000,
  }),
  tools: [],
});
`;
		writeFileSync(join(dir, "agents", "root", "agent.ts"), agentTsContent);

		const report = await runDoctor(dir, { verifyModels: false });
		const modelsCheck = report.checks.find((c) => c.name === "models");
		expect(modelsCheck).toBeDefined();
		expect(modelsCheck?.message).toContain("1 model");
		expect(modelsCheck?.message).toContain("verification skipped");
		expect(modelsCheck?.details?.some((d) => d.includes("gpt-4o"))).toBe(true);
	});
});
