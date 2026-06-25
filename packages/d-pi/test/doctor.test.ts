import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runDPiCli } from "../src/cli-runner.ts";
import { formatReport, runDoctor } from "../src/doctor.ts";
import { initWorkspace } from "../src/workspace/workspace.ts";

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
		const report = await runDoctor(dir);
		expect(report.isWorkspace).toBe(true);

		const wsCheck = report.checks.find((c) => c.name === "workspace");
		expect(wsCheck?.status).toBe("ok");

		const agentsCheck = report.checks.find((c) => c.name === "agents");
		expect(agentsCheck).toBeDefined();
		expect(agentsCheck?.status).toBe("ok");
		expect(agentsCheck?.message).toContain("1 agent");
		expect(agentsCheck?.details?.some((d) => d.includes("root"))).toBe(true);

		const dpiTsCheck = report.checks.find((c) => c.name === "d-pi.ts");
		expect(dpiTsCheck).toBeDefined();
		expect(dpiTsCheck?.status).toBe("warn");
		expect(dpiTsCheck?.message).toContain("No d-pi.ts");

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
		const lines: string[] = [];
		const runtime = {
			cwd: dir,
			homeDir: join(dir, "home"),
			stdout: (line: string) => lines.push(line),
			stderr: () => {},
		};
		await runDPiCli(["doctor"], runtime);
		const output = lines.join("\n");
		expect(output).toContain("d-pi doctor");
		expect(output).toContain("[OK] workspace");
		expect(output).toContain("agents");
	});

	it("detects workspace with no agents directory", async () => {
		const dir = freshDir();
		mkdirSync(join(dir, ".dpi"));
		writeFileSync(join(dir, ".dpi", "config.json"), "{}");
		writeFileSync(join(dir, "package.json"), '{"name":"test"}');
		const report = await runDoctor(dir);
		const agentsCheck = report.checks.find((c) => c.name === "agents");
		expect(agentsCheck?.status).toBe("error");
		expect(report.summary.error).toBeGreaterThan(0);
	});
});
