import type { ResourceDiagnostic, ResourceLoader } from "@earendil-works/pi-coding-agent";

export interface PeerResourceContribution {
	peerId: string;
	description?: string;
}

export interface HubResourceAggregationState {
	mode: "local-only";
	peerContributions: PeerResourceContribution[];
}

export interface HubResourceSummary {
	extensions: number;
	skills: number;
	prompts: number;
	themes: number;
	agentsFiles: number;
	hasSystemPrompt: boolean;
	appendSystemPromptCount: number;
	diagnostics: ResourceDiagnostic[];
}

export class HubResourceLoader implements ResourceLoader {
	private readonly peerContributions: PeerResourceContribution[] = [];

	constructor(private readonly delegate: ResourceLoader) {}

	static wrap(resourceLoader: ResourceLoader): HubResourceLoader {
		return resourceLoader instanceof HubResourceLoader ? resourceLoader : new HubResourceLoader(resourceLoader);
	}

	getExtensions() {
		return this.delegate.getExtensions();
	}

	getSkills() {
		return this.delegate.getSkills();
	}

	getPrompts() {
		return this.delegate.getPrompts();
	}

	getThemes() {
		return this.delegate.getThemes();
	}

	getAgentsFiles() {
		return this.delegate.getAgentsFiles();
	}

	getSystemPrompt(): string | undefined {
		return this.delegate.getSystemPrompt();
	}

	getAppendSystemPrompt(): string[] {
		return this.delegate.getAppendSystemPrompt();
	}

	extendResources(paths: Parameters<ResourceLoader["extendResources"]>[0]): void {
		this.delegate.extendResources(paths);
	}

	async reload(): Promise<void> {
		await this.delegate.reload();
	}

	getAggregationState(): HubResourceAggregationState {
		return {
			mode: "local-only",
			peerContributions: [...this.peerContributions],
		};
	}

	getSummary(): HubResourceSummary {
		const extensions = this.getExtensions();
		const skills = this.getSkills();
		const prompts = this.getPrompts();
		const themes = this.getThemes();
		return {
			extensions: extensions.extensions.length,
			skills: skills.skills.length,
			prompts: prompts.prompts.length,
			themes: themes.themes.length,
			agentsFiles: this.getAgentsFiles().agentsFiles.length,
			hasSystemPrompt: this.getSystemPrompt() !== undefined,
			appendSystemPromptCount: this.getAppendSystemPrompt().length,
			diagnostics: [
				...extensions.errors.map(({ path, error }) => ({
					type: "error" as const,
					message: error,
					path,
				})),
				...skills.diagnostics,
				...prompts.diagnostics,
				...themes.diagnostics,
			],
		};
	}

	getDelegate(): ResourceLoader {
		return this.delegate;
	}
}
