import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	formatToolCallArguments,
	getToolCallOutputText,
	getToolCallStatus,
	getToolCallStatusView,
	getToolCommandPreview,
} from "../src/tool-call-view.js";

function createToolResult(overrides: Partial<ToolResultMessage<unknown>> = {}): ToolResultMessage<unknown> {
	return {
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "bash",
		content: [{ type: "text", text: "done" }],
		isError: false,
		timestamp: 1,
		...overrides,
	};
}

describe("d-pi tool call view helpers", () => {
	it("maps tool call execution states to DaisyUI badge metadata", () => {
		expect(getToolCallStatus({ pending: true })).toBe("pending");
		expect(getToolCallStatus({ result: createToolResult() })).toBe("success");
		expect(getToolCallStatus({ result: createToolResult({ isError: true }) })).toBe("error");
		expect(getToolCallStatus({ aborted: true, result: createToolResult() })).toBe("aborted");

		expect(getToolCallStatusView("pending")).toEqual({
			label: "Running",
			badgeClass:
				"inline-flex items-center gap-1 rounded-full border border-info/25 bg-info/10 px-2 py-0.5 text-xs font-medium text-info",
		});
		expect(getToolCallStatusView("success")).toEqual({
			label: "Done",
			badgeClass:
				"inline-flex items-center gap-1 rounded-full border border-success/25 bg-success/10 px-2 py-0.5 text-xs font-medium text-success",
		});
		expect(getToolCallStatusView("error")).toEqual({
			label: "Error",
			badgeClass:
				"inline-flex items-center gap-1 rounded-full border border-error/25 bg-error/10 px-2 py-0.5 text-xs font-medium text-error",
		});
		expect(getToolCallStatusView("aborted")).toEqual({
			label: "Aborted",
			badgeClass:
				"inline-flex items-center gap-1 rounded-full border border-warning/25 bg-warning/10 px-2 py-0.5 text-xs font-medium text-warning",
		});
	});

	it("extracts bash command previews and text output for compact cards", () => {
		expect(getToolCommandPreview("bash", { command: "npm run check", timeout: 30 })).toBe("npm run check");
		expect(getToolCommandPreview("read_file", { path: "src/index.ts" })).toBeUndefined();
		expect(getToolCallOutputText(createToolResult())).toBe("done");
	});

	it("formats call arguments as stable pretty JSON", () => {
		expect(formatToolCallArguments({ command: "pwd", timeout: 5 })).toBe('{\n  "command": "pwd",\n  "timeout": 5\n}');
		expect(formatToolCallArguments(undefined)).toBe("{}");
	});
});
