import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import type { AgentSessionProxy } from "../../core/agent-session-proxy.ts";

/**
 * Protocol core: transport-agnostic request handler.
 *
 * This is the single source of truth for all agent serve operations.
 * Both the HTTP wrapper (AgentHttpServer) and the IPC transport
 * (AgentIpcServer) call this function — they differ only in how
 * they receive the request and send the response.
 *
 * @param proxy - The agent session proxy (LocalAgentSessionProxy or RemoteAgentSessionProxy)
 * @param action - The operation name (e.g. "prompt", "abort", "set-model")
 * @param data - The action-specific payload (may be undefined for no-arg actions)
 * @returns A result object with status code and body, suitable for both HTTP and IPC transports
 */
export async function handleProtocolRequest(
	proxy: AgentSessionProxy,
	action: string,
	data: unknown,
): Promise<{ status: number; body: unknown }> {
	const handler = protocolHandlers[action];
	if (!handler) {
		return { status: 404, body: { error: `Unknown action: ${action}` } };
	}
	try {
		return await handler(proxy, data);
	} catch (e: unknown) {
		const message = e instanceof Error ? e.message : "Internal error";
		const status = /busy|streaming/i.test(message) ? 409 : 500;
		return { status, body: { error: message } };
	}
}

/**
 * Protocol handler for GET-style data queries.
 *
 * Returns snapshot data without side effects. Both the HTTP wrapper
 * and the IPC transport use this to respond to initial state requests
 * (e.g. the first message on a new SSE/IPC connection).
 *
 * @param proxy - The agent session proxy
 * @param query - The data query name (e.g. "state", "models", "commands")
 * @returns A result object with status code and body
 */
export async function handleProtocolQuery(
	proxy: AgentSessionProxy,
	query: string,
): Promise<{ status: number; body: unknown }> {
	switch (query) {
		case "state":
			return { status: 200, body: proxy.getSnapshot() };
		case "messages":
			return { status: 200, body: proxy.messages };
		case "settings":
			return { status: 200, body: proxy.getSnapshot().remoteSettings };
		case "tree":
			return { status: 200, body: proxy.getTree() };
		case "user-messages":
			return { status: 200, body: proxy.getUserMessagesForForking() };
		case "sessions":
			return { status: 200, body: await proxy.getSessions() };
		case "commands":
			return { status: 200, body: proxy.getCommands() };
		case "models":
			return { status: 200, body: proxy.getModels() };
		case "client-extensions":
			return { status: 200, body: getClientExtensionPayloads(proxy) };
		default:
			return { status: 404, body: { error: `Unknown query: ${query}` } };
	}
}

type ProtocolHandler = (proxy: AgentSessionProxy, data: unknown) => Promise<{ status: number; body: unknown }>;

function ok(body?: unknown): { status: number; body: unknown } {
	return { status: 200, body: body ?? { ok: true } };
}

function bad(message: string): { status: number; body: unknown } {
	return { status: 400, body: { error: message } };
}

const protocolHandlers: Record<string, ProtocolHandler> = {
	async prompt(proxy, data) {
		const { text, options } = data as { text: string; options?: unknown };
		if (!text) return bad("Missing 'text'");
		await proxy.prompt(text, options as Parameters<typeof proxy.prompt>[1]);
		return ok();
	},

	async steer(proxy, data) {
		const { text, images } = data as { text: string; images?: unknown };
		if (!text) return bad("Missing 'text'");
		proxy.steer(text, images as Parameters<typeof proxy.steer>[1]);
		return ok();
	},

	async "follow-up"(proxy, data) {
		const { text, images } = data as { text: string; images?: unknown };
		if (!text) return bad("Missing 'text'");
		proxy.followUp(text, images as Parameters<typeof proxy.followUp>[1]);
		return ok();
	},

	async abort(proxy) {
		proxy.abort();
		return ok();
	},

	async "abort-bash"(proxy) {
		proxy.abortBash();
		return ok();
	},

	async "clear-queue"(proxy) {
		const dropped = proxy.clearQueue();
		return ok({ ok: true, dropped });
	},

	async compact(proxy, data) {
		const { customInstructions } = data as { customInstructions?: string };
		await proxy.compact(customInstructions);
		return ok();
	},

	async "set-model"(proxy, data) {
		const { modelId } = data as { modelId: string };
		if (!modelId) return bad("Missing 'modelId'");
		proxy.setModel(modelId);
		return ok();
	},

	async "cycle-model"(proxy, data) {
		const { direction } = data as { direction?: 1 | -1 };
		proxy.cycleModel(direction ?? 1);
		return ok();
	},

	async "set-thinking-level"(proxy, data) {
		const { level } = data as { level: string };
		if (!level) return bad("Missing 'level'");
		proxy.setThinkingLevel(level as Parameters<typeof proxy.setThinkingLevel>[0]);
		return ok();
	},

	async "cycle-thinking-level"(proxy, data) {
		const { direction } = data as { direction?: 1 | -1 };
		proxy.cycleThinkingLevel(direction ?? 1);
		return ok();
	},

	async "new-session"(proxy) {
		await proxy.newSession();
		return ok();
	},

	async "switch-session"(proxy, data) {
		const { sessionFile } = data as { sessionFile: string };
		if (!sessionFile) return bad("Missing 'sessionFile'");
		await proxy.switchSession(sessionFile);
		return ok();
	},

	async fork(proxy, data) {
		const { entryId } = data as { entryId?: string };
		await proxy.fork(entryId);
		return ok();
	},

	async name(proxy, data) {
		const { name } = data as { name?: string };
		if (!name) return bad("Missing 'name'");
		proxy.renameSession(name);
		return ok();
	},

	async label(proxy, data) {
		const { entryId, label } = data as { entryId?: string; label?: string };
		if (!entryId) return bad("Missing 'entryId'");
		proxy.setLabel(entryId, label);
		return ok();
	},

	async "scoped-models"(proxy, data) {
		const { enabledIds } = data as { enabledIds?: string[] | null };
		proxy.setScopedModels(enabledIds ?? null);
		return ok();
	},

	async "enabled-models"(proxy, data) {
		const { patterns } = data as { patterns?: string[] };
		proxy.setEnabledModels(patterns);
		return ok();
	},

	async reload(proxy) {
		await proxy.reload();
		return ok();
	},

	async settings(proxy, data) {
		const updates = data as Record<string, unknown>;
		if (!updates || typeof updates !== "object") return bad("Invalid settings body");
		proxy.updateSettings(updates);
		if ("autoCompact" in updates && typeof updates.autoCompact === "boolean") {
			proxy.setAutoCompactEnabled(updates.autoCompact);
		}
		if ("thinkingLevel" in updates && typeof updates.thinkingLevel === "string") {
			proxy.setThinkingLevel(updates.thinkingLevel as Parameters<typeof proxy.setThinkingLevel>[0]);
		}
		if ("steeringMode" in updates && typeof updates.steeringMode === "string") {
			proxy.setSteeringMode(updates.steeringMode as "all" | "one-at-a-time");
		}
		if ("followUpMode" in updates && typeof updates.followUpMode === "string") {
			proxy.setFollowUpMode(updates.followUpMode as "all" | "one-at-a-time");
		}
		return ok();
	},
};

// === Client extension bundling (migrated from api-handlers.ts) ===

function hasClientExport(source: string): boolean {
	return /export\s+(async\s+)?function\s+client\b/.test(source) || /export\s+const\s+client\b/.test(source);
}

interface ClientExtensionBundle {
	path: string;
	entry: string;
	files: Array<{ path: string; content: string }>;
}

const RELATIVE_IMPORT_RE = /(?:import|export)\s+(?:[^"']*\s+from\s+)?["'](\.{1,2}\/[^"']+)["']/g;

function toRelativeBundlePath(baseDir: string, filePath: string): string {
	const relativePath = relative(baseDir, filePath);
	if (relativePath.startsWith("..") || relativePath.includes(`..${sep}`)) {
		throw new Error(`Extension dependency escapes its base directory: ${filePath}`);
	}
	return relativePath.split(sep).join("/");
}

function resolveRelativeModule(fromFile: string, specifier: string): string | undefined {
	const base = resolve(dirname(fromFile), specifier);
	const candidates = extname(base)
		? [base]
		: [base, `${base}.ts`, `${base}.js`, join(base, "index.ts"), join(base, "index.js")];
	return candidates.find((candidate) => existsSync(candidate));
}

function commonDirectory(paths: string[]): string {
	if (paths.length === 0) return "";
	const [first, ...rest] = paths.map((p) => dirname(p).split(sep));
	let length = first.length;
	for (const parts of rest) {
		while (length > 0 && parts.slice(0, length).join(sep) !== first.slice(0, length).join(sep)) {
			length--;
		}
	}
	return first.slice(0, length).join(sep) || sep;
}

function collectExtensionFiles(entryPath: string): {
	baseDir: string;
	files: Array<{ path: string; content: string }>;
} {
	const visited = new Set<string>();
	const contents = new Map<string, string>();
	const visit = (filePath: string) => {
		const resolvedPath = resolve(filePath);
		if (visited.has(resolvedPath)) return;
		visited.add(resolvedPath);
		const content = readFileSync(resolvedPath, "utf-8");
		contents.set(resolvedPath, content);
		for (const match of content.matchAll(RELATIVE_IMPORT_RE)) {
			const dependency = resolveRelativeModule(resolvedPath, match[1]);
			if (dependency) {
				visit(dependency);
			}
		}
	};
	visit(entryPath);
	const baseDir = commonDirectory(Array.from(contents.keys()));
	const files = Array.from(contents.entries()).map(([filePath, content]) => ({
		path: toRelativeBundlePath(baseDir, filePath),
		content,
	}));
	return { baseDir, files };
}

function getClientExtensionPayloads(proxy: AgentSessionProxy): ClientExtensionBundle[] {
	const payloads: ClientExtensionBundle[] = [];
	for (const path of proxy.getSnapshot().extensionPaths) {
		if (path.startsWith("<")) {
			continue;
		}
		const source = readFileSync(path, "utf-8");
		if (hasClientExport(source)) {
			const bundle = collectExtensionFiles(path);
			payloads.push({
				path,
				entry: toRelativeBundlePath(bundle.baseDir, path),
				files: bundle.files,
			});
		}
	}
	return payloads;
}
