import { mkdirSync, readFileSync, truncateSync, writeFileSync } from "node:fs";
import { appendFile, mkdir, readFile, truncate, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

export type SteeringQueueSource = "agent" | "connect" | "runtime";

export interface SteeringQueueImage {
	url: string;
	mediaType?: string;
}

export interface SteeringQueueRecord {
	version: 1;
	id: string;
	text: string;
	createdAt: number;
	source: SteeringQueueSource;
	images?: SteeringQueueImage[];
}

export interface SteeringQueueMessageInput {
	text: string;
	source: SteeringQueueSource;
	images?: SteeringQueueImage[];
	id?: string;
	createdAt?: number;
}

const queueLocks = new Map<string, Promise<unknown>>();
let generatedQueueId = 0;

export async function appendSteeringMessage(
	queuePath: string,
	message: SteeringQueueMessageInput,
): Promise<SteeringQueueRecord> {
	return withQueueLock(queuePath, async () => {
		await mkdir(dirname(queuePath), { recursive: true });
		const record = toRecord(message);
		await appendFile(queuePath, `${JSON.stringify(record)}\n`);
		return record;
	});
}

export async function readSteeringMessages(queuePath: string): Promise<SteeringQueueRecord[]> {
	return withQueueLock(queuePath, async () => readSteeringMessagesUnlocked(queuePath));
}

export async function consumeSteeringMessages(queuePath: string): Promise<SteeringQueueRecord[]> {
	return withQueueLock(queuePath, async () => {
		const messages = await readSteeringMessagesUnlocked(queuePath);
		await clearSteeringMessagesUnlocked(queuePath);
		return messages;
	});
}

export async function replaceSteeringMessages(
	queuePath: string,
	messages: readonly SteeringQueueRecord[],
): Promise<void> {
	return withQueueLock(queuePath, async () => {
		await mkdir(dirname(queuePath), { recursive: true });
		const content = messages.map((message) => JSON.stringify(normalizeRecord(message))).join("\n");
		await writeFile(queuePath, content ? `${content}\n` : "");
	});
}

export async function clearSteeringMessages(queuePath: string): Promise<void> {
	return withQueueLock(queuePath, async () => clearSteeringMessagesUnlocked(queuePath));
}

export function readSteeringMessagesSync(queuePath: string): SteeringQueueRecord[] {
	let content: string;
	try {
		content = readFileSync(queuePath, "utf8");
	} catch (error) {
		if (isNotFoundError(error)) {
			return [];
		}
		throw error;
	}
	return parseRecords(content);
}

export function clearSteeringMessagesSync(queuePath: string): void {
	mkdirSync(dirname(queuePath), { recursive: true });
	try {
		truncateSync(queuePath, 0);
	} catch (error) {
		if (isNotFoundError(error)) {
			writeFileSync(queuePath, "");
			return;
		}
		throw error;
	}
}

async function readSteeringMessagesUnlocked(queuePath: string): Promise<SteeringQueueRecord[]> {
	let content: string;
	try {
		content = await readFile(queuePath, "utf8");
	} catch (error) {
		if (isNotFoundError(error)) {
			return [];
		}
		throw error;
	}
	return parseRecords(content);
}

async function clearSteeringMessagesUnlocked(queuePath: string): Promise<void> {
	await mkdir(dirname(queuePath), { recursive: true });
	try {
		await truncate(queuePath, 0);
	} catch (error) {
		if (isNotFoundError(error)) {
			await writeFile(queuePath, "");
			return;
		}
		throw error;
	}
}

function toRecord(message: SteeringQueueMessageInput): SteeringQueueRecord {
	return normalizeRecord({
		version: 1,
		id: message.id ?? `steering-${Date.now()}-${generatedQueueId++}`,
		text: message.text,
		createdAt: message.createdAt ?? Date.now(),
		source: message.source,
		...(message.images ? { images: message.images } : {}),
	});
}

function normalizeRecord(record: SteeringQueueRecord): SteeringQueueRecord {
	return {
		version: 1,
		id: record.id,
		text: record.text,
		createdAt: record.createdAt,
		source: record.source,
		...(record.images ? { images: record.images.map((image) => ({ ...image })) } : {}),
	};
}

const steeringQueueImageSchema = z.object({
	url: z.string(),
	mediaType: z.string().optional(),
});

const steeringQueueRecordSchema = z.object({
	version: z.literal(1),
	id: z.string(),
	text: z.string(),
	createdAt: z.number(),
	source: z.enum(["agent", "connect", "runtime"]),
	images: z.array(steeringQueueImageSchema).optional(),
});

function parseRecords(content: string): SteeringQueueRecord[] {
	return content.split("\n").flatMap((line) => {
		const trimmed = line.trim();
		if (!trimmed) {
			return [];
		}
		return parseRecord(trimmed);
	});
}

function parseRecord(line: string): SteeringQueueRecord[] {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		return [];
	}
	const parsed = steeringQueueRecordSchema.safeParse(value);
	if (!parsed.success) {
		return [];
	}
	return [parsed.data];
}

function withQueueLock<T>(queuePath: string, operation: () => Promise<T>): Promise<T> {
	const previous = queueLocks.get(queuePath) ?? Promise.resolve();
	const next = previous.then(operation, operation);
	queueLocks.set(
		queuePath,
		next.finally(() => {
			if (queueLocks.get(queuePath) === next) {
				queueLocks.delete(queuePath);
			}
		}),
	);
	return next;
}

function isNotFoundError(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
