import { createPrivateKey, sign } from "node:crypto";
import type { LocalUser } from "./local-users.ts";

export function signChallenge(user: LocalUser, challenge: string): string {
	const privateKey = createPrivateKey({
		key: Buffer.from(user.privateKey, "base64url"),
		format: "der",
		type: "pkcs8",
	});
	return sign(null, Buffer.from(challenge), privateKey).toString("base64url");
}
