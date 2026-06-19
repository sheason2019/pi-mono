import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type {
	AgentContextFileDefinition,
	AgentDefinition,
	AgentModelDefinition,
	AgentSkillDefinition,
	AgentToolDefinition,
} from "./agent-definition.ts";

const AGENT_TS_FILE = "agent.ts";
const STRING_LITERAL_PATTERN = `(?:"(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*')`;

export interface LoadedAgentDefinition extends AgentDefinition {
	name: string;
	agentDir: string;
	agentFilePath: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function assertTool(value: unknown, index: number): asserts value is AgentToolDefinition {
	if (!isRecord(value) || typeof value.name !== "string") {
		throw new TypeError(`Agent definition tools[${index}].name must be a string`);
	}
}

function assertSkill(value: unknown): asserts value is AgentSkillDefinition {
	if (!isRecord(value) || typeof value.dir !== "string") {
		throw new TypeError("Agent definition skills.dir must be a string");
	}
}

function assertContextFile(value: unknown, index: number): asserts value is AgentContextFileDefinition {
	if (!isRecord(value)) {
		throw new TypeError(`Agent definition contextFiles[${index}] must be an object`);
	}
	if (value.type !== "context" && value.type !== "append_system") {
		throw new TypeError(`Agent definition contextFiles[${index}].type must be context or append_system`);
	}
	if (typeof value.path !== "string") {
		throw new TypeError(`Agent definition contextFiles[${index}].path must be a string`);
	}
}

function assertModel(value: unknown): asserts value is AgentModelDefinition {
	if (!isRecord(value) || typeof value.provider !== "string" || typeof value.name !== "string") {
		throw new TypeError("Agent definition model.provider and model.name must be strings");
	}
}

function assertAgentDefinition(value: unknown): asserts value is AgentDefinition {
	if (!isRecord(value)) {
		throw new TypeError("Agent file must default export an object definition");
	}
	if (!Array.isArray(value.tools)) {
		throw new TypeError("Agent definition tools must be an array");
	}
	for (let index = 0; index < value.tools.length; index++) {
		assertTool(value.tools[index], index);
	}
	assertSkill(value.skills);
	if (!Array.isArray(value.contextFiles)) {
		throw new TypeError("Agent definition contextFiles must be an array");
	}
	for (let index = 0; index < value.contextFiles.length; index++) {
		assertContextFile(value.contextFiles[index], index);
	}

	if (value.description !== undefined && typeof value.description !== "string") {
		throw new TypeError("Agent definition description must be a string");
	}
	if (value.roles !== undefined) {
		if (!Array.isArray(value.roles) || value.roles.some((role) => typeof role !== "string")) {
			throw new TypeError("Agent definition roles must be an array of strings");
		}
	}
	if (value.model !== undefined) {
		assertModel(value.model);
	}
	if (value.parent !== undefined) {
		assertAgentDefinition(value.parent);
	}
}

function stripComments(source: string): string {
	let result = "";
	let index = 0;
	while (index < source.length) {
		const char = source[index];
		const next = source[index + 1];
		if (char === '"' || char === "'") {
			const stringStart = index;
			const quote = char;
			index++;
			while (index < source.length) {
				const current = source[index];
				if (current === "\\") {
					index += 2;
					continue;
				}
				index++;
				if (current === quote) {
					break;
				}
			}
			result += source.slice(stringStart, index);
			continue;
		}
		if (char === "/" && next === "/") {
			result += "  ";
			index += 2;
			while (index < source.length && source[index] !== "\n") {
				result += " ";
				index++;
			}
			continue;
		}
		if (char === "/" && next === "*") {
			result += "  ";
			index += 2;
			while (index < source.length) {
				if (source[index] === "*" && source[index + 1] === "/") {
					result += "  ";
					index += 2;
					break;
				}
				result += source[index] === "\n" ? "\n" : " ";
				index++;
			}
			continue;
		}
		result += char;
		index++;
	}
	return result;
}

function parseHexEscape(value: string, context: string): string {
	const codePoint = Number.parseInt(value, 16);
	if (!Number.isFinite(codePoint)) {
		throw new Error(`Invalid string literal in ${context}: invalid unicode escape`);
	}
	return String.fromCodePoint(codePoint);
}

function parseStringLiteral(literal: string, context: string): string {
	const quote = literal[0];
	if ((quote !== '"' && quote !== "'") || literal[literal.length - 1] !== quote) {
		throw new Error(`Invalid string literal in ${context}: expected a quoted string`);
	}

	let result = "";
	let index = 1;
	while (index < literal.length - 1) {
		const char = literal[index];
		if (char !== "\\") {
			result += char;
			index++;
			continue;
		}

		index++;
		const escapedChar = literal[index];
		if (escapedChar === undefined) {
			throw new Error(`Invalid string literal in ${context}: unterminated escape`);
		}
		switch (escapedChar) {
			case "b":
				result += "\b";
				index++;
				break;
			case "f":
				result += "\f";
				index++;
				break;
			case "n":
				result += "\n";
				index++;
				break;
			case "r":
				result += "\r";
				index++;
				break;
			case "t":
				result += "\t";
				index++;
				break;
			case "v":
				result += "\v";
				index++;
				break;
			case "0":
				result += "\0";
				index++;
				break;
			case "x":
				result += parseHexEscape(literal.slice(index + 1, index + 3), context);
				index += 3;
				break;
			case "u":
				if (literal[index + 1] === "{") {
					const closeBraceIndex = literal.indexOf("}", index + 2);
					if (closeBraceIndex === -1) {
						throw new Error(`Invalid string literal in ${context}: unterminated unicode escape`);
					}
					result += parseHexEscape(literal.slice(index + 2, closeBraceIndex), context);
					index = closeBraceIndex + 1;
				} else {
					result += parseHexEscape(literal.slice(index + 1, index + 5), context);
					index += 5;
				}
				break;
			case "\n":
				index++;
				break;
			case "\r":
				index += literal[index + 1] === "\n" ? 2 : 1;
				break;
			default:
				result += escapedChar;
				index++;
				break;
		}
	}
	return result;
}

function parseStringArrayLiteral(literal: string, context: string): string[] {
	try {
		const parsed = JSON.parse(literal) as unknown;
		if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== "string")) {
			throw new TypeError("expected an array of strings");
		}
		return parsed;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Invalid array literal in ${context}: ${message}`);
	}
}

function parseOptionalStringProperty(source: string, propertyName: string, context: string): string | undefined {
	const match = source.match(new RegExp(`${propertyName}:\\s*(${STRING_LITERAL_PATTERN})`, "s"));
	return match ? parseStringLiteral(match[1], context) : undefined;
}

function parseOptionalStringArrayProperty(source: string, propertyName: string, context: string): string[] | undefined {
	const match = source.match(new RegExp(`${propertyName}:\\s*(\\[[\\s\\S]*?\\])`, "s"));
	return match ? parseStringArrayLiteral(match[1], context) : undefined;
}

function parseModelDefinition(source: string): AgentModelDefinition | undefined {
	const match = source.match(
		new RegExp(
			`model:\\s*(?:defineModel\\(\\s*)?\\{\\s*provider:\\s*(${STRING_LITERAL_PATTERN}),\\s*name:\\s*(${STRING_LITERAL_PATTERN})\\s*\\}\\s*\\)?`,
			"s",
		),
	);
	if (!match) {
		return undefined;
	}
	return {
		provider: parseStringLiteral(match[1], "agent.ts model provider"),
		name: parseStringLiteral(match[2], "agent.ts model name"),
	};
}

function parseSkillDefinition(source: string): AgentSkillDefinition {
	const match = source.match(/skills:\s*(?:defineSkill\(\s*)?\{([\s\S]*?)\}\s*\)?/s);
	if (!match) {
		throw new TypeError("Agent definition skills.dir must be a string");
	}
	const dir = parseOptionalStringProperty(match[1], "dir", "agent.ts skills.dir");
	if (dir === undefined) {
		throw new TypeError("Agent definition skills.dir must be a string");
	}
	return { dir };
}

function parseToolDefinitions(source: string): AgentToolDefinition[] {
	const toolPattern = new RegExp(
		`(?:defineTool\\(\\s*)?\\{\\s*name:\\s*(${STRING_LITERAL_PATTERN})\\s*\\}\\s*\\)?`,
		"gs",
	);
	return Array.from(source.matchAll(toolPattern), (match) => ({
		name: parseStringLiteral(match[1], "agent.ts tool name"),
	}));
}

function parseContextFileDefinitions(source: string): AgentContextFileDefinition[] {
	const contextFilePattern = /defineContextFile\(\s*\{([\s\S]*?)\}\s*\)/gs;
	return Array.from(source.matchAll(contextFilePattern), (match) => {
		const type = parseOptionalStringProperty(match[1], "type", "agent.ts contextFiles.type");
		if (type !== "context" && type !== "append_system") {
			throw new TypeError("Agent definition contextFiles.type must be context or append_system");
		}
		const path = parseOptionalStringProperty(match[1], "path", "agent.ts contextFiles.path");
		if (path === undefined) {
			throw new TypeError("Agent definition contextFiles.path must be a string");
		}
		return {
			type,
			path,
		};
	});
}

export function normalizeLoadedAgentDefinition(agentFilePath: string, definition: unknown): LoadedAgentDefinition {
	assertAgentDefinition(definition);

	const resolvedAgentFilePath = resolve(agentFilePath);
	const agentDir = dirname(resolvedAgentFilePath);
	const name = basename(agentDir);

	return {
		...definition,
		name,
		agentDir,
		agentFilePath: resolvedAgentFilePath,
	};
}

export function loadAgentDefinitionFromTsSource(agentFilePath: string, source: string): LoadedAgentDefinition {
	const uncommentedSource = stripComments(source);
	return normalizeLoadedAgentDefinition(agentFilePath, {
		description: parseOptionalStringProperty(uncommentedSource, "description", "agent.ts description"),
		roles: parseOptionalStringArrayProperty(uncommentedSource, "roles", "agent.ts roles"),
		model: parseModelDefinition(uncommentedSource),
		tools: parseToolDefinitions(uncommentedSource),
		skills: parseSkillDefinition(uncommentedSource),
		contextFiles: parseContextFileDefinitions(uncommentedSource),
	});
}

export function readLoadedAgentDefinitionFromTsSync(agentDir: string): LoadedAgentDefinition | undefined {
	const agentFilePath = join(resolve(agentDir), AGENT_TS_FILE);
	if (!existsSync(agentFilePath)) {
		return undefined;
	}
	return loadAgentDefinitionFromTsSource(agentFilePath, readFileSync(agentFilePath, "utf-8"));
}

export async function loadAgentDefinitionFromFile(agentFilePath: string): Promise<LoadedAgentDefinition> {
	const resolvedAgentFilePath = resolve(agentFilePath);
	const agentUrl = pathToFileURL(resolvedAgentFilePath).href;
	const agentModule = (await import(/* @vite-ignore */ agentUrl)) as { default?: unknown };
	return normalizeLoadedAgentDefinition(resolvedAgentFilePath, agentModule.default);
}
