import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getHubModelsConfigPaths, materializeMergedModelsConfig } from "../../src/hub/models-config.js";

function writeJson(path: string, value: unknown): void {
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

const tempDirs: string[] = [];

describe("hub models config", () => {
	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("merges global and workspace models config with workspace precedence", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-hub-models-merge-"));
		tempDirs.push(cwd);
		const agentDir = join(cwd, "global-agent");
		const localPiDir = join(cwd, ".pi");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(localPiDir, { recursive: true });

		writeJson(join(agentDir, "models.json"), {
			providers: {
				"corp-openai": {
					baseUrl: "https://global.example.com/v1",
					apiKey: "GLOBAL_OPENAI_KEY",
					api: "openai-responses",
					compat: {
						openRouterRouting: {
							order: ["global-a"],
							allow_fallbacks: true,
						},
					},
					modelOverrides: {
						"gpt-4.1": {
							compat: {
								openRouterRouting: {
									order: ["override-global"],
									require_parameters: true,
								},
							},
						},
					},
					headers: {
						"x-global": "1",
						"x-shared": "global",
					},
					models: [
						{
							id: "gpt-4.1",
							name: "GPT 4.1 Global",
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 128000,
							maxTokens: 8192,
						},
					],
				},
			},
		});

		writeJson(join(localPiDir, "models.json"), {
			providers: {
				"corp-openai": {
					headers: {
						"x-local": "1",
						"x-shared": "local",
					},
					compat: {
						openRouterRouting: {
							only: ["local-a"],
						},
					},
					modelOverrides: {
						"gpt-4.1": {
							compat: {
								openRouterRouting: {
									only: ["override-local"],
								},
							},
						},
					},
					models: [
						{
							id: "gpt-4.1",
							name: "GPT 4.1 Local",
							reasoning: true,
							input: ["text", "image"],
							cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
							contextWindow: 256000,
							maxTokens: 16384,
						},
						{
							id: "gpt-4.1-mini",
							name: "GPT 4.1 Mini Local",
							reasoning: false,
							input: ["text", "image"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 128000,
							maxTokens: 16384,
						},
					],
				},
				"corp-anthropic": {
					baseUrl: "https://anthropic.example.com",
					apiKey: "CORP_ANTHROPIC_KEY",
					api: "anthropic-messages",
					models: [
						{
							id: "claude-sonnet-4-20250514",
							name: "Claude Sonnet Local",
							reasoning: true,
							input: ["text", "image"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 200000,
							maxTokens: 64000,
						},
					],
				},
			},
		});

		const result = materializeMergedModelsConfig(cwd, agentDir);
		const merged = JSON.parse(readFileSync(result.mergedModelsFile, "utf8")) as {
			providers: Record<
				string,
				{
					baseUrl?: string;
					headers?: Record<string, string>;
					compat?: { openRouterRouting?: Record<string, unknown> };
					modelOverrides?: Record<string, { compat?: { openRouterRouting?: Record<string, unknown> } }>;
					models?: Array<{ id: string; name: string }>;
				}
			>;
		};

		expect(result.sourceFiles).toEqual([join(agentDir, "models.json"), join(localPiDir, "models.json")]);
		expect(merged.providers["corp-openai"].baseUrl).toBe("https://global.example.com/v1");
		expect(merged.providers["corp-openai"].headers).toEqual({
			"x-global": "1",
			"x-local": "1",
			"x-shared": "local",
		});
		expect(merged.providers["corp-openai"].compat?.openRouterRouting).toEqual({
			order: ["global-a"],
			allow_fallbacks: true,
			only: ["local-a"],
		});
		expect(merged.providers["corp-openai"].modelOverrides?.["gpt-4.1"]?.compat?.openRouterRouting).toEqual({
			order: ["override-global"],
			require_parameters: true,
			only: ["override-local"],
		});
		expect(merged.providers["corp-openai"].models?.map((model) => ({ id: model.id, name: model.name }))).toEqual([
			{
				id: "gpt-4.1",
				name: "GPT 4.1 Local",
			},
			{
				id: "gpt-4.1-mini",
				name: "GPT 4.1 Mini Local",
			},
		]);
		expect(merged.providers["corp-anthropic"].baseUrl).toBe("https://anthropic.example.com");
	});

	it("creates a stable merged file path even when no config files exist", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-hub-models-empty-"));
		tempDirs.push(cwd);
		const agentDir = join(cwd, "global-agent");
		mkdirSync(agentDir, { recursive: true });

		const result = materializeMergedModelsConfig(cwd, agentDir);
		const paths = getHubModelsConfigPaths(cwd, agentDir);

		expect(result.sourceFiles).toEqual([]);
		expect(result.mergedModelsFile).toBe(paths.mergedModelsFile);
		expect(existsSync(result.mergedModelsFile)).toBe(true);
		expect(readFileSync(result.mergedModelsFile, "utf8").trim()).toBe('{\n  "providers": {}\n}');
	});
});
