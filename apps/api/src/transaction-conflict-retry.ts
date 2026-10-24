/**
 * WP-2423: reruns a whole transaction that failed only on a lock, serialization or deadlock
 * conflict (`TENANT_DATABASE_TRANSACTION_CONFLICT`). Nothing of the failed attempt was committed,
 * and the callers' commands carry stable operation references, so a rerun is idempotent. Waits
 * stay short so queued readers (orders, kitchen) are never held behind an administrative write.
 */
export async function retryTransactionConflict<T>(
  work: () => Promise<T>,
  options: {
    readonly attempts?: number;
    readonly sleep?: (ms: number) => Promise<void>;
    readonly random?: () => number;
  } = {},
): Promise<T> {
  const attempts = options.attempts ?? 4,
    sleep =
      options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
    random = options.random ?? Math.random;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await work();
    } catch (error) {
      const code =
        error !== null && typeof error === "object"
          ? Object.getOwnPropertyDescriptor(error, "code")?.value
          : undefined;
      if (code !== "TENANT_DATABASE_TRANSACTION_CONFLICT" || attempt >= attempts) throw error;
      await sleep(Math.round(150 * 2 ** (attempt - 1) * (0.5 + random())));
    }
  }
}
