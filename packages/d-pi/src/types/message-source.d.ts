import type { MessageSource } from "../hub/agent/types.js";

declare module "@sheason/pi-ai" {
	interface UserMessage {
		messageSource?: MessageSource;
	}
}
