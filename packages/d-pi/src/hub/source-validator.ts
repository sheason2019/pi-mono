/**
 * Validate a single line of source stdout as a JSON-RPC 2.0 message.
 * Returns a discriminated union indicating what the hub should do:
 *  - notification: forward to agent
 *  - request: silent drop (source is a push service, doesn't process requests)
 *  - response: silent drop (same)
 *  - invalid: log warning, drop
 *
 * JSON-RPC 2.0 classification (per the spec):
 *  - notification: has `method`, no (non-null) `id`, no `result`/`error`
 *  - request:     has `method` AND `id`, no `result`/`error`
 *  - response:    has `result` or `error`
 *
 * The hub is a push dispatcher: it parses all three shapes cleanly so a
 * misbehaving source that emits a request/response still gets handled
 * gracefully, but only notifications are forwarded to subscribed agents.
 */
export type ValidationResult =
	| { kind: "notification"; payload: JsonRpcMessage }
	| { kind: "request"; payload: JsonRpcMessage }
	| { kind: "response"; payload: JsonRpcMessage }
	| { kind: "invalid"; reason: string };

export interface JsonRpcMessage {
	jsonrpc: string;
	method?: string;
	id?: string | number;
	params?: Record<string, unknown>;
	result?: unknown;
	error?: unknown;
}

export function validateLine(line: string): ValidationResult {
	try {
		const parsed = JSON.parse(line) as Record<string, unknown>;

		if (parsed.jsonrpc !== "2.0") {
			return { kind: "invalid", reason: "missing or non-2.0 jsonrpc field" };
		}

		// `result` or `error` → response (regardless of method/id presence)
		if ("result" in parsed || "error" in parsed) {
			return { kind: "response", payload: parsed as unknown as JsonRpcMessage };
		}

		const hasMethod = typeof parsed.method === "string" && parsed.method.length > 0;
		// Treat a present-but-null `id` as absent — JSON-RPC 2.0 considers
		// `id: null` equivalent to "no id" for routing purposes.
		const hasId = "id" in parsed && parsed.id !== null;

		if (hasMethod && hasId) {
			return { kind: "request", payload: parsed as unknown as JsonRpcMessage };
		}

		if (hasMethod) {
			return { kind: "notification", payload: parsed as unknown as JsonRpcMessage };
		}

		if (hasId) {
			return { kind: "request", payload: parsed as unknown as JsonRpcMessage };
		}

		return { kind: "invalid", reason: "no method field" };
	} catch (err) {
		return { kind: "invalid", reason: `JSON parse failed: ${(err as Error).message}` };
	}
}
