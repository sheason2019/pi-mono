import { type Static, type TSchema, Type } from "typebox";

export const PEER_ID_FIELD = "peer-id";

export const peerRouteSchema = Type.Object({
	[PEER_ID_FIELD]: Type.String({
		description: 'Executor id. Use "host" for pi-hub or peer-id from group.',
	}),
});

export type PeerRouteInput = Static<typeof peerRouteSchema>;

type JsonObjectToolSchema = TSchema & {
	type?: string;
	properties?: Record<string, unknown>;
	required?: string[];
	allOf?: unknown;
};

export function createPeerToolSchema<TParams extends TSchema>(baseSchema: TParams): TSchema {
	const { allOf: _allOf, ...base } = baseSchema as JsonObjectToolSchema;
	const route = peerRouteSchema as JsonObjectToolSchema;
	return Type.Unsafe<Static<TParams> & PeerRouteInput>({
		...base,
		type: "object",
		properties: {
			...(base.properties ?? {}),
			...(route.properties ?? {}),
		},
		required: [...new Set([...(base.required ?? []), ...(route.required ?? [])])],
	});
}

export function preparePeerToolArguments<TPrepared extends Record<string, unknown>>(
	args: unknown,
	basePrepareArguments?: (args: unknown) => TPrepared,
): TPrepared & PeerRouteInput {
	if (!args || typeof args !== "object") {
		return args as TPrepared & PeerRouteInput;
	}

	const rawArgs = args as Record<string, unknown>;
	const preparedArgs = basePrepareArguments ? basePrepareArguments(args) : (rawArgs as TPrepared);
	return {
		...preparedArgs,
		[PEER_ID_FIELD]: rawArgs[PEER_ID_FIELD] as string,
	};
}

export function splitPeerToolArguments<TArgs extends PeerRouteInput & Record<string, unknown>>(
	args: TArgs,
): {
	peerId: string;
	toolArgs: Omit<TArgs, typeof PEER_ID_FIELD>;
} {
	const { [PEER_ID_FIELD]: peerId, ...toolArgs } = args;
	return {
		peerId,
		toolArgs,
	};
}
