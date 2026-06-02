import { existsSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import type { AgentSessionProxy } from "../../core/agent-session-proxy.ts";

function parseBody(req: IncomingMessage): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			const raw = Buffer.concat(chunks).toString("utf-8");
			if (!raw) {
				resolve(undefined);
				return;
			}
			try {
				resolve(JSON.parse(raw));
			} catch {
				reject(new Error("Invalid JSON body"));
			}
		});
		req.on("error", reject);
	});
}

function sendJson(res: ServerResponse, statusCode: number, data: unknown): void {
	const body = JSON.stringify(data);
	res.writeHead(statusCode, {
		"Content-Type": "application/json",
		"Content-Length": Buffer.byteLength(body),
	});
	res.end(body);
}

function sendError(res: ServerResponse, statusCode: number, message: string): void {
	sendJson(res, statusCode, { error: message });
}

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

type ApiHandler = (proxy: AgentSessionProxy, body: unknown, res: ServerResponse) => Promise<void>;

const handlers: Record<string, ApiHandler> = {
	async prompt(proxy, body, res) {
		const { text, options } = body as { text: string; options?: unknown };
		if (!text) {
			sendError(res, 400, "Missing 'text'");
			return;
		}
		try {
			await proxy.prompt(text, options as Parameters<typeof proxy.prompt>[1]);
			sendJson(res, 200, { ok: true });
		} catch (e: unknown) {
			sendError(res, 409, e instanceof Error ? e.message : "Agent is busy");
		}
	},

	async steer(proxy, body, res) {
		const { text, images } = body as { text: string; images?: unknown };
		if (!text) {
			sendError(res, 400, "Missing 'text'");
			return;
		}
		proxy.steer(text, images as Parameters<typeof proxy.steer>[1]);
		sendJson(res, 200, { ok: true });
	},

	async "follow-up"(proxy, body, res) {
		const { text, images } = body as { text: string; images?: unknown };
		if (!text) {
			sendError(res, 400, "Missing 'text'");
			return;
		}
		proxy.followUp(text, images as Parameters<typeof proxy.followUp>[1]);
		sendJson(res, 200, { ok: true });
	},

	async abort(proxy, _body, res) {
		proxy.abort();
		sendJson(res, 200, { ok: true });
	},

	async "abort-bash"(proxy, _body, res) {
		proxy.abortBash();
		sendJson(res, 200, { ok: true });
	},

	async compact(proxy, body, res) {
		const { customInstructions } = body as { customInstructions?: string };
		await proxy.compact(customInstructions);
		sendJson(res, 200, { ok: true });
	},

	async "set-model"(proxy, body, res) {
		const { modelId } = body as { modelId: string };
		if (!modelId) {
			sendError(res, 400, "Missing 'modelId'");
			return;
		}
		proxy.setModel(modelId);
		sendJson(res, 200, { ok: true });
	},

	async "cycle-model"(proxy, body, res) {
		const { direction } = body as { direction?: 1 | -1 };
		proxy.cycleModel(direction ?? 1);
		sendJson(res, 200, { ok: true });
	},

	async "set-thinking-level"(proxy, body, res) {
		const { level } = body as { level: string };
		if (!level) {
			sendError(res, 400, "Missing 'level'");
			return;
		}
		proxy.setThinkingLevel(level as Parameters<typeof proxy.setThinkingLevel>[0]);
		sendJson(res, 200, { ok: true });
	},

	async "cycle-thinking-level"(proxy, body, res) {
		const { direction } = body as { direction?: 1 | -1 };
		proxy.cycleThinkingLevel(direction ?? 1);
		sendJson(res, 200, { ok: true });
	},

	async "new-session"(proxy, _body, res) {
		await proxy.newSession();
		sendJson(res, 200, { ok: true });
	},

	async "switch-session"(proxy, body, res) {
		const { sessionFile } = body as { sessionFile: string };
		if (!sessionFile) {
			sendError(res, 400, "Missing 'sessionFile'");
			return;
		}
		await proxy.switchSession(sessionFile);
		sendJson(res, 200, { ok: true });
	},

	async fork(proxy, body, res) {
		const { entryId } = body as { entryId?: string };
		await proxy.fork(entryId);
		sendJson(res, 200, { ok: true });
	},

	async name(proxy, body, res) {
		const { name } = body as { name?: string };
		if (!name) {
			sendError(res, 400, "Missing 'name'");
			return;
		}
		proxy.renameSession(name);
		sendJson(res, 200, { ok: true });
	},

	async label(proxy, body, res) {
		const { entryId, label } = body as { entryId?: string; label?: string };
		if (!entryId) {
			sendError(res, 400, "Missing 'entryId'");
			return;
		}
		proxy.setLabel(entryId, label);
		sendJson(res, 200, { ok: true });
	},

	async "scoped-models"(proxy, body, res) {
		const { enabledIds } = body as { enabledIds?: string[] | null };
		proxy.setScopedModels(enabledIds ?? null);
		sendJson(res, 200, { ok: true });
	},

	async "enabled-models"(proxy, body, res) {
		const { patterns } = body as { patterns?: string[] };
		proxy.setEnabledModels(patterns);
		sendJson(res, 200, { ok: true });
	},

	async reload(proxy, _body, res) {
		await proxy.reload();
		sendJson(res, 200, { ok: true });
	},

	async settings(proxy, body, res) {
		const updates = body as Record<string, unknown>;
		if (!updates || typeof updates !== "object") {
			sendError(res, 400, "Invalid settings body");
			return;
		}
		// Delegate to the generic updateSettings which handles all keys
		proxy.updateSettings(updates);
		// Also handle the proxy-level settings that aren't in SettingsManager
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
		sendJson(res, 200, { ok: true });
	},
};

export async function handleApiRequest(
	proxy: AgentSessionProxy,
	req: IncomingMessage,
	res: ServerResponse,
): Promise<void> {
	const method = req.method ?? "GET";
	const url = new URL(req.url ?? "/", "http://localhost");
	const path = url.pathname.slice(1); // Remove leading "/"

	// GET endpoints
	if (method === "GET") {
		if (path === "state") {
			sendJson(res, 200, proxy.getSnapshot());
			return;
		}
		if (path === "messages") {
			sendJson(res, 200, proxy.messages);
			return;
		}
		if (path === "settings") {
			sendJson(res, 200, proxy.getSnapshot().remoteSettings);
			return;
		}
		if (path === "tree") {
			sendJson(res, 200, proxy.getTree());
			return;
		}
		if (path === "user-messages") {
			sendJson(res, 200, proxy.getUserMessagesForForking());
			return;
		}
		if (path === "sessions") {
			try {
				const sessions = await proxy.getSessions();
				sendJson(res, 200, sessions);
			} catch (e: unknown) {
				sendError(res, 500, e instanceof Error ? e.message : "Failed to list sessions");
			}
			return;
		}
		if (path === "commands") {
			sendJson(res, 200, proxy.getCommands());
			return;
		}
		if (path === "models") {
			sendJson(res, 200, proxy.getModels());
			return;
		}
		if (path === "client-extensions") {
			sendJson(res, 200, getClientExtensionPayloads(proxy));
			return;
		}
		sendError(res, 404, `Unknown GET endpoint: /${path}`);
		return;
	}

	// POST endpoints
	if (method === "POST") {
		const handler = handlers[path];
		if (!handler) {
			sendError(res, 404, `Unknown POST endpoint: /${path}`);
			return;
		}
		try {
			const body = await parseBody(req);
			await handler(proxy, body, res);
		} catch (e: unknown) {
			sendError(res, 500, e instanceof Error ? e.message : "Internal error");
		}
		return;
	}

	sendError(res, 405, `Method not allowed: ${method}`);
}
