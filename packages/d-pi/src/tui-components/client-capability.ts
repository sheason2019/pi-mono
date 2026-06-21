import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const CLIENT_CAPABILITY_FILENAME = ".d-pi-tui-components-capability.ts";
const DPI_PACKAGE_SHIM_DIR = join("node_modules", "@sheason", "d-pi");

const CLIENT_CAPABILITY_SOURCE = `import agentDefinition from "./agent.ts";
import { installAgentTuiComponents } from "@sheason/d-pi";

// Bundle dependency markers for coding-agent's client-extension sync.
// import "./node_modules/@sheason/d-pi/package.json";
// import "./node_modules/@sheason/d-pi/index.js";

export default function server() {}

export function client(pi) {
\tinstallAgentTuiComponents(agentDefinition, {
\t\tregisterTuiComponentRenderer(customType, render) {
\t\t\tpi.registerMessageRenderer(customType, render);
\t\t},
\t});
}
`;

const DPI_PACKAGE_SHIM_PACKAGE_JSON = `{
\t"name": "@sheason/d-pi",
\t"type": "module",
\t"exports": "./index.js"
}
`;

const DPI_PACKAGE_SHIM_SOURCE = `import { Box, Container, Markdown, Text } from "@earendil-works/pi-tui";
import { getMarkdownTheme } from "@sheason/pi-coding-agent";

export function defineTool(input) {
\treturn input;
}

export function defineSkill(input) {
\treturn input;
}

export function defineContextFile(input) {
\treturn input;
}

export function defineModel(input) {
\treturn input;
}

export function defineTuiComponent(input) {
\treturn input;
}

export function defineAgent(input) {
\treturn input;
}

export function installAgentTuiComponents(agent, registry) {
\tfor (const component of agent.tuiComponents ?? []) {
\t\tregistry.registerTuiComponentRenderer(component.customType, component.render);
\t}
}

function isRecord(value) {
\treturn typeof value === "object" && value !== null;
}

function messageContentToText(content) {
\tif (typeof content === "string") {
\t\treturn content;
\t}
\tif (!Array.isArray(content)) {
\t\treturn "";
\t}
\tconst textParts = [];
\tfor (const part of content) {
\t\tif (isRecord(part) && part.type === "text" && typeof part.text === "string") {
\t\t\ttextParts.push(part.text);
\t\t}
\t}
\treturn textParts.join("\\n");
}

function extractMeta(text) {
\tif (!text.startsWith("[meta(")) return undefined;
\tconst endIdx = text.indexOf(")]\\n");
\tif (endIdx === -1) return undefined;
\ttry {
\t\tconst meta = JSON.parse(text.slice(6, endIdx));
\t\treturn { meta, text: text.slice(endIdx + 3) };
\t} catch {
\t\treturn undefined;
\t}
}

export const dPiMessageTuiComponent = defineTuiComponent({
\tcustomType: "d-pi-message",
\trender(message, _options, theme) {
\t\tconst rawText = messageContentToText(message.content);
\t\tconst extracted = extractMeta(rawText);
\t\tconst meta = extracted?.meta ?? message.details;
\t\tif (!meta) {
\t\t\treturn undefined;
\t\t}
\t\tconst textContent = extracted?.text ?? rawText;

\t\tlet source = meta.sourceType;
\t\tif (meta.sourceType === "connect" && meta.connectId) {
\t\t\tsource = \`\${source} \${meta.connectId}\`;
\t\t} else if (meta.sourceName) {
\t\t\tsource = \`\${source}:\${meta.sourceName}\`;
\t\t} else if (meta.agentName) {
\t\t\tsource = \`\${source}:\${meta.agentName}\`;
\t\t}
\t\tconst headerParts = [source, meta.auth?.name, meta.createTime].filter((part) => part?.trim());

\t\tconst container = new Container();
\t\tcontainer.addChild(new Text(theme.fg("warning", headerParts.join(" · ")), 0, 0));
\t\tif (textContent) {
\t\t\tconst box = new Box(1, 1, (t) => theme.bg("userMessageBg", t));
\t\t\tbox.addChild(
\t\t\t\tnew Markdown(textContent, 0, 0, getMarkdownTheme(), {
\t\t\t\t\tcolor: (t) => theme.fg("userMessageText", t),
\t\t\t\t}),
\t\t\t);
\t\t\tcontainer.addChild(box);
\t\t}
\t\treturn container;
\t},
});
`;

function ensureDPiPackageShim(agentDir: string): void {
	const shimDir = join(agentDir, DPI_PACKAGE_SHIM_DIR);
	mkdirSync(shimDir, { recursive: true });
	writeFileSync(join(shimDir, "package.json"), DPI_PACKAGE_SHIM_PACKAGE_JSON);
	writeFileSync(join(shimDir, "index.js"), DPI_PACKAGE_SHIM_SOURCE);
}

export function ensureAgentTuiComponentsClientCapability(agentDir: string): string {
	ensureDPiPackageShim(agentDir);
	const capabilityPath = join(agentDir, CLIENT_CAPABILITY_FILENAME);
	writeFileSync(capabilityPath, CLIENT_CAPABILITY_SOURCE);
	return capabilityPath;
}
