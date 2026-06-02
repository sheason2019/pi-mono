import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createDPiExtension } from "./index.ts";

export default function server(): void {
	// Server-side behavior is registered by d-pi's built-in worker extension.
}

export function client(pi: ExtensionAPI): void {
	const hubUrl = process.env.DPI_HUB_URL;
	if (!hubUrl) {
		throw new Error("DPI_HUB_URL is required for d-pi client extension");
	}
	createDPiExtension({
		mode: "client",
		hubUrl,
		currentAgentId: process.env.DPI_CURRENT_AGENT_ID,
	}).factory(pi);
}
