import { z } from "zod";

export interface ExecutorEnv {
	hubUrl: string;
	/** Bearer token. Undefined in dev mode (hub without auth). */
	authToken?: string;
	connectId: string;
	cwd: string;
}

const executorEnvSchema = z.object({
	DPI_HUB_URL: z.string().min(1),
	DPI_AUTH_TOKEN: z.string().optional(),
	DPI_CONNECT_ID: z.string().min(1),
	DPI_CWD: z.string().min(1),
});

export function readExecutorEnv(
	source: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): ExecutorEnv {
	const result = executorEnvSchema.safeParse(source);
	if (!result.success) {
		const missing = result.error.issues.map((issue) => issue.path.join(".")).join(", ");
		throw new Error(`Missing required env vars: ${missing}`);
	}
	return {
		hubUrl: result.data.DPI_HUB_URL,
		authToken: result.data.DPI_AUTH_TOKEN,
		connectId: result.data.DPI_CONNECT_ID,
		cwd: result.data.DPI_CWD,
	};
}
