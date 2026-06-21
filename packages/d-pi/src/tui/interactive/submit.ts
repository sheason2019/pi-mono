import type { DPiInteractiveAgentSessionProxy } from "./agent-session-proxy.ts";

export async function submitDPiInteractiveEditorText(
	proxy: Pick<DPiInteractiveAgentSessionProxy, "isStreaming" | "prompt" | "steer">,
	text: string,
	onError: (error: unknown) => void,
): Promise<void> {
	const trimmed = text.trim();
	if (!trimmed) {
		return;
	}
	try {
		if (proxy.isStreaming) {
			proxy.steer(trimmed);
		} else {
			await proxy.prompt(trimmed);
		}
	} catch (error) {
		onError(error);
	}
}
