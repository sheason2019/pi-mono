export type DPiMessageJsonValue =
	| null
	| boolean
	| number
	| string
	| DPiMessageJsonValue[]
	| { [key: string]: DPiMessageJsonValue };

export type DPiMessageSourceType = "connect" | "agent" | "source" | "runtime";

export interface DPiMessageMetadata {
	[key: string]: DPiMessageJsonValue;
}

export interface DPiMessageAuthMetadata {
	name?: string;
	description?: string;
	userId?: string;
	openId?: string;
	roles?: string[];
}

export interface DPiSurfaceMessageDetails {
	sourceType: DPiMessageSourceType;
	agentName?: string;
	sourceName?: string;
	connectId?: string;
	auth?: DPiMessageAuthMetadata;
	metadata?: DPiMessageMetadata;
}

export interface DPiSurfaceCustomMessage {
	role: "custom";
	customType: "d-pi-message" | (string & {});
	content: DPiMessageJsonValue;
	display?: boolean;
	details: DPiSurfaceMessageDetails;
	timestamp?: number;
}

export interface CreateDPiSurfaceMessageOptions {
	content: DPiMessageJsonValue;
	sourceType: DPiMessageSourceType;
	agentName?: string;
	sourceName?: string;
	connectId?: string;
	auth?: DPiMessageAuthMetadata;
	metadata?: DPiMessageMetadata;
	display?: boolean;
	timestamp?: number;
	customType?: DPiSurfaceCustomMessage["customType"];
}

export interface DPiMessageEnvelope {
	type: "d-pi/custom-message";
	message: DPiSurfaceCustomMessage;
}

export function createDPiSurfaceMessage(options: CreateDPiSurfaceMessageOptions): DPiSurfaceCustomMessage {
	return {
		role: "custom",
		customType: options.customType ?? "d-pi-message",
		content: options.content,
		display: options.display,
		details: {
			sourceType: options.sourceType,
			agentName: options.agentName,
			sourceName: options.sourceName,
			connectId: options.connectId,
			auth: options.auth,
			metadata: options.metadata,
		},
		timestamp: options.timestamp,
	};
}

export function createDPiMessageEnvelope(message: DPiSurfaceCustomMessage): DPiMessageEnvelope {
	return {
		type: "d-pi/custom-message",
		message,
	};
}
