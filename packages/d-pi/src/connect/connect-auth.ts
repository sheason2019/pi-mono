import { homedir } from "node:os";
import { join } from "node:path";
import { findLocalUserByName } from "../auth/local-users.ts";
import { signChallenge } from "../auth/signing.ts";

export interface ConnectSessionOptions {
	target: string;
	localUsersRoot?: string;
	fetchImpl?: typeof fetch;
	/**
	 * Max time in ms for a single auth HTTP request (challenge and session).
	 * Default 10_000. Without a bound, an unresponsive or misconfigured hub
	 * (e.g. one that flushes 200 + empty body on a failed challenge) would
	 * make `d-pi connect` hang indefinitely. 10s is short enough to fail
	 * fast in interactive use and long enough for a healthy round trip.
	 */
	authTimeoutMs?: number;
}

export interface ConnectSession {
	url: string;
	token: string;
}

function parseTarget(target: string): { localUserName: string; url: string } {
	const separator = target.indexOf("@");
	if (separator <= 0 || separator === target.length - 1) {
		throw new Error("connect target must be <user@serve_url>");
	}
	return { localUserName: target.slice(0, separator), url: target.slice(separator + 1).replace(/\/$/, "") };
}

function defaultLocalUsersRoot(): string {
	return join(homedir(), ".d-pi");
}

const DEFAULT_AUTH_TIMEOUT_MS = 10_000;

interface PostJsonContext {
	localUserName: string;
	publicKey: string;
	timeoutMs: number;
}

async function postJson<T>(fetchImpl: typeof fetch, url: string, body: unknown, ctx: PostJsonContext): Promise<T> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), ctx.timeoutMs);
	let response: Response;
	try {
		response = await fetchImpl(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
			signal: controller.signal,
		});
	} catch (err) {
		clearTimeout(timer);
		if (err instanceof Error && err.name === "AbortError") {
			throw new Error(
				`Connection to ${url} timed out after ${ctx.timeoutMs}ms. ` +
					`The hub may be down. If it is running, ask the admin to allow-user add ${ctx.localUserName}.`,
			);
		}
		throw new Error(
			`Failed to reach hub at ${url}: ${err instanceof Error ? err.message : String(err)}. ` +
				`Check that the hub is running and reachable.`,
		);
	}
	clearTimeout(timer);

	let data: (T & { error?: string }) | undefined;
	try {
		data = (await response.json()) as T & { error?: string };
	} catch {
		// Server replied but with a non-JSON body (or no body at all). This
		// used to silently hang the client on a 200 + empty body from a buggy
		// auth handler. Surface it as an explicit auth-style failure so the
		// caller can produce a clear error and exit non-zero.
		throw new Error(
			`Invalid response from ${url}: HTTP ${response.status} ${response.statusText} (not JSON). ` +
				`The hub may be misconfigured or returning a partial response.`,
		);
	}

	if (!response.ok) {
		const serverMsg = data.error ?? `HTTP ${response.status}`;
		if (response.status === 401 || response.status === 403) {
			throw new Error(
				`User '${ctx.localUserName}' is not in allow-user list (server: ${serverMsg}). ` +
					`Ask the hub admin to allow: d-pi allow-user add ${ctx.localUserName} --key ${ctx.publicKey}`,
			);
		}
		throw new Error(serverMsg);
	}
	return data;
}

export async function createConnectSession(options: ConnectSessionOptions): Promise<ConnectSession> {
	const { localUserName, url } = parseTarget(options.target);
	const localUsersRoot = options.localUsersRoot ?? defaultLocalUsersRoot();
	const localUser = findLocalUserByName(localUsersRoot, localUserName);
	if (!localUser) {
		throw new Error(
			`Local user not found: ${localUserName}. ` + `Create it with: d-pi users create ${localUserName}`,
		);
	}
	const fetchImpl = options.fetchImpl ?? fetch;
	const ctx: PostJsonContext = {
		localUserName,
		publicKey: localUser.publicKey,
		timeoutMs: options.authTimeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS,
	};
	const challenge = await postJson<{ challengeId: string; challenge: string }>(
		fetchImpl,
		`${url}/api/auth/challenge`,
		{ publicKey: localUser.publicKey },
		ctx,
	);
	const session = await postJson<{ token: string }>(
		fetchImpl,
		`${url}/api/auth/session`,
		{
			publicKey: localUser.publicKey,
			challengeId: challenge.challengeId,
			signature: signChallenge(localUser, challenge.challenge),
		},
		ctx,
	);
	return { url, token: session.token };
}
