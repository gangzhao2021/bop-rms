import console from "node:console";
import { kitchenScreenPresenceWriteIntervalMs, recordKitchenScreenPresence } from "@rms/kitchen";
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

/**
 * WP-2423 DEC-PAID-ORDER-AUTO-ACCEPT: that a kitchen board is open at this Store. Only the board's
 * own read counts: an Orders page at the till, an owner's phone at home, or the small watch every
 * screen of a kitchen sign-in makes for its warnings (query kind "Watch") must not send paid orders
 * to a screen nobody has open. At most one write a minute per Store from this process; a failure is
 * logged as a code only and never fails the board.
 */
export function createMerchantKitchenScreenPresence(options: {
  transactions: Transactions;
  now(): string;
}) {
  const lastWritten = new Map<string, number>();
  return Object.freeze({
    wrap<Input extends unknown[], Output>(
      scope: { brandReference: string; storeReference: string },
      read: (...input: Input) => Promise<Output>,
    ) {
      return async (...input: Input): Promise<Output> => {
        const output = await read(...input);
        const asked = (input[0] as { readonly query?: { readonly kind?: unknown } } | undefined)
          ?.query;
        if (asked?.kind === "Watch") return output;
        const key = scope.brandReference + ":" + scope.storeReference;
        const observedAt = options.now();
        const at = Date.parse(observedAt);
        const previous = lastWritten.get(key);
        if (previous !== undefined && at - previous < kitchenScreenPresenceWriteIntervalMs)
          return output;
        lastWritten.set(key, at);
        try {
          await options.transactions.run((transaction) =>
            recordKitchenScreenPresence(transaction as never, scope, observedAt),
          );
        } catch (error) {
          lastWritten.delete(key);
          const code = (error as { code?: unknown } | null)?.code;
          console.error(
            JSON.stringify({
              event: "KITCHEN_SCREEN_PRESENCE_UNAVAILABLE",
              code: typeof code === "string" && /^[A-Z0-9_]{1,80}$/u.test(code) ? code : undefined,
            }),
          );
        }
        return output;
      };
    },
  });
}
