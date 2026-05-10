import type { MessageSource } from "../hub/agent/types.js";

declare module "@earendil-works/pi-ai" {
	interface UserMessage {
		messageSource?: MessageSource;
	}
}
