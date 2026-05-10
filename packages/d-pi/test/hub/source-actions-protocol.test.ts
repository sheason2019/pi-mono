import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Socket as ClientSocket, io as ioClient } from "socket.io-client";
import { afterEach, describe, expect, it } from "vitest";
import type { HubAgentAdapter } from "../../src/hub/agent/hub-agent-adapter.js";
import { MAIN_AGENT_ID } from "../../src/hub/agents/types.js";
import { PeerRegistry } from "../../src/hub/peers/peer-registry.js";
import type { HubSessionService } from "../../src/hub/session/hub-session-service.js";
import type { HubSessionSnapshot } from "../../src/hub/session/session-snapshot.js";
import { getSourcesConfigPath } from "../../src/hub/sources/source-config.js";
import { SourceHost, type SpawnStdioSource } from "../../src/hub/sources/source-host.js";
import {
	HUB_PROTOCOL_VERSION,
	type SessionGetSourcesAck,
	type SessionMutateSourceAck,
} from "../../src/hub/transport/protocol.js";
import { createMainOnlySocketHubServer, type SocketHubServer } from "../../src/hub/transport/socket-hub-server.js";

const tempDirs: string[] = [];

function createMinimalSnapshot(): HubSessionSnapshot {
	return {
		header: {
			type: "session",
			id: "hub-test-session",
			timestamp: new Date().toISOString(),
			cwd: "/tmp",
			version: 3,
		},
		sessionFile: "/tmp/session.json",
		entries: [],
		context: { messages: [], thinkingLevel: "off", model: null },
		availableModels: [],
		availableThinkingLevels: ["off"],
		isRunning: false,
		pendingToolCallIds: [],
		diagnostics: [],
	};
}

function createStubSessionService(): HubSessionService {
	const snapshot = createMinimalSnapshot();
	return {
		subscribe: () => () => {},
		getHeader: () => snapshot.header,
		getSnapshot: () => snapshot,
		recordError: () => {},
	} as unknown as HubSessionService;
}

function writeSourcesFile(cwd: string, body: unknown): void {
	const piDir = join(cwd, ".pi");
	mkdirSync(piDir, { recursive: true });
	writeFileSync(getSourcesConfigPath(cwd), `${JSON.stringify(body, null, 2)}\n`, "utf8");
}

function createMockChild(
	overrides: Partial<ChildProcess> & { stdout?: EventEmitter; stderr?: EventEmitter } = {},
): ChildProcess {
	const stdout = overrides.stdout ?? new EventEmitter();
	const stderr = overrides.stderr ?? new EventEmitter();
	return Object.assign(new EventEmitter(), {
		pid: 42,
		stdout,
		stderr,
		kill: () => true,
		...overrides,
	}) as ChildProcess;
}

function createMockStdioSpawn(procs: ChildProcess[]): SpawnStdioSource {
	return () => {
		const p = createMockChild();
		procs.push(p);
		queueMicrotask(() => {
			p.emit("spawn");
		});
		return p;
	};
}

async function connectClient(addressBase: string): Promise<ClientSocket> {
	const client: ClientSocket = ioClient(addressBase, {
		transports: ["websocket"],
		autoConnect: true,
	});
	await new Promise<void>((resolve, reject) => {
		client.on("connect", () => resolve());
		client.on("connect_error", (err) => reject(err));
	});
	return client;
}

async function registerPeer(client: ClientSocket, peerId: string): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		client.emit(
			"peer:hello",
			{ peerId, token: "test-token", protocolVersion: HUB_PROTOCOL_VERSION },
			(helloAck: { ok: boolean; error?: string }) => {
				if (helloAck.ok) {
					resolve();
					return;
				}
				reject(new Error(helloAck.error ?? "peer:hello failed"));
			},
		);
	});
}

function createHubWithSourceHost(
	cwd: string,
	spawn: SpawnStdioSource,
): { sourceHost: SourceHost; server: SocketHubServer } {
	const sourceHost = new SourceHost({ cwd, spawnStdio: spawn });
	const sessionService = createStubSessionService();
	const registry = new PeerRegistry();
	const mockAdapter = {} as unknown as HubAgentAdapter;
	const server = createMainOnlySocketHubServer(
		sessionService,
		registry,
		() => [],
		() => mockAdapter,
		() => sourceHost.getStatuses(),
		{
			pause: (resourceId) => sourceHost.pauseSource(resourceId),
			restart: (resourceId) => sourceHost.restartSource(resourceId),
			remove: (resourceId) => sourceHost.removeSource(resourceId),
		},
	);
	return { sourceHost, server };
}

describe("session:pause_source, session:restart_source, session:remove_source", () => {
	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("unregistered socket: session:pause_source returns { ok: false, error: peer not registered }", async () => {
		const sessionService = createStubSessionService();
		const registry = new PeerRegistry();
		const mockAdapter = {} as unknown as HubAgentAdapter;
		const server = createMainOnlySocketHubServer(
			sessionService,
			registry,
			() => [],
			() => mockAdapter,
			() => [],
		);

		const address = await server.start({ host: "127.0.0.1", port: 0 });
		const client = await connectClient(`http://127.0.0.1:${address.port}`);

		const ack = await new Promise<SessionMutateSourceAck>((resolve) => {
			client.emit("session:pause_source", { name: "n1" }, (response: SessionMutateSourceAck) => resolve(response));
		});

		expect(ack).toEqual({ ok: false, error: "Peer is not registered." });
		client.close();
		await server.stop();
	});

	it("unregistered socket: session:restart_source returns { ok: false, error: peer not registered }", async () => {
		const sessionService = createStubSessionService();
		const registry = new PeerRegistry();
		const mockAdapter = {} as unknown as HubAgentAdapter;
		const server = createMainOnlySocketHubServer(
			sessionService,
			registry,
			() => [],
			() => mockAdapter,
			() => [],
		);

		const address = await server.start({ host: "127.0.0.1", port: 0 });
		const client = await connectClient(`http://127.0.0.1:${address.port}`);

		const ack = await new Promise<SessionMutateSourceAck>((resolve) => {
			client.emit("session:restart_source", { name: "n1" }, (response: SessionMutateSourceAck) => resolve(response));
		});

		expect(ack).toEqual({ ok: false, error: "Peer is not registered." });
		client.close();
		await server.stop();
	});

	it("unregistered socket: session:remove_source returns { ok: false, error: peer not registered }", async () => {
		const sessionService = createStubSessionService();
		const registry = new PeerRegistry();
		const mockAdapter = {} as unknown as HubAgentAdapter;
		const server = createMainOnlySocketHubServer(
			sessionService,
			registry,
			() => [],
			() => mockAdapter,
			() => [],
		);

		const address = await server.start({ host: "127.0.0.1", port: 0 });
		const client = await connectClient(`http://127.0.0.1:${address.port}`);

		const ack = await new Promise<SessionMutateSourceAck>((resolve) => {
			client.emit("session:remove_source", { name: "n1" }, (response: SessionMutateSourceAck) => resolve(response));
		});

		expect(ack).toEqual({ ok: false, error: "Peer is not registered." });
		client.close();
		await server.stop();
	});

	it("registered peer: pause then get_sources reflects stopped", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-hub-src-pause-"));
		tempDirs.push(cwd);
		writeSourcesFile(cwd, {
			sources: [
				{ resourceId: "src-s1", name: "s1", transport: "stdio", command: "noop" },
				{ resourceId: "src-s2", name: "s2", transport: "stdio", command: "noop" },
			],
		});

		const procs: ChildProcess[] = [];
		const { sourceHost, server } = createHubWithSourceHost(cwd, createMockStdioSpawn(procs));
		await sourceHost.start();
		await new Promise<void>((r) => setImmediate(r));

		const address = await server.start({ host: "127.0.0.1", port: 0 });
		const client = await connectClient(`http://127.0.0.1:${address.port}`);
		await registerPeer(client, "peer-pause");

		const pauseAck = await new Promise<SessionMutateSourceAck>((resolve) => {
			client.emit("session:pause_source", { resourceId: "src-s1" }, (r: SessionMutateSourceAck) => resolve(r));
		});
		expect(pauseAck.ok).toBe(true);
		if (pauseAck.ok) {
			expect(pauseAck.sources).toHaveLength(2);
			expect(pauseAck.sources.find((s) => s.name === "s1")).toEqual({
				resourceId: "src-s1",
				name: "s1",
				transport: "stdio",
				agentId: MAIN_AGENT_ID,
				origin: "hub",
				status: "stopped",
			});
			expect(pauseAck.sources.find((s) => s.name === "s2")).toEqual({
				resourceId: "src-s2",
				name: "s2",
				transport: "stdio",
				agentId: MAIN_AGENT_ID,
				origin: "hub",
				status: "running",
			});
		}

		const getAck = await new Promise<SessionGetSourcesAck>((resolve) => {
			client.emit("session:get_sources", {}, (r: SessionGetSourcesAck) => resolve(r));
		});
		expect(getAck).toEqual(pauseAck);

		client.close();
		await server.stop();
	});

	it("registered peer: restart then get_sources reflects running (source starts paused)", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-hub-src-restart-"));
		tempDirs.push(cwd);
		writeSourcesFile(cwd, {
			sources: [
				{ resourceId: "src-s1", name: "s1", transport: "stdio", command: "noop", disabled: true },
				{ resourceId: "src-s2", name: "s2", transport: "stdio", command: "noop" },
			],
		});

		const procs: ChildProcess[] = [];
		const { sourceHost, server } = createHubWithSourceHost(cwd, createMockStdioSpawn(procs));
		await sourceHost.start();
		await new Promise<void>((r) => setImmediate(r));
		expect(sourceHost.getStatuses().find((s) => s.name === "s1")?.status).toBe("stopped");
		expect(procs).toHaveLength(1);

		const address = await server.start({ host: "127.0.0.1", port: 0 });
		const client = await connectClient(`http://127.0.0.1:${address.port}`);
		await registerPeer(client, "peer-restart");

		const restartAck = await new Promise<SessionMutateSourceAck>((resolve) => {
			client.emit("session:restart_source", { resourceId: "src-s1" }, (r: SessionMutateSourceAck) => resolve(r));
		});
		expect(restartAck.ok).toBe(true);
		if (restartAck.ok) {
			expect(restartAck.sources.find((s) => s.name === "s1")?.status).toBe("running");
		}
		expect(procs).toHaveLength(2);

		const getAck = await new Promise<SessionGetSourcesAck>((resolve) => {
			client.emit("session:get_sources", {}, (r: SessionGetSourcesAck) => resolve(r));
		});
		expect(getAck).toEqual(restartAck);

		client.close();
		await server.stop();
	});

	it("registered peer: remove then get_sources omits the source", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-hub-src-remove-"));
		tempDirs.push(cwd);
		writeSourcesFile(cwd, {
			sources: [
				{ resourceId: "src-s1", name: "s1", transport: "stdio", command: "noop" },
				{ resourceId: "src-s2", name: "s2", transport: "stdio", command: "noop" },
			],
		});

		const procs: ChildProcess[] = [];
		const { sourceHost, server } = createHubWithSourceHost(cwd, createMockStdioSpawn(procs));
		await sourceHost.start();
		await new Promise<void>((r) => setImmediate(r));

		const address = await server.start({ host: "127.0.0.1", port: 0 });
		const client = await connectClient(`http://127.0.0.1:${address.port}`);
		await registerPeer(client, "peer-remove");

		const removeAck = await new Promise<SessionMutateSourceAck>((resolve) => {
			client.emit("session:remove_source", { resourceId: "src-s1" }, (r: SessionMutateSourceAck) => resolve(r));
		});
		expect(removeAck.ok).toBe(true);
		if (removeAck.ok) {
			expect(removeAck.sources).toEqual([
				{
					resourceId: "src-s2",
					name: "s2",
					transport: "stdio",
					agentId: MAIN_AGENT_ID,
					origin: "hub",
					status: "running",
				},
			]);
		}
		const saved = JSON.parse(readFileSync(getSourcesConfigPath(cwd), "utf8")) as {
			sources: Array<{ name: string }>;
		};
		expect(saved.sources.map((source) => source.name)).toEqual(["s2"]);

		const getAck = await new Promise<SessionGetSourcesAck>((resolve) => {
			client.emit("session:get_sources", {}, (r: SessionGetSourcesAck) => resolve(r));
		});
		expect(getAck).toEqual(removeAck);

		client.close();
		await server.stop();
	});

	it("unknown name: pause, restart, and remove all return SourceHost error", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-hub-src-unknown-"));
		tempDirs.push(cwd);
		writeSourcesFile(cwd, {
			sources: [
				{ resourceId: "src-s1", name: "s1", transport: "stdio", command: "noop" },
				{ resourceId: "src-s2", name: "s2", transport: "stdio", command: "noop" },
			],
		});

		const procs: ChildProcess[] = [];
		const { sourceHost, server } = createHubWithSourceHost(cwd, createMockStdioSpawn(procs));
		await sourceHost.start();
		await new Promise<void>((r) => setImmediate(r));

		const address = await server.start({ host: "127.0.0.1", port: 0 });
		const client = await connectClient(`http://127.0.0.1:${address.port}`);
		await registerPeer(client, "peer-unknown");

		const notFound = /not found/;

		const pauseBad = await new Promise<SessionMutateSourceAck>((resolve) => {
			client.emit("session:pause_source", { resourceId: "nope" }, (r: SessionMutateSourceAck) => resolve(r));
		});
		expect(pauseBad.ok).toBe(false);
		if (!pauseBad.ok) {
			expect(pauseBad.error).toMatch(notFound);
		}

		const restartBad = await new Promise<SessionMutateSourceAck>((resolve) => {
			client.emit("session:restart_source", { resourceId: "nope" }, (r: SessionMutateSourceAck) => resolve(r));
		});
		expect(restartBad.ok).toBe(false);
		if (!restartBad.ok) {
			expect(restartBad.error).toMatch(notFound);
		}

		const removeBad = await new Promise<SessionMutateSourceAck>((resolve) => {
			client.emit("session:remove_source", { resourceId: "nope" }, (r: SessionMutateSourceAck) => resolve(r));
		});
		expect(removeBad.ok).toBe(false);
		if (!removeBad.ok) {
			expect(removeBad.error).toMatch(notFound);
		}

		client.close();
		await server.stop();
	});
});
