import { homedir } from "node:os";
import { join } from "node:path";
import { findLocalUserByName } from "../auth/local-users.ts";
import { signChallenge } from "../auth/signing.ts";

export interface ConnectSessionOptions {
	target: string;
	localUsersRoot?: string;
	fetchImpl?: typeof fetch;
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

async function postJson<T>(fetchImpl: typeof fetch, url: string, body: unknown): Promise<T> {
	const response = await fetchImpl(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	const data = (await response.json()) as T & { error?: string };
	if (!response.ok) {
		throw new Error(data.error ?? `HTTP ${response.status}`);
	}
	return data;
}

export async function createConnectSession(options: ConnectSessionOptions): Promise<ConnectSession> {
	const { localUserName, url } = parseTarget(options.target);
	const localUsersRoot = options.localUsersRoot ?? defaultLocalUsersRoot();
	const localUser = findLocalUserByName(localUsersRoot, localUserName);
	if (!localUser) {
		throw new Error(`Local user not found: ${localUserName}`);
	}
	const fetchImpl = options.fetchImpl ?? fetch;
	const challenge = await postJson<{ challengeId: string; challenge: string }>(
		fetchImpl,
		`${url}/_hub/auth/challenge`,
		{ publicKey: localUser.publicKey },
	);
	const session = await postJson<{ token: string }>(fetchImpl, `${url}/_hub/auth/session`, {
		publicKey: localUser.publicKey,
		challengeId: challenge.challengeId,
		signature: signChallenge(localUser, challenge.challenge),
	});
	return { url, token: session.token };
}
