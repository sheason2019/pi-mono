import type { ChildProcess } from "node:child_process";

const DETACHED_CHILD_PROCESS: unique symbol = Symbol("d-pi.detachedChildProcess");

type MarkedDetachedChildProcess = {
	[DETACHED_CHILD_PROCESS]?: true;
};

type ChildProcessTreeHandle = Pick<ChildProcess, "exitCode" | "kill" | "pid" | "signalCode">;

export const CHILD_PROCESS_TERMINATE_GRACE_MS = 2_000;

function isNodeErrnoException(error: unknown): error is NodeJS.ErrnoException {
	return typeof error === "object" && error !== null && "code" in error;
}

function isProcessStillRunning(child: ChildProcessTreeHandle): boolean {
	return child.exitCode == null && child.signalCode == null;
}

function isDetachedChildProcess(child: ChildProcessTreeHandle): boolean {
	return (child as ChildProcessTreeHandle & MarkedDetachedChildProcess)[DETACHED_CHILD_PROCESS] === true;
}

export function markDetachedChildProcess<T extends ChildProcess>(child: T): T {
	Object.defineProperty(child, DETACHED_CHILD_PROCESS, {
		value: true,
		configurable: false,
		enumerable: false,
		writable: false,
	});
	return child;
}

export function signalChildProcessTree(child: ChildProcessTreeHandle, signal: NodeJS.Signals): void {
	if (process.platform !== "win32" && isDetachedChildProcess(child) && typeof child.pid === "number") {
		try {
			process.kill(-child.pid, signal);
			return;
		} catch (error) {
			if (!isNodeErrnoException(error) || error.code !== "ESRCH") {
				return;
			}
		}
	}
	try {
		child.kill(signal);
	} catch {
		// Best-effort process cleanup.
	}
}

export function terminateChildProcessTree(
	child: ChildProcessTreeHandle,
	options: {
		signal?: NodeJS.Signals;
		killSignal?: NodeJS.Signals;
		graceMs?: number;
	} = {},
): void {
	const signal = options.signal ?? "SIGTERM";
	const killSignal = options.killSignal ?? "SIGKILL";
	const graceMs = options.graceMs ?? CHILD_PROCESS_TERMINATE_GRACE_MS;
	signalChildProcessTree(child, signal);
	const timer = setTimeout(() => {
		if (isProcessStillRunning(child) || isDetachedChildProcess(child)) {
			signalChildProcessTree(child, killSignal);
		}
	}, graceMs);
	timer.unref?.();
}
