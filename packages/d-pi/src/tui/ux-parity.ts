export const REQUIRED_TUI_UX_PARITY_GROUPS = [
	"startup-banner",
	"input-keybindings",
	"message-rendering",
	"streaming-tools",
	"commands-selectors",
	"footer-status",
	"remote-recovery",
] as const;

export type TuiUxParityGroup = (typeof REQUIRED_TUI_UX_PARITY_GROUPS)[number];
export type TuiUxRemoteImplementation = "implemented" | "planned";
export interface TuiUxParityTestRef {
	file: string;
	case: string;
}
export type NonEmptyTestRefs = readonly [TuiUxParityTestRef, ...TuiUxParityTestRef[]];

export interface TuiUxParityItem {
	id: `${TuiUxParityGroup}:${string}`;
	group: TuiUxParityGroup;
	interactiveModeBaseline: string;
	remoteImplementation: TuiUxRemoteImplementation;
	testRefs: NonEmptyTestRefs;
}

export const TUI_UX_PARITY_MATRIX: readonly TuiUxParityItem[] = [
	{
		id: "startup-banner:banner-resources-diagnostics",
		group: "startup-banner",
		interactiveModeBaseline:
			"Startup banner shows app/version, key hints, onboarding, loaded resources, diagnostics, and changelog.",
		remoteImplementation: "implemented",
		testRefs: [
			{
				file: "test/interactive-view.test.ts",
				case: "Parity marker: startup-banner:banner-resources-diagnostics",
			},
		],
	},
	{
		id: "input-keybindings:editable-input-bindings",
		group: "input-keybindings",
		interactiveModeBaseline:
			"Prompt input supports editor keybindings, submission, cancellation, and multiline editing.",
		remoteImplementation: "implemented",
		testRefs: [
			{
				file: "test/remote-tui.test.ts",
				case: "Parity marker: input-keybindings:editable-input-bindings",
			},
		],
	},
	{
		id: "message-rendering:assistant-and-user-transcript",
		group: "message-rendering",
		interactiveModeBaseline:
			"Transcript renders user, assistant, thinking, tool, custom, and error messages with stable ordering.",
		remoteImplementation: "implemented",
		testRefs: [
			{
				file: "test/interactive-view.test.ts",
				case: "Parity marker: message-rendering:assistant-and-user-transcript",
			},
			{
				file: "test/native-ui-components.test.ts",
				case: "Parity marker: message-rendering:native-message-components",
			},
		],
	},
	{
		id: "streaming-tools:runtime-worker-event-feed",
		group: "streaming-tools",
		interactiveModeBaseline:
			"Streaming assistant deltas and tool lifecycle updates appear incrementally during a turn.",
		remoteImplementation: "implemented",
		testRefs: [
			{
				file: "test/tui-remote-client.test.ts",
				case: "SSE snapshot replaces snapshot while worker events append and notify listeners",
			},
			{ file: "test/tui-remote-client.test.ts", case: "Parity marker: streaming-tools:runtime-worker-event-feed" },
			{ file: "test/remote-tui.test.ts", case: "Parity marker: streaming-tools:runtime-worker-event-feed" },
		],
	},
	{
		id: "commands-selectors:command-and-agent-surfaces",
		group: "commands-selectors",
		interactiveModeBaseline: "Slash commands, selectors, and agent switching stay discoverable from the TUI.",
		remoteImplementation: "planned",
		testRefs: [
			{
				file: "test/remote-tui.test.ts",
				case: "Parity marker: commands-selectors:command-and-agent-surfaces",
			},
		],
	},
	{
		id: "footer-status:runtime-status-footer",
		group: "footer-status",
		interactiveModeBaseline: "Footer reflects model, cwd, approval/auth state, queues, and active runtime status.",
		remoteImplementation: "implemented",
		testRefs: [
			{ file: "test/interactive-view.test.ts", case: "Parity marker: footer-status:runtime-status-footer" },
			{ file: "test/native-ui-footer.test.ts", case: "Parity marker: footer-status:native-footer-editor" },
			{ file: "test/native-ui-status.test.ts", case: "Parity marker: footer-status:native-status-loader" },
		],
	},
	{
		id: "remote-recovery:snapshot-recovery-after-agent-switch",
		group: "remote-recovery",
		interactiveModeBaseline:
			"Interactive state recovers predictably after reconnects, runtime restarts, and agent switches.",
		remoteImplementation: "planned",
		testRefs: [
			{
				file: "test/tui-remote-client.test.ts",
				case: "setAgentName reconnects through snapshot recovery and resets transient events",
			},
			{
				file: "test/tui-remote-client.test.ts",
				case: "Parity marker: remote-recovery:snapshot-recovery-after-agent-switch",
			},
		],
	},
];
