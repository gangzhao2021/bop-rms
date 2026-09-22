import { parseCanonicalInstant, parseOpaqueUuidV7 } from "../contracts/identity-actor.js";

export const guestSessionAbusePolicy = Object.freeze({
  version: "GUEST_SESSION_ABUSE_V1",
  windowSeconds: 600,
  ipLimit: 20,
  storeLimit: 300,
});
export interface GuestSessionAbuseKeys {
  ip(address: string): Uint8Array;
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
  async function consume(hash: Uint8Array, limit: number, at: string) {
    if (!(hash instanceof Uint8Array) || hash.byteLength !== 32) throw new Error("unavailable");
    const result = await budget.consume({
      keyHash: Uint8Array.from(hash),
      windowSeconds: guestSessionAbusePolicy.windowSeconds,
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
      input: Readonly<{ remoteAddress: string | null; requestedAt: string }>,
    ): Promise<GuestSessionRequestAdmission> {
      try {
        const at = String(parseCanonicalInstant(now()));
        const requestedAt = String(parseCanonicalInstant(input.requestedAt));
        if (requestedAt > at || typeof input.remoteAddress !== "string")
          return { status: "Unavailable" };
        const ip = await consume(keys.ip(input.remoteAddress), guestSessionAbusePolicy.ipLimit, at);
        if (!ip.allowed)
          return { status: "RateLimited", retryAfterSeconds: ip.retry_after_seconds };
        const store = await consume(keys.store(scope), guestSessionAbusePolicy.storeLimit, at);
        return store.allowed
          ? { status: "Allowed" }
          : { status: "RateLimited", retryAfterSeconds: store.retry_after_seconds };
      } catch {
        return { status: "Unavailable" };
      }
    },
  });
}
