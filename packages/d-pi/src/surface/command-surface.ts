export interface DPiCommandContext {
	raw: string;
	args: string[];
	cwd?: string;
	metadata?: { [key: string]: unknown };
}

export interface DPiCommand<TAction = unknown> {
	name: string;
	description?: string;
	aliases?: string[];
	execute: (context: DPiCommandContext) => Promise<TAction> | TAction;
}

export function defineDPiCommand<TAction>(command: DPiCommand<TAction>): DPiCommand<TAction> {
	return command;
}
