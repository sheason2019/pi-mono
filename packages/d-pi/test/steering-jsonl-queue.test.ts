import { mkdtempSync, rmSync } from "node:fs";
import { appendFile, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	appendSteeringMessage,
	clearSteeringMessages,
	consumeSteeringMessages,
	readSteeringMessages,
	replaceSteeringMessages,
	type SteeringQueueRecord,
} from "../src/runtime/steering-jsonl-queue.ts";

let tempDir: string | undefined;

function createTempQueuePath(): string {
	tempDir = mkdtempSync(join(tmpdir(), "d-pi-steering-jsonl-"));
	return join(tempDir, "agent", "steering.jsonl");
}

afterEach(() => {
	if (tempDir) {
		rmSync(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	}
});

describe("steering JSONL FIFO queue", () => {
	it("appends and reads pending messages in FIFO order", async () => {
		const queuePath = createTempQueuePath();

		await appendSteeringMessage(queuePath, { text: "first", source: "connect" });
		await appendSteeringMessage(queuePath, {
			text: "second",
			source: "runtime",
			images: [{ url: "file:///tmp/image.png", mediaType: "image/png" }],
		});

		expect(await readSteeringMessages(queuePath)).toEqual([
			expect.objectContaining({ version: 1, text: "first", source: "connect" }),
			expect.objectContaining({
				version: 1,
				text: "second",
				source: "runtime",
				images: [{ url: "file:///tmp/image.png", mediaType: "image/png" }],
			}),
		]);
	});

	it("consumes pending messages by reading them and clearing the file", async () => {
		const queuePath = createTempQueuePath();
		await appendSteeringMessage(queuePath, { text: "first", source: "connect" });
		await appendSteeringMessage(queuePath, { text: "second", source: "connect" });

		const consumed = await consumeSteeringMessages(queuePath);

		expect(consumed.map((message) => message.text)).toEqual(["first", "second"]);
		expect(await readSteeringMessages(queuePath)).toEqual([]);
		await expect(stat(queuePath)).resolves.toMatchObject({ size: 0 });
	});

	it("replaces the queue file for alt-up editing", async () => {
		const queuePath = createTempQueuePath();
		await appendSteeringMessage(queuePath, { text: "original", source: "connect" });

		const editingSource = await consumeSteeringMessages(queuePath);
		await replaceSteeringMessages(queuePath, [
			{
				...editingSource[0]!,
				text: "edited",
			},
		]);

		expect(await readSteeringMessages(queuePath)).toEqual([expect.objectContaining({ text: "edited" })]);
		expect(await readFile(queuePath, "utf8")).toMatch(/"edited"/);
		expect(await readFile(queuePath, "utf8")).not.toMatch(/"original"/);
	});

	it("clears the queue without creating a provider-visible log", async () => {
		const queuePath = createTempQueuePath();
		await appendSteeringMessage(queuePath, { text: "interrupt", source: "connect" });

		await clearSteeringMessages(queuePath);

		expect(await readSteeringMessages(queuePath)).toEqual([]);
		expect(await readFile(queuePath, "utf8")).toBe("");
	});

	it("serializes writes so concurrent producers keep valid JSONL", async () => {
		const queuePath = createTempQueuePath();
		await Promise.all(
			Array.from({ length: 20 }, (_, index) =>
				appendSteeringMessage(queuePath, { text: `message-${index}`, source: "connect" }),
			),
		);

		const messages = await readSteeringMessages(queuePath);
		expect(messages).toHaveLength(20);
		expect(messages.map((message) => message.text).sort()).toEqual(
			Array.from({ length: 20 }, (_, index) => `message-${index}`).sort(),
		);
	});

	it("does not keep invalid JSONL lines as pending queue messages", async () => {
		const queuePath = createTempQueuePath();
		await replaceSteeringMessages(queuePath, [
			{ version: 1, id: "valid", text: "valid", createdAt: 1, source: "connect" } satisfies SteeringQueueRecord,
		]);
		await appendFile(queuePath, "not json\n");

		expect(await readSteeringMessages(queuePath)).toEqual([expect.objectContaining({ text: "valid" })]);
	});
});
