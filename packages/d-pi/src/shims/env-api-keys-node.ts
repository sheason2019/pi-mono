import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { KnownProvider } from "@earendil-works/pi-ai";

let procEnvCache: Map<string, string> | null = null;

function getProcEnv(key: string): string | undefined {
	if (!process.versions?.bun) {
		return undefined;
	}
	if (Object.keys(process.env).length > 0) {
		return undefined;
	}

	if (procEnvCache === null) {
		procEnvCache = new Map();
		try {
			const data = readFileSync("/proc/self/environ", "utf-8");
			for (const entry of data.split("\0")) {
				const idx = entry.indexOf("=");
				if (idx > 0) {
					procEnvCache.set(entry.slice(0, idx), entry.slice(idx + 1));
				}
			}
		} catch {
			// /proc/self/environ may not be readable.
		}
	}

	return procEnvCache.get(key);
}

let cachedVertexAdcCredentialsExists: boolean | null = null;

function hasVertexAdcCredentials(): boolean {
	if (cachedVertexAdcCredentialsExists === null) {
		const gacPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || getProcEnv("GOOGLE_APPLICATION_CREDENTIALS");
		cachedVertexAdcCredentialsExists = gacPath
			? existsSync(gacPath)
			: existsSync(join(homedir(), ".config", "gcloud", "application_default_credentials.json"));
	}
	return cachedVertexAdcCredentialsExists;
}

function getApiKeyEnvVars(provider: string): readonly string[] | undefined {
	if (provider === "github-copilot") {
		return ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"];
	}

	if (provider === "anthropic") {
		return ["ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"];
	}

	const envMap: Record<string, string> = {
		openai: "OPENAI_API_KEY",
		"azure-openai-responses": "AZURE_OPENAI_API_KEY",
		deepseek: "DEEPSEEK_API_KEY",
		google: "GEMINI_API_KEY",
		"google-vertex": "GOOGLE_CLOUD_API_KEY",
		groq: "GROQ_API_KEY",
		cerebras: "CEREBRAS_API_KEY",
		xai: "XAI_API_KEY",
		openrouter: "OPENROUTER_API_KEY",
		"vercel-ai-gateway": "AI_GATEWAY_API_KEY",
		zai: "ZAI_API_KEY",
		mistral: "MISTRAL_API_KEY",
		minimax: "MINIMAX_API_KEY",
		"minimax-cn": "MINIMAX_CN_API_KEY",
		moonshotai: "MOONSHOT_API_KEY",
		"moonshotai-cn": "MOONSHOT_API_KEY",
		huggingface: "HF_TOKEN",
		fireworks: "FIREWORKS_API_KEY",
		together: "TOGETHER_API_KEY",
		opencode: "OPENCODE_API_KEY",
		"opencode-go": "OPENCODE_API_KEY",
		"kimi-coding": "KIMI_API_KEY",
		"cloudflare-workers-ai": "CLOUDFLARE_API_KEY",
		"cloudflare-ai-gateway": "CLOUDFLARE_API_KEY",
		xiaomi: "XIAOMI_API_KEY",
		"xiaomi-token-plan-cn": "XIAOMI_TOKEN_PLAN_CN_API_KEY",
		"xiaomi-token-plan-ams": "XIAOMI_TOKEN_PLAN_AMS_API_KEY",
		"xiaomi-token-plan-sgp": "XIAOMI_TOKEN_PLAN_SGP_API_KEY",
	};

	const envVar = envMap[provider];
	return envVar ? [envVar] : undefined;
}

export function findEnvKeys(provider: KnownProvider): string[] | undefined;
export function findEnvKeys(provider: string): string[] | undefined;
export function findEnvKeys(provider: string): string[] | undefined {
	const envVars = getApiKeyEnvVars(provider);
	if (!envVars) {
		return undefined;
	}

	const found = envVars.filter((envVar) => !!process.env[envVar] || !!getProcEnv(envVar));
	return found.length > 0 ? found : undefined;
}

export function getEnvApiKey(provider: KnownProvider): string | undefined;
export function getEnvApiKey(provider: string): string | undefined;
export function getEnvApiKey(provider: string): string | undefined {
	const envKeys = findEnvKeys(provider);
	if (envKeys?.[0]) {
		return process.env[envKeys[0]] || getProcEnv(envKeys[0]);
	}

	if (provider === "google-vertex") {
		const hasCredentials = hasVertexAdcCredentials();
		const hasProject = !!(
			process.env.GOOGLE_CLOUD_PROJECT ||
			process.env.GCLOUD_PROJECT ||
			getProcEnv("GOOGLE_CLOUD_PROJECT") ||
			getProcEnv("GCLOUD_PROJECT")
		);
		const hasLocation = !!(process.env.GOOGLE_CLOUD_LOCATION || getProcEnv("GOOGLE_CLOUD_LOCATION"));

		if (hasCredentials && hasProject && hasLocation) {
			return "<authenticated>";
		}
	}

	if (provider === "amazon-bedrock") {
		if (
			process.env.AWS_PROFILE ||
			(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) ||
			process.env.AWS_BEARER_TOKEN_BEDROCK ||
			process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI ||
			process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI ||
			process.env.AWS_WEB_IDENTITY_TOKEN_FILE ||
			getProcEnv("AWS_PROFILE") ||
			(getProcEnv("AWS_ACCESS_KEY_ID") && getProcEnv("AWS_SECRET_ACCESS_KEY")) ||
			getProcEnv("AWS_BEARER_TOKEN_BEDROCK") ||
			getProcEnv("AWS_CONTAINER_CREDENTIALS_RELATIVE_URI") ||
			getProcEnv("AWS_CONTAINER_CREDENTIALS_FULL_URI") ||
			getProcEnv("AWS_WEB_IDENTITY_TOKEN_FILE")
		) {
			return "<authenticated>";
		}
	}

	return undefined;
}
