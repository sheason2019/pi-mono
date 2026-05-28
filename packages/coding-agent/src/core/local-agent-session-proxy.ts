import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { AgentSession, AgentSessionEvent } from "./agent-session.ts";
import type { AgentSessionProxy, BannerData, SessionStateSnapshot } from "./agent-session-proxy.ts";
import type { AgentSessionRuntime } from "./agent-session-runtime.ts";

/**
 * Convert proxy-style image format ({ url, mediaType }) to the ImageContent
 * format expected by AgentSession ({ type, data, mimeType }).
 *
 * Supports:
 * - data URLs:  data:image/png;base64,iVBOR...  ->  { type: "image", data: "iVBOR...", mimeType: "image/png" }
 * - bare base64 with mediaType:  { url: "<base64>", mediaType: "image/png" }
 */
function toImageContent(images: Array<{ url: string; mediaType?: string }>): ImageContent[] {
	return images.map(({ url, mediaType }): ImageContent => {
		// Data URL:  data:<mimeType>;base64,<data>
		const dataUrlMatch = url.match(/^data:([^;]+);base64,(.+)$/s);
		if (dataUrlMatch) {
			return { type: "image", data: dataUrlMatch[2], mimeType: dataUrlMatch[1] };
		}
		// Bare base64 — mediaType is required
		if (mediaType) {
			return { type: "image", data: url, mimeType: mediaType };
		}
		throw new Error(
			`Cannot convert image: URL is not a data URL and no mediaType provided. ` +
				`LocalAgentSessionProxy only supports data-URL images or base64 with explicit mediaType.`,
		);
	});
}

/**
 * Local implementation of AgentSessionProxy that wraps an in-process
 * AgentSession + AgentSessionRuntime.
 *
 * Used by serve mode (and could be used by interactive mode in the future).
 */
export class LocalAgentSessionProxy implements AgentSessionProxy {
	private readonly _runtime: AgentSessionRuntime;
	private _banner: BannerData | undefined;

	constructor(runtime: AgentSessionRuntime) {
		this._runtime = runtime;
	}

	/** Set the banner data (called by serve mode after initialization) */
	setBanner(banner: BannerData | undefined): void {
		this._banner = banner;
	}

	private get session(): AgentSession {
		return this._runtime.session;
	}

	// =========================================================================
	// Event subscription
	// =========================================================================

	subscribe(listener: (event: AgentSessionEvent) => void): () => void {
		return this.session.subscribe(listener);
	}

	// =========================================================================
	// Commands
	// =========================================================================

	async prompt(text: string, options?: { images?: Array<{ url: string; mediaType?: string }> }): Promise<void> {
		const images = options?.images ? toImageContent(options.images) : undefined;
		await this.session.prompt(text, { images });
	}

	steer(text: string, images?: Array<{ url: string; mediaType?: string }>): void {
		const converted = images ? toImageContent(images) : undefined;
		// AgentSession.steer() is async but the interface declares void.
		// Fire-and-forget to satisfy the synchronous signature.
		void this.session.steer(text, converted);
	}

	followUp(text: string, images?: Array<{ url: string; mediaType?: string }>): void {
		const converted = images ? toImageContent(images) : undefined;
		// AgentSession.followUp() is async but the interface declares void.
		// Fire-and-forget to satisfy the synchronous signature.
		void this.session.followUp(text, converted);
	}

	abort(): void {
		// AgentSession.abort() is async but the interface declares void.
		// Fire-and-forget to satisfy the synchronous signature.
		void this.session.abort();
	}

	// =========================================================================
	// State queries
	// =========================================================================

	get model(): string {
		return this.session.model?.id ?? "";
	}

	get thinkingLevel(): ThinkingLevel {
		return this.session.thinkingLevel;
	}

	get isStreaming(): boolean {
		return this.session.isStreaming;
	}

	get isCompacting(): boolean {
		return this.session.isCompacting;
	}

	get steeringMessages(): readonly string[] {
		return this.session.getSteeringMessages();
	}

	get followUpMessages(): readonly string[] {
		return this.session.getFollowUpMessages();
	}

	get sessionFile(): string | undefined {
		return this.session.sessionFile;
	}

	get sessionName(): string | undefined {
		return this.session.sessionName;
	}

	get messages(): readonly AgentMessage[] {
		return this.session.messages;
	}

	// =========================================================================
	// Session operations
	// =========================================================================

	async compact(customInstructions?: string): Promise<void> {
		await this.session.compact(customInstructions);
	}

	setModel(modelId: string): void {
		// AgentSession.setModel() takes a Model<any> object, not a string.
		// Look up the model by ID from the model registry.
		const registry = this.session.modelRegistry;
		const available = registry.getAvailable();

		// Try "provider/modelId" format first
		const slashIndex = modelId.indexOf("/");
		let model: ReturnType<typeof available.find> | undefined;
		if (slashIndex !== -1) {
			const provider = modelId.slice(0, slashIndex);
			const id = modelId.slice(slashIndex + 1);
			model = registry.find(provider, id);
		}

		// Fallback: search by model ID alone
		if (!model) {
			model = available.find((m) => m.id === modelId);
		}

		if (!model) {
			throw new Error(`Model not found: ${modelId}`);
		}

		// AgentSession.setModel() is async but the interface declares void.
		// Fire-and-forget to satisfy the synchronous signature.
		void this.session.setModel(model);
	}

	cycleModel(direction: 1 | -1): void {
		const dir = direction === 1 ? "forward" : "backward";
		// AgentSession.cycleModel() is async but the interface declares void.
		// Fire-and-forget to satisfy the synchronous signature.
		void this.session.cycleModel(dir);
	}

	setThinkingLevel(level: ThinkingLevel): void {
		this.session.setThinkingLevel(level);
	}

	cycleThinkingLevel(direction: 1 | -1): void {
		// AgentSession.cycleThinkingLevel() takes no arguments and cycles forward.
		// Implement directional cycling manually.
		const levels = this.session.getAvailableThinkingLevels();
		if (levels.length === 0) return;

		const currentIndex = levels.indexOf(this.session.thinkingLevel);
		const len = levels.length;
		const nextIndex = direction === 1 ? (currentIndex + 1) % len : (currentIndex - 1 + len) % len;

		this.session.setThinkingLevel(levels[nextIndex]);
	}

	// =========================================================================
	// Runtime operations
	// =========================================================================

	async newSession(): Promise<void> {
		await this._runtime.newSession();
	}

	async switchSession(sessionFile: string): Promise<void> {
		await this._runtime.switchSession(sessionFile);
	}

	async fork(entryIndex?: number): Promise<void> {
		// AgentSessionRuntime.fork() takes an entryId (string), not an index.
		// Convert entry index to entry ID using the session manager.
		if (entryIndex === undefined) {
			await this._runtime.fork("");
			return;
		}

		const entries = this.session.sessionManager.getBranch();
		if (entryIndex < 0 || entryIndex >= entries.length) {
			throw new Error(`Invalid entry index for fork: ${entryIndex}`);
		}
		const entryId = entries[entryIndex].id;
		await this._runtime.fork(entryId);
	}

	// =========================================================================
	// Lifecycle
	// =========================================================================

	dispose(): void {
		// Don't dispose runtime here — the mode that created it handles that
	}

	// =========================================================================
	// Extras (not in interface)
	// =========================================================================

	/** Expose runtime for modes that need direct access (e.g., rebindSession callbacks) */
	get runtime(): AgentSessionRuntime {
		return this._runtime;
	}

	/** Snapshot for serve mode */
	getSnapshot(): SessionStateSnapshot {
		return {
			model: this.model,
			thinkingLevel: this.thinkingLevel,
			isStreaming: this.isStreaming,
			isCompacting: this.isCompacting,
			steeringMessages: this.steeringMessages,
			followUpMessages: this.followUpMessages,
			sessionFile: this.sessionFile,
			sessionName: this.sessionName,
			messages: this.messages,
			banner: this._banner,
		};
	}
}
