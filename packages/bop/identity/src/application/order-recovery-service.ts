import { createHmac, randomBytes } from "node:crypto";
import { parseGuestRawCredential, type GuestRawCredential } from "../contracts/guest-session.js";
import type { GuestSessionCredentialPort } from "./ports/guest-session-ports.js";

/**
 * DEC-PILOT-NOTIFICATIONS R1 — IDR-0031 one-time order recovery link (Identity-owned).
 *
 * Mint: a 256-bit random token, stored only as a keyed hash (purpose-separated, versioned pepper)
 * with the Order, the Order's original Guest Session and a 30-minute expiry; at most two unexpired
 * siblings per Order. The plaintext exists only in the caller's memory and the delivered message.
 *
 * Consume: one transaction appends Consumed (and Revoked for siblings) and re-keys that same Guest
 * Session — still Active and within its §86 absolute/closure limits — then returns the new session
 * credential and the clean order path. Every failure is the same `Unavailable` (no oracle).
 */
export const orderRecoveryLifetimeMs = 30 * 60 * 1000;
export const orderRecoveryMaximumActiveSiblings = 2;
const tokenPattern = /^[A-Za-z0-9_-]{43}$/u;
const uuidV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

export class OrderRecoveryError extends Error {
  readonly code: "ORDER_RECOVERY_UNAVAILABLE" | "ORDER_RECOVERY_RATE_LIMITED";
  readonly retryAfterSeconds: number | null;
  constructor(code: OrderRecoveryError["code"], retryAfterSeconds: number | null = null) {
    super("order recovery unavailable");
    this.name = "OrderRecoveryError";
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}
const unavailable = (): never => {
  throw new OrderRecoveryError("ORDER_RECOVERY_UNAVAILABLE");
};

export interface OrderRecoveryPepper {
  readonly version: number;
  readonly key: Uint8Array;
}

/** Keyed token hashing with dual-read across pepper versions (newest writes). */
export function createOrderRecoveryTokenHasher(peppers: readonly OrderRecoveryPepper[]) {
  if (
    peppers.length < 1 ||
    peppers.some(
      (p) => !Number.isSafeInteger(p.version) || p.version < 1 || p.key.byteLength < 32,
    ) ||
    new Set(peppers.map((p) => p.version)).size !== peppers.length
  )
    return unavailable();
  const ordered = [...peppers]
    .sort((a, b) => b.version - a.version)
    .map((p) => ({ version: p.version, key: Buffer.from(p.key) }));
  const hash = (key: Buffer, token: string) =>
    createHmac("sha256", key)
      .update("bop-rms:order-recovery:v1", "utf8")
      .update(Buffer.from([0]))
      .update(token, "utf8")
      .digest("hex");
  return Object.freeze({
    mint() {
      const token = randomBytes(32).toString("base64url");
      const newest = ordered[0] as { version: number; key: Buffer };
      return Object.freeze({
        token,
        tokenHash: hash(newest.key, token),
        pepperVersion: newest.version,
      });
    },
    candidates(token: string) {
      if (typeof token !== "string" || !tokenPattern.test(token)) return unavailable();
      return ordered.map((p) =>
        Object.freeze({ tokenHash: hash(p.key, token), pepperVersion: p.version }),
      );
    },
  });
}
export type OrderRecoveryTokenHasher = ReturnType<typeof createOrderRecoveryTokenHasher>;

export interface OrderRecoveryStorePort {
  /** Appends an authorization unless two unexpired, unconsumed siblings already exist. */
  appendAuthorization(input: {
    readonly authorizationReference: string;
    readonly orderReference: string;
    readonly guestSessionReference: string;
    readonly notificationAttemptReference: string;
    readonly tokenHash: string;
    readonly pepperVersion: number;
    readonly issuedAt: string;
    readonly expiresAt: string;
  }): Promise<"Created" | "SiblingLimit">;
  /** Order of a still-redeemable authorization (for the per-Order budget), or null. */
  peekOrder(input: {
    readonly candidates: readonly { readonly tokenHash: string; readonly pepperVersion: number }[];
  }): Promise<string | null>;
  /**
   * In one transaction: lock the matching unexpired, unconsumed authorization, append Consumed and
   * Revoked-for-siblings, lock its Guest Session and, when still Active and within its absolute and
   * closure limits, re-key it. Null when anything does not hold (the transaction rolls back).
   */
  consumeAndRekey(input: {
    readonly candidates: readonly { readonly tokenHash: string; readonly pepperVersion: number }[];
    readonly observedAt: string;
    readonly rekeyOperationReference: string;
    readonly rekeyOperationIntentHash: string;
    readonly sessionSelectorHash: string;
    readonly csrfSelectorHash: string;
  }): Promise<{ readonly orderReference: string } | null>;
}

export interface OrderRecoveryBudgetPort {
  /** §87.4.2: 5 per hour per Order/contact/IP combination; fails closed. */
  consume(input: {
    readonly orderReference: string | null;
    readonly peerAddress: string;
    readonly observedAt: string;
  }): Promise<
    | { readonly status: "Allowed" }
    | { readonly status: "RateLimited"; readonly retryAfterSeconds: number }
  >;
}

export function createOrderRecoveryService(ports: {
  readonly hasher: OrderRecoveryTokenHasher;
  readonly store: OrderRecoveryStorePort;
  readonly budget: OrderRecoveryBudgetPort;
  readonly credentials: GuestSessionCredentialPort;
  readonly references: { generate(): string };
  readonly clock: { now(): string };
}) {
  return Object.freeze({
    /**
     * Mints a link token for one notification attempt. Returns null when the sibling limit is
     * reached (the message is then sent without a link).
     */
    async mint(input: {
      readonly orderReference: string;
      readonly guestSessionReference: string;
      readonly notificationAttemptReference: string;
    }): Promise<{ readonly token: string; readonly expiresAt: string } | null> {
      if (
        ![
          input.orderReference,
          input.guestSessionReference,
          input.notificationAttemptReference,
        ].every((value) => typeof value === "string" && uuidV7.test(value))
      )
        return unavailable();
      const issuedAt = ports.clock.now();
      if (!instant.test(issuedAt)) return unavailable();
      const expiresAt = new Date(Date.parse(issuedAt) + orderRecoveryLifetimeMs).toISOString();
      const minted = ports.hasher.mint();
      const saved = await ports.store.appendAuthorization({
        authorizationReference: ports.references.generate(),
        orderReference: input.orderReference,
        guestSessionReference: input.guestSessionReference,
        notificationAttemptReference: input.notificationAttemptReference,
        tokenHash: minted.tokenHash,
        pepperVersion: minted.pepperVersion,
        issuedAt,
        expiresAt,
      });
      if (saved !== "Created") return null;
      return Object.freeze({ token: minted.token, expiresAt });
    },

    async consume(input: { readonly token: unknown; readonly peerAddress: string }): Promise<{
      readonly orderReference: string;
      readonly sessionCredential: GuestRawCredential;
    }> {
      const observedAt = ports.clock.now();
      if (!instant.test(observedAt) || typeof input.token !== "string") return unavailable();
      let candidates;
      try {
        candidates = ports.hasher.candidates(input.token);
      } catch {
        // A malformed token still spends the per-peer budget.
        candidates = null;
      }
      const orderReference =
        candidates === null ? null : await ports.store.peekOrder({ candidates });
      const budget = await ports.budget.consume({
        orderReference,
        peerAddress: input.peerAddress,
        observedAt,
      });
      if (budget.status === "RateLimited")
        throw new OrderRecoveryError("ORDER_RECOVERY_RATE_LIMITED", budget.retryAfterSeconds);
      if (candidates === null || orderReference === null) return unavailable();
      const sessionCredential = parseGuestRawCredential(
        ports.credentials.generateCredential("Session"),
      );
      const csrfCredential = parseGuestRawCredential(ports.credentials.generateCredential("Csrf"));
      const operation = ports.references.generate();
      const result = await ports.store.consumeAndRekey({
        candidates,
        observedAt,
        rekeyOperationReference: operation,
        rekeyOperationIntentHash: ports.credentials.hashOperationIntent(
          `order-recovery\u0000${operation}`,
        ),
        sessionSelectorHash: ports.credentials.hashCredential("Session", sessionCredential),
        csrfSelectorHash: ports.credentials.hashCredential("Csrf", csrfCredential),
      });
      if (result === null || result.orderReference !== orderReference) return unavailable();
      return Object.freeze({ orderReference: result.orderReference, sessionCredential });
    },
  });
}
export type OrderRecoveryService = ReturnType<typeof createOrderRecoveryService>;

/** IDR-0031 link: the token only ever travels in the fragment. */
export function buildOrderRecoveryLink(origin: string, token: string): string {
  if (!/^https:\/\/[a-z0-9.-]+(?::[1-9][0-9]{0,4})?$/u.test(origin) || !tokenPattern.test(token))
    return unavailable();
  return `${origin}/resume#t=${token}`;
}
