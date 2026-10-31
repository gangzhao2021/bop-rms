const classes = [
  "DINING_JOIN_FAILURE",
  "GUEST_SESSION",
  "MERCHANT_LOGIN_FAILURE",
  "ORDER_RESUME",
  "PICKUP_PROOF_FAILURE",
  "TRANSACTION_CREATE",
] as const;
export type AbuseBucketClass = (typeof classes)[number];
export interface AbuseBudgetResult {
  readonly allowed: boolean;
  readonly remaining: number;
  readonly retry_after_seconds: number;
}
export class AbuseBudgetUnavailableError extends Error {
  constructor() {
    super("ABUSE_BUDGET_UNAVAILABLE");
    this.name = "AbuseBudgetUnavailableError";
  }
}
/** Shared infrastructure only. Caller supplies a purpose-separated keyed hash,
 * trusted server clock and an authorized policy. Query must commit independently
 * of any business transaction whose rejection could otherwise undo the attempt.
 * Connection/timeout/expiry-worker ownership remains with the caller.
 */
export function createAbuseBudgetConsumer(options: {
  readonly bucketClass: AbuseBucketClass;
  readonly windowSeconds: number;
  readonly limitCount: number;
  readonly now: () => string;
  readonly query: (sql: string, values: readonly unknown[]) => Promise<unknown>;
}) {
  const { bucketClass, windowSeconds, limitCount, now, query } = options;
  if (
    !classes.includes(bucketClass) ||
    !Number.isSafeInteger(windowSeconds) ||
    windowSeconds < 1 ||
    windowSeconds > 86400 ||
    !Number.isSafeInteger(limitCount) ||
    limitCount < 1 ||
    limitCount > 2147483647
  )
    throw new AbuseBudgetUnavailableError();
  return Object.freeze({
    async consume(keyHash: Uint8Array): Promise<AbuseBudgetResult> {
      try {
        if (!(keyHash instanceof Uint8Array) || keyHash.byteLength !== 32)
          throw new AbuseBudgetUnavailableError();
        const hash = Buffer.from(keyHash);
        const at = now();
        const time = Date.parse(at);
        if (!Number.isFinite(time) || new Date(time).toISOString() !== at)
          throw new AbuseBudgetUnavailableError();
        const start = new Date(
          Math.floor(time / (windowSeconds * 1000)) * windowSeconds * 1000,
        ).toISOString();
        const response = await query(
          "SELECT allowed,remaining,retry_after_seconds FROM security.consume_abuse_budget($1,$2,$3,$4,$5,$6)",
          [bucketClass, hash, start, windowSeconds, limitCount, at],
        );
        if (
          !response ||
          typeof response !== "object" ||
          !("rows" in response) ||
          !Array.isArray(response.rows) ||
          response.rows.length !== 1
        )
          throw new AbuseBudgetUnavailableError();
        const row = response.rows[0] as Record<string, unknown>;
        if (
          !row ||
          typeof row !== "object" ||
          Object.keys(row).sort().join(",") !== "allowed,remaining,retry_after_seconds" ||
          typeof row.allowed !== "boolean" ||
          !Number.isSafeInteger(row.remaining) ||
          Number(row.remaining) < 0 ||
          Number(row.remaining) >= limitCount ||
          !Number.isSafeInteger(row.retry_after_seconds) ||
          (row.allowed
            ? row.retry_after_seconds !== 0
            : row.remaining !== 0 ||
              Number(row.retry_after_seconds) < 1 ||
              Number(row.retry_after_seconds) > windowSeconds)
        )
          throw new AbuseBudgetUnavailableError();
        return Object.freeze({
          allowed: row.allowed,
          remaining: Number(row.remaining),
          retry_after_seconds: Number(row.retry_after_seconds),
        });
      } catch {
        throw new AbuseBudgetUnavailableError();
      }
    },
  });
}
