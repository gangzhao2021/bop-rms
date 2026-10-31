import console from "node:console";
import { recordStorePresence, storePresenceWriteIntervalMilliseconds } from "@rms/store";

interface Transactions {
  run<T>(
    work: (transaction: {
      query<Row = Record<string, unknown>>(
        sql: string,
        values: readonly unknown[],
      ): Promise<{ readonly rows: readonly Row[]; readonly rowCount: number | null }>;
    }) => Promise<T>,
  ): Promise<T>;
}

/**
 * WP-2423 Q9-G1 (DEC-OUTAGE-ACCEPTANCE-HOLD): records that signed-in staff are using the Store's
 * screens (Orders page, kitchen board, counter order) after a successful authenticated read. At
 * most one write a minute per Store from this process (the Store's own store also refuses more),
 * in its own transaction; a failure is logged as a code only and never fails the staff request.
 */
export function createMerchantStorePresence(options: {
  transactions: Transactions;
  now(): string;
  newReference(): string;
}) {
  const lastWritten = new Map<string, number>();
  const observe = async (scope: { brandReference: string; storeReference: string }) => {
    const key = scope.brandReference + ":" + scope.storeReference;
    const observedAt = options.now();
    const at = Date.parse(observedAt);
    const previous = lastWritten.get(key);
    if (previous !== undefined && at - previous < storePresenceWriteIntervalMilliseconds) return;
    lastWritten.set(key, at);
    try {
      await options.transactions.run((transaction) =>
        recordStorePresence(transaction, scope, {
          observedAt,
          newPeriodReference: options.newReference,
        }),
      );
    } catch (error) {
      lastWritten.delete(key);
      const code = (error as { code?: unknown } | null)?.code;
      console.error(
        JSON.stringify({
          event: "STORE_PRESENCE_UNAVAILABLE",
          code: typeof code === "string" && /^[A-Z0-9_]{1,80}$/u.test(code) ? code : undefined,
        }),
      );
    }
  };
  return Object.freeze({
    observe,
    /** Wraps a staff read so its success counts as Store activity. */
    wrap<Input extends unknown[], Output>(
      scope: { brandReference: string; storeReference: string },
      read: (...input: Input) => Promise<Output>,
    ) {
      return async (...input: Input): Promise<Output> => {
        const output = await read(...input);
        await observe(scope);
        return output;
      };
    },
  });
}
