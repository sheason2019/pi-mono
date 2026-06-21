import type { DPiInteractiveAgentSessionProxy } from "./agent-session-proxy.ts";

export interface DPiInteractiveProtocolResult {
	status: number;
	body: unknown;
}

type DPiInteractiveProtocolHandler = (
	proxy: DPiInteractiveAgentSessionProxy,
	data: unknown,
) => Promise<DPiInteractiveProtocolResult>;

function ok(body?: unknown): DPiInteractiveProtocolResult {
	return { status: 200, body: body ?? { ok: true } };
}

function bad(message: string): DPiInteractiveProtocolResult {
	return { status: 400, body: { error: message } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textBody(data: unknown): { text: string; options?: unknown; images?: unknown } | undefined {
	if (!isRecord(data) || typeof data.text !== "string" || data.text.length === 0) {
		return undefined;
	}
	return {
		text: data.text,
		...(data.options === undefined ? {} : { options: data.options }),
		...(data.images === undefined ? {} : { images: data.images }),
	};
}

export async function handleDPiInteractiveProtocolQuery(
	proxy: DPiInteractiveAgentSessionProxy,
	query: string,
): Promise<DPiInteractiveProtocolResult> {
	switch (query) {
		case "state":
			return ok(proxy.getSnapshot());
		case "messages":
			return ok(proxy.messages);
		case "settings":
			return ok(proxy.getSnapshot().remoteSettings);
		case "tree":
			return ok(await proxy.fetchTree());
		case "user-messages":
			return ok(await proxy.fetchUserMessagesForForking());
		case "sessions":
			return ok(await proxy.getSessions());
		case "commands":
			return ok(await proxy.fetchCommands());
		case "client-extensions":
			return ok(await proxy.fetchClientExtensions());
		default:
			return { status: 404, body: { error: `Unknown query: ${query}` } };
	}
}

const protocolHandlers: Record<string, DPiInteractiveProtocolHandler> = {
	async prompt(proxy, data) {
		const body = textBody(data);
		if (!body) {
			return bad("Missing 'text'");
		}
		await proxy.prompt(body.text, body.options as Parameters<typeof proxy.prompt>[1]);
		return ok();
	},

	async steer(proxy, data) {
		const body = textBody(data);
		if (!body) {
			return bad("Missing 'text'");
		}
		proxy.steer(body.text, body.images as Parameters<typeof proxy.steer>[1]);
		return ok();
	},

	async "follow-up"(proxy, data) {
		const body = textBody(data);
		if (!body) {
			return bad("Missing 'text'");
		}
		proxy.followUp(body.text, body.images as Parameters<typeof proxy.followUp>[1]);
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
		return ok({ ok: true, dropped: proxy.clearQueue() });
	},

	async compact(proxy, data) {
		const customInstructions =
			isRecord(data) && typeof data.customInstructions === "string" ? data.customInstructions : undefined;
		await proxy.compact(customInstructions);
		return ok();
	},

	async "set-thinking-level"(proxy, data) {
		if (!isRecord(data) || typeof data.level !== "string") {
			return bad("Missing 'level'");
		}
		proxy.setThinkingLevel(data.level as Parameters<typeof proxy.setThinkingLevel>[0]);
		return ok();
	},

	async "cycle-thinking-level"(proxy, data) {
		const direction = isRecord(data) && data.direction === -1 ? -1 : 1;
		proxy.cycleThinkingLevel(direction);
		return ok();
	},

	async "new-session"(proxy) {
		await proxy.newSession();
		return ok();
	},

	async "switch-session"(proxy, data) {
		if (!isRecord(data) || typeof data.sessionFile !== "string") {
			return bad("Missing 'sessionFile'");
		}
		await proxy.switchSession(data.sessionFile);
		return ok();
	},

	async fork(proxy, data) {
		const entryId = isRecord(data) && typeof data.entryId === "string" ? data.entryId : undefined;
		await proxy.fork(entryId);
		return ok();
	},

	async name(proxy, data) {
		if (!isRecord(data) || typeof data.name !== "string") {
			return bad("Missing 'name'");
		}
		proxy.renameSession(data.name);
		return ok();
	},

	async label(proxy, data) {
		if (!isRecord(data) || typeof data.entryId !== "string") {
			return bad("Missing 'entryId'");
		}
		const label = typeof data.label === "string" ? data.label : undefined;
		proxy.setLabel(data.entryId, label);
		return ok();
	},

	async reload(proxy) {
		await proxy.reload();
		return ok();
	},

	async settings(proxy, data) {
		if (!isRecord(data)) {
			return bad("Invalid settings body");
		}
		proxy.updateSettings(data);
		if (typeof data.autoCompact === "boolean") {
			proxy.setAutoCompactEnabled(data.autoCompact);
		}
		if (typeof data.thinkingLevel === "string") {
			proxy.setThinkingLevel(data.thinkingLevel as Parameters<typeof proxy.setThinkingLevel>[0]);
		}
		if (data.steeringMode === "all" || data.steeringMode === "one-at-a-time") {
			proxy.setSteeringMode(data.steeringMode);
		}
		if (data.followUpMode === "all" || data.followUpMode === "one-at-a-time") {
			proxy.setFollowUpMode(data.followUpMode);
		}
		return ok();
	},
};

export async function handleDPiInteractiveProtocolRequest(
	proxy: DPiInteractiveAgentSessionProxy,
	action: string,
	data: unknown,
): Promise<DPiInteractiveProtocolResult> {
	const handler = protocolHandlers[action];
	if (!handler) {
		return { status: 404, body: { error: `Unknown action: ${action}` } };
	}
	try {
		return await handler(proxy, data);
	} catch (error) {
		const message = error instanceof Error ? error.message : "Internal error";
		return { status: /busy|streaming/i.test(message) ? 409 : 500, body: { error: message } };
	}
}
