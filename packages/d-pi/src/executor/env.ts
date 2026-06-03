export interface ExecutorEnv {
	hubUrl: string;
	/** Bearer token. Undefined in dev mode (hub without auth). */
	authToken?: string;
	connectId: string;
	cwd: string;
}

export function readExecutorEnv(
	source: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): ExecutorEnv {
	const hubUrl = source.DPI_HUB_URL;
	const authToken = source.DPI_AUTH_TOKEN;
	const connectId = source.DPI_CONNECT_ID;
	const cwd = source.DPI_CWD;
	const missing: string[] = [];
	if (!hubUrl) missing.push("DPI_HUB_URL");
	if (!connectId) missing.push("DPI_CONNECT_ID");
	if (!cwd) missing.push("DPI_CWD");
	if (missing.length > 0) {
		throw new Error(`Missing required env vars: ${missing.join(", ")}`);
	}
	return { hubUrl: hubUrl!, authToken, connectId: connectId!, cwd: cwd! };
}
