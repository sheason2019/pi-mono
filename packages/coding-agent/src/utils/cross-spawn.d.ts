declare module "cross-spawn" {
	import type { ChildProcess, SpawnOptions, SpawnSyncOptions, SpawnSyncReturns } from "node:child_process";

	interface CrossSpawn {
		(command: string, args: string[], options: SpawnOptions): ChildProcess;
		(command: string, options: SpawnOptions): ChildProcess;
		sync(command: string, args: string[], options: SpawnSyncOptions): SpawnSyncReturns<string>;
	}

	const crossSpawn: CrossSpawn;
	export = crossSpawn;
}
