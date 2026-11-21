import { parseCanonicalInstant, parseOpaqueUuidV7 } from "../contracts/identity-actor.js";

export const guestSessionAbusePolicy = Object.freeze({
  version: "GUEST_SESSION_ABUSE_V2",
  windowSeconds: 600,
  // WP-2423 (v15 rush 2026-11-02): per address per Store, sized for one busy restaurant's Wi-Fi or
  // one carrier address: a full 60-seat room turning over, some rescanning, within ten minutes.
  ipLimit: 120,
  storeLimit: 300,
});
/**
 * WP-2423 (guest-waits-and-refund-lock): a phone at a table not open yet asks "is it open now?"
 * every few seconds, backing off, for at most 15 minutes (apps/customer-pwa
 * tableWaitCheckDelaysSeconds: at most 70 in any ten minutes). That read is a cheap one (the code
 * and the table's state, no visit, no admission) and has its own budget, so a room of waiting
 * phones never takes the entry budget new scans need: about eight waiting phones on one Wi-Fi and
 * thirty at the Store. Once the table is open the phone's entry is one ordinary entry attempt.
 */
export const guestTableWaitPolicy = Object.freeze({
  version: "GUEST_TABLE_WAIT_V1",
  windowSeconds: 600,
  ipLimit: 600,
  storeLimit: 2400,
});
export type GuestSessionAbusePolicy = Readonly<{
  windowSeconds: number;
  ipLimit: number;
  storeLimit: number;
}>;
export interface GuestSessionAbuseKeys {
  ip(
    address: string,
    scope: Readonly<{ brandReference: string; storeReference: string }>,
  ): Uint8Array;
  store(scope: Readonly<{ brandReference: string; storeReference: string }>): Uint8Array;
}
export interface GuestSessionAbuseBudget {
  consume(
    input: Readonly<{
      keyHash: Uint8Array;
      windowSeconds: number;
      limitCount: number;
      observedAt: string;
    }>,
  ): Promise<{ allowed: boolean; remaining: number; retry_after_seconds: number }>;
}
export type GuestSessionRequestAdmission =
  | { readonly status: "Allowed" }
  | { readonly status: "RateLimited"; readonly retryAfterSeconds: number }
  | { readonly status: "Unavailable" };

/** Controls attempts, not Guest authorization. Budget writes must commit outside
 * the subsequent Entry transaction, including on a denied/rolled-back request.
 */
export function createGuestSessionRequestAdmission(options: {
  scope: Readonly<{ brandReference: string; storeReference: string }>;
  keys: GuestSessionAbuseKeys;
  budget: GuestSessionAbuseBudget;
  now: () => string;
  /** The limits this admission applies (with keys of its own); the entry's when absent. */
  policy?: GuestSessionAbusePolicy;
}) {
  const scope = Object.freeze({
    brandReference: String(
      parseOpaqueUuidV7(options.scope.brandReference, "IDENTITY_INPUT_INVALID"),
    ),
    storeReference: String(
      parseOpaqueUuidV7(options.scope.storeReference, "IDENTITY_INPUT_INVALID"),
    ),
  });
  const { keys, budget, now } = options;
  const policy = options.policy ?? guestSessionAbusePolicy;
  async function consume(hash: Uint8Array, limit: number, at: string) {
    if (!(hash instanceof Uint8Array) || hash.byteLength !== 32) throw new Error("unavailable");
    const result = await budget.consume({
      keyHash: Uint8Array.from(hash),
      windowSeconds: policy.windowSeconds,
      limitCount: limit,
      observedAt: at,
    });
    if (
      !result ||
      typeof result.allowed !== "boolean" ||
      !Number.isSafeInteger(result.remaining) ||
      result.remaining < 0 ||
      result.remaining >= limit ||
      !Number.isSafeInteger(result.retry_after_seconds) ||
      (result.allowed
        ? result.retry_after_seconds !== 0
        : result.remaining !== 0 ||
          result.retry_after_seconds < 1 ||
          result.retry_after_seconds > 600)
    )
      throw new Error("unavailable");
    return result;
  }
  return Object.freeze({
    async consume(
      input: Readonly<{
        remoteAddress: string | null;
        requestedAt: string;
        /** False: the code's signature is bad. Only the address pays, never the Store's budget. */
        codeValid?: boolean;
      }>,
    ): Promise<GuestSessionRequestAdmission> {
      try {
        const at = String(parseCanonicalInstant(now()));
        const requestedAt = String(parseCanonicalInstant(input.requestedAt));
        if (requestedAt > at) return { status: "Unavailable" };
        // No true address (behind a hop that doesn't state one): the Store's limit alone, never
        // one key shared by everyone.
        if (input.remoteAddress !== null) {
          if (typeof input.remoteAddress !== "string") return { status: "Unavailable" };
          const ip = await consume(keys.ip(input.remoteAddress, scope), policy.ipLimit, at);
          if (!ip.allowed)
            return { status: "RateLimited", retryAfterSeconds: ip.retry_after_seconds };
        }
        if (input.codeValid === false) return { status: "Allowed" };
        const store = await consume(keys.store(scope), policy.storeLimit, at);
        return store.allowed
          ? { status: "Allowed" }
          : { status: "RateLimited", retryAfterSeconds: store.retry_after_seconds };
      } catch {
        return { status: "Unavailable" };
      }
    },
  });
}
