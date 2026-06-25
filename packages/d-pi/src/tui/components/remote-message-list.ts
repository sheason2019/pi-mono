import type { DPiJsonValue, DPiServiceEvent, DPiServiceSnapshot } from "../../service/protocol.ts";

export type DPiRemoteMessageRole = "user" | "assistant" | "custom" | "tool" | "worker" | "runtime" | "unknown";

export interface DPiRemoteMessageView {
	id: string;
	role: DPiRemoteMessageRole;
	label: string;
	content: string;
	metadata: readonly string[];
}

export interface DPiRemoteMessageListViewModel {
	items: readonly DPiRemoteMessageView[];
	text: string;
}

export interface BuildRemoteMessageListViewOptions {
	snapshot?: DPiServiceSnapshot;
	events?: readonly DPiServiceEvent[];
	emptyText?: string;
}

export function buildRemoteMessageListView(options: BuildRemoteMessageListViewOptions): DPiRemoteMessageListViewModel {
	const items = [
		...messagesFromSnapshot(options.snapshot),
		...(options.events ?? []).flatMap((event, index) => {
			const message = messageFromEvent(event, index);
			return message ? [message] : [];
		}),
	];
	const text =
		items.length === 0 ? (options.emptyText ?? "No remote messages yet.") : items.map(formatMessage).join("\n");
	return { items, text };
}

function messagesFromSnapshot(snapshot: DPiServiceSnapshot | undefined): DPiRemoteMessageView[] {
	if (!snapshot) {
		return [];
	}
	const state = asRecord(snapshot.state);
	const messages = asArray(state?.messages);
	if (!messages) {
		return [];
	}
	return messages.map((message, index) => messageFromSnapshotEntry(message, index));
}

function messageFromSnapshotEntry(value: DPiJsonValue, index: number): DPiRemoteMessageView {
	const record = asRecord(value);
	if (!record) {
		return {
			id: `snapshot-message-${index}`,
			role: "unknown",
			label: "unknown",
			content: stringifyJson(value),
			metadata: [],
		};
	}
	const id = stringField(record, "id") ?? `snapshot-message-${index}`;
	const role = remoteRole(record);
	const source = sourceLabel(record);
	const tool = toolLabel(record);
	const label = labelForRole(role, source ?? tool);
	return {
		id,
		role,
		label,
		content: contentText(record),
		metadata: metadataFor(record, source, tool),
	};
}

function messageFromEvent(event: DPiServiceEvent, index: number): DPiRemoteMessageView | undefined {
	if (event.type === "snapshot") {
		return undefined;
	}
	if (event.type === "worker" && event.event === "state") {
		return undefined;
	}
	const content = eventDataText(event.data);
	return {
		id: `${event.type}-${index}`,
		role: event.type,
		label: `${event.type}.${event.event}`,
		content,
		metadata: event.data === undefined ? [] : [`data=${stringifyJson(event.data)}`],
	};
}

function formatMessage(item: DPiRemoteMessageView): string {
	return `${item.label}: ${item.content}`;
}

function remoteRole(record: Record<string, DPiJsonValue>): DPiRemoteMessageRole {
	const explicitRole = stringField(record, "role");
	if (explicitRole === "user" || explicitRole === "assistant" || explicitRole === "custom") {
		return explicitRole;
	}
	const type = stringField(record, "type") ?? "";
	if (
		explicitRole === "tool" ||
		explicitRole === "tool_call" ||
		explicitRole === "tool_result" ||
		type.includes("tool")
	) {
		return "tool";
	}
	return "unknown";
}

function labelForRole(role: DPiRemoteMessageRole, qualifier: string | undefined): string {
	if (!qualifier) {
		return role;
	}
	return `${role}[${qualifier}]`;
}

function sourceLabel(record: Record<string, DPiJsonValue>): string | undefined {
	return (
		stringField(record, "sourceName") ??
		stringField(record, "source") ??
		stringField(asRecord(record.details), "sourceName")
	);
}

function toolLabel(record: Record<string, DPiJsonValue>): string | undefined {
	return stringField(record, "toolName") ?? stringField(record, "name") ?? stringField(record, "tool");
}

function metadataFor(
	record: Record<string, DPiJsonValue>,
	source: string | undefined,
	tool: string | undefined,
): string[] {
	const metadata: string[] = [];
	if (source) {
		metadata.push(`source=${source}`);
	}
	if (tool) {
		metadata.push(`tool=${tool}`);
	}
	const customType = stringField(record, "customType");
	if (customType) {
		metadata.push(`customType=${customType}`);
	}
	return metadata;
}

function contentText(record: Record<string, DPiJsonValue>): string {
	const content = record.content ?? record.text ?? record.message ?? record.result ?? record.error;
	if (content === undefined) {
		return stringifyJson(record);
	}
	return jsonText(content);
}

function eventDataText(value: DPiJsonValue | undefined): string {
	if (value === undefined) {
		return "";
	}
	const record = asRecord(value);
	if (record) {
		return jsonText(record.text ?? record.content ?? record.message ?? value);
	}
	return jsonText(value);
}

function jsonText(value: DPiJsonValue): string {
	return typeof value === "string" ? value : stringifyJson(value);
}

function stringifyJson(value: DPiJsonValue): string {
	return JSON.stringify(value);
}

function stringField(record: Record<string, DPiJsonValue> | undefined, key: string): string | undefined {
	const value = record?.[key];
	return typeof value === "string" ? value : undefined;
}

function asRecord(value: DPiJsonValue | undefined): Record<string, DPiJsonValue> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
}

function asArray(value: DPiJsonValue | undefined): DPiJsonValue[] | undefined {
	return Array.isArray(value) ? value : undefined;
}
