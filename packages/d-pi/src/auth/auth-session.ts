import { createPublicKey, randomBytes, verify } from "node:crypto";
import { findAllowedUserByPublicKey } from "./allowed-users.ts";

export interface AuthIdentity {
	name: string;
	description: string;
}

export interface AuthSessionInfo {
	publicKey: string;
	auth: AuthIdentity;
}

interface ChallengeInfo {
	publicKey: string;
	challenge: string;
}

export class AuthSessionManager {
	private readonly _workspaceRoot: string;
	private readonly _challenges = new Map<string, ChallengeInfo>();
	private readonly _sessions = new Map<string, AuthSessionInfo>();

	constructor(workspaceRoot: string) {
		this._workspaceRoot = workspaceRoot;
	}

	createChallenge(publicKey: string): { challengeId: string; challenge: string } {
		const allowedUser = findAllowedUserByPublicKey(this._workspaceRoot, publicKey);
		if (!allowedUser || allowedUser.disabled) {
			throw new Error("Public key is not allowed");
		}
		const challengeId = randomBytes(18).toString("base64url");
		const challenge = randomBytes(32).toString("base64url");
		this._challenges.set(challengeId, { publicKey, challenge });
		return { challengeId, challenge };
	}

	createSession(options: { publicKey: string; challengeId: string; signature: string }): {
		token: string;
		auth: AuthIdentity;
	} {
		const challenge = this._challenges.get(options.challengeId);
		if (!challenge || challenge.publicKey !== options.publicKey) {
			throw new Error("Invalid challenge");
		}
		const allowedUser = findAllowedUserByPublicKey(this._workspaceRoot, options.publicKey);
		if (!allowedUser || allowedUser.disabled) {
			throw new Error("Public key is not allowed");
		}
		const publicKey = createPublicKey({
			key: Buffer.from(options.publicKey, "base64url"),
			format: "der",
			type: "spki",
		});
		const valid = verify(
			null,
			Buffer.from(challenge.challenge),
			publicKey,
			Buffer.from(options.signature, "base64url"),
		);
		if (!valid) {
			throw new Error("Invalid signature");
		}
		this._challenges.delete(options.challengeId);
		const token = randomBytes(32).toString("base64url");
		const auth = { name: allowedUser.name, description: allowedUser.description };
		this._sessions.set(token, { publicKey: options.publicKey, auth });
		return { token, auth };
	}

	verifyToken(token: string): AuthSessionInfo | undefined {
		return this._sessions.get(token);
	}
}
