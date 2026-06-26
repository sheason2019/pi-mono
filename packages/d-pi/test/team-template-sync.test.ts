import { execFile } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
	execFile: vi.fn(),
}));

const mockExecFile = execFile as unknown as ReturnType<typeof vi.fn>;

function mockExec(args: string[]): { error?: Error; stdout?: string; stderr?: string } {
	return { error: new Error(`unexpected: git ${args.join(" ")}`) };
}

function setupMock(
	handler: (args: string[], cwd: string | undefined) => { error?: Error; stdout?: string; stderr?: string },
): void {
	mockExecFile.mockImplementation(
		(
			cmd: string,
			args: string[],
			optsOrCb: unknown,
			maybeCb?: (err?: Error | null, stdout?: string, stderr?: string) => void,
		) => {
			const cb = typeof optsOrCb === "function" ? optsOrCb : maybeCb!;
			const opts = typeof optsOrCb === "function" ? undefined : (optsOrCb as { cwd?: string });
			if (cmd !== "git") {
				cb(new Error("not git"));
				return;
			}
			const result = handler(args, opts?.cwd);
			cb(result.error ?? null, result.stdout ?? "", result.stderr ?? "");
		},
	);
}

let tmpRoot: string | undefined;

function freshDir(): string {
	tmpRoot = join(tmpdir(), `d-pi-team-template-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tmpRoot, { recursive: true });
	return tmpRoot;
}

describe("syncTeamTemplate", () => {
	beforeEach(() => {
		mockExecFile.mockReset();
	});

	afterEach(() => {
		if (tmpRoot) {
			rmSync(tmpRoot, { recursive: true, force: true });
			tmpRoot = undefined;
		}
		vi.restoreAllMocks();
	});

	it("returns unchanged when no declaration and no dir exists", async () => {
		const { syncTeamTemplate } = await import("../src/team-template-sync.ts");
		const dir = freshDir();
		const result = await syncTeamTemplate(dir, undefined);
		expect(result.action).toBe("unchanged");
		expect(existsSync(join(dir, "team-template"))).toBe(false);
	});

	it("removes existing dir when declaration is removed", async () => {
		const { syncTeamTemplate } = await import("../src/team-template-sync.ts");
		const dir = freshDir();
		mkdirSync(join(dir, "team-template"), { recursive: true });
		writeFileSync(join(dir, "team-template", "AGENTS.md"), "# old");
		const result = await syncTeamTemplate(dir, undefined);
		expect(result.action).toBe("removed");
		expect(existsSync(join(dir, "team-template"))).toBe(false);
	});

	it("clones when declared and no dir exists (no ref)", async () => {
		const { syncTeamTemplate } = await import("../src/team-template-sync.ts");
		const dir = freshDir();
		let cloneArgs: string[] = [];
		setupMock((args) => {
			if (args[0] === "clone") {
				cloneArgs = args;
				const targetDir = args[args.length - 1];
				mkdirSync(targetDir, { recursive: true });
				mkdirSync(join(targetDir, ".git"), { recursive: true });
				writeFileSync(join(targetDir, "AGENTS.md"), "# from repo");
				return {};
			}
			if (args[0] === "rev-parse") {
				return { stdout: "abc123\n" };
			}
			return mockExec(args);
		});
		const result = await syncTeamTemplate(dir, { repo: "https://example.com/repo.git" });
		expect(result.action).toBe("cloned");
		expect(result.repo).toBe("https://example.com/repo.git");
		expect(result.ref).toBeUndefined();
		expect(result.commit).toBe("abc123");
		expect(cloneArgs).not.toContain("--branch");
		expect(existsSync(join(dir, "team-template"))).toBe(true);
	});

	it("clones with --branch when ref is specified", async () => {
		const { syncTeamTemplate } = await import("../src/team-template-sync.ts");
		const dir = freshDir();
		let cloneArgs: string[] = [];
		setupMock((args) => {
			if (args[0] === "clone") {
				cloneArgs = args;
				const targetDir = args[args.length - 1];
				mkdirSync(targetDir, { recursive: true });
				mkdirSync(join(targetDir, ".git"), { recursive: true });
				return {};
			}
			if (args[0] === "rev-parse") {
				return { stdout: "def456\n" };
			}
			return mockExec(args);
		});
		const result = await syncTeamTemplate(dir, { repo: "https://example.com/repo.git", ref: "develop" });
		expect(result.action).toBe("cloned");
		expect(result.ref).toBe("develop");
		expect(cloneArgs).toContain("--branch");
		expect(cloneArgs).toContain("develop");
	});

	it("re-clones when remote url differs", async () => {
		const { syncTeamTemplate } = await import("../src/team-template-sync.ts");
		const dir = freshDir();
		const templateDir = join(dir, "team-template");
		mkdirSync(join(templateDir, ".git"), { recursive: true });
		writeFileSync(join(templateDir, "AGENTS.md"), "# old");

		let cloneCount = 0;
		setupMock((args) => {
			if (args[0] === "remote" && args[1] === "get-url") {
				return { stdout: "https://old.example.com/repo.git\n" };
			}
			if (args[0] === "clone") {
				cloneCount++;
				const targetDir = args[args.length - 1];
				mkdirSync(join(targetDir, ".git"), { recursive: true });
				writeFileSync(join(targetDir, "AGENTS.md"), "# new");
				return {};
			}
			if (args[0] === "rev-parse") {
				return { stdout: "new_hash\n" };
			}
			return mockExec(args);
		});
		const result = await syncTeamTemplate(dir, { repo: "https://new.example.com/repo.git" });
		expect(result.action).toBe("cloned");
		expect(result.repo).toBe("https://new.example.com/repo.git");
		expect(cloneCount).toBe(1);
	});

	it("fetches and resets to origin/HEAD when no ref specified", async () => {
		const { syncTeamTemplate } = await import("../src/team-template-sync.ts");
		const dir = freshDir();
		const templateDir = join(dir, "team-template");
		mkdirSync(join(templateDir, ".git"), { recursive: true });

		let revCount = 0;
		let fetchCount = 0;
		let resetTarget = "";
		setupMock((args) => {
			if (args[0] === "remote" && args[1] === "get-url") {
				return { stdout: "https://example.com/repo.git\n" };
			}
			if (args[0] === "rev-parse") {
				const val = revCount === 0 ? "oldhash" : "newhash";
				revCount++;
				return { stdout: `${val}\n` };
			}
			if (args[0] === "fetch") {
				fetchCount++;
				return {};
			}
			if (args[0] === "reset") {
				resetTarget = args[2];
				return {};
			}
			return mockExec(args);
		});
		const result = await syncTeamTemplate(dir, { repo: "https://example.com/repo.git" });
		expect(result.action).toBe("updated");
		expect(result.commit).toBe("newhash");
		expect(fetchCount).toBe(1);
		expect(resetTarget).toBe("origin/HEAD");
	});

	it("fetches and checks out ref when ref specified", async () => {
		const { syncTeamTemplate } = await import("../src/team-template-sync.ts");
		const dir = freshDir();
		const templateDir = join(dir, "team-template");
		mkdirSync(join(templateDir, ".git"), { recursive: true });

		let revCount = 0;
		let fetchCount = 0;
		let checkoutRef = "";
		setupMock((args) => {
			if (args[0] === "remote" && args[1] === "get-url") {
				return { stdout: "https://example.com/repo.git\n" };
			}
			if (args[0] === "rev-parse") {
				const val = revCount === 0 ? "oldhash" : "newhash";
				revCount++;
				return { stdout: `${val}\n` };
			}
			if (args[0] === "fetch") {
				fetchCount++;
				return {};
			}
			if (args[0] === "checkout") {
				checkoutRef = args[1];
				return {};
			}
			return mockExec(args);
		});
		const result = await syncTeamTemplate(dir, { repo: "https://example.com/repo.git", ref: "v2.0" });
		expect(result.action).toBe("updated");
		expect(result.ref).toBe("v2.0");
		expect(result.commit).toBe("newhash");
		expect(fetchCount).toBe(1);
		expect(checkoutRef).toBe("v2.0");
	});

	it("reports unchanged when commit matches", async () => {
		const { syncTeamTemplate } = await import("../src/team-template-sync.ts");
		const dir = freshDir();
		const templateDir = join(dir, "team-template");
		mkdirSync(join(templateDir, ".git"), { recursive: true });

		setupMock((args) => {
			if (args[0] === "remote" && args[1] === "get-url") {
				return { stdout: "https://example.com/repo.git\n" };
			}
			if (args[0] === "rev-parse") {
				return { stdout: "samehash\n" };
			}
			if (args[0] === "fetch") {
				return {};
			}
			if (args[0] === "reset") {
				return {};
			}
			return mockExec(args);
		});
		const result = await syncTeamTemplate(dir, { repo: "https://example.com/repo.git" });
		expect(result.action).toBe("unchanged");
		expect(result.commit).toBe("samehash");
	});

	it("replaces non-git directory with fresh clone", async () => {
		const { syncTeamTemplate } = await import("../src/team-template-sync.ts");
		const dir = freshDir();
		const templateDir = join(dir, "team-template");
		mkdirSync(templateDir, { recursive: true });
		writeFileSync(join(templateDir, "random.txt"), "not a git repo");

		setupMock((args) => {
			if (args[0] === "clone") {
				const targetDir = args[args.length - 1];
				mkdirSync(join(targetDir, ".git"), { recursive: true });
				writeFileSync(join(targetDir, "AGENTS.md"), "# cloned");
				return {};
			}
			if (args[0] === "rev-parse") {
				return { stdout: "abc123\n" };
			}
			return mockExec(args);
		});
		const result = await syncTeamTemplate(dir, { repo: "https://example.com/repo.git" });
		expect(result.action).toBe("cloned");
		expect(existsSync(join(dir, "team-template", "AGENTS.md"))).toBe(true);
		expect(existsSync(join(dir, "team-template", "random.txt"))).toBe(false);
	});
});
