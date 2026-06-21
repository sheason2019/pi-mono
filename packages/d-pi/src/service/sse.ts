import type { ServerResponse } from "node:http";
import type { DPiServiceEvent } from "./protocol.ts";

export function dPiServiceEventName(event: DPiServiceEvent): "snapshot" | "runtime" | "worker" {
	return event.type;
}

export function formatSseEvent(eventName: string, data: unknown): string {
	return `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function writeServiceSseEvent(res: ServerResponse, event: DPiServiceEvent): void {
	res.write(formatSseEvent(dPiServiceEventName(event), event));
}

export function writeSseComment(res: ServerResponse, comment: string): void {
	res.write(`: ${comment}\n\n`);
}
