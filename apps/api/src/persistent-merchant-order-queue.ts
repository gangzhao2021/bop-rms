import type { ConsumerTransaction } from "@bop/eventing";
import { createPostgresCurrentBrowserSessionSource } from "@bop/identity";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import { createMerchantOrderQueueRead } from "./merchant-order-queue-read.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";

/** Read-only merchant intent; session identity and selected scope are resolved inside its transaction. */
export function createPersistentMerchantOrderQueue(options: {
  persistence: PersistentMerchantBffOptions;
  quoteVersion: 1 | 2;
  acceptanceConfigured?: boolean;
}) {
  const source = options.persistence;
  const currentSession = createPostgresCurrentBrowserSessionSource({
    hasher: source.identity.hasher,
    now: source.now,
    currentActor: source.currentActor,
  });
  const resolveScope = createMerchantStoreScope(source);
  return async (input: { sessionCookie: unknown; afterOrderReference: string | null }) =>
    source.transactions.run(async (transaction) => {
      const session = await currentSession(transaction, input.sessionCookie);
      const businessTransaction: ConsumerTransaction = {
        async query<Row = Record<string, unknown>>(sql: string, values: readonly unknown[]) {
          const result = await transaction.query(sql, values);
          if (!result || typeof result !== "object")
            throw new Error("MERCHANT_ORDER_QUEUE_UNAVAILABLE");
          const rows = Object.getOwnPropertyDescriptor(result, "rows");
          const count = Object.getOwnPropertyDescriptor(result, "rowCount");
          if (
            !rows ||
            !("value" in rows) ||
            !Array.isArray(rows.value) ||
            !count ||
            !("value" in count) ||
            (count.value !== null &&
              (typeof count.value !== "number" ||
                !Number.isSafeInteger(count.value) ||
                count.value < 0))
          )
            throw new Error("MERCHANT_ORDER_QUEUE_UNAVAILABLE");
          return { rows: rows.value as readonly Row[], rowCount: count.value as number | null };
        },
      };

      let acceptanceAllowed = false;
      const read = createMerchantOrderQueueRead({
        transactions: { run: (work) => work(businessTransaction) },
        quoteVersion: options.quoteVersion,
        now: source.now,
        authorize: async () => {
          const resolved = await resolveScope(
            transaction,
            input.sessionCookie,
            "ordering.operate",
            session.sessionReference,
          );
          if ((await resolved.allowed()) !== true) return null;
          acceptanceAllowed =
            options.acceptanceConfigured === true &&
            (await resolved.authorizeAction("order.accept"))?.effect === "Allow";
          return {
            tenantReference: resolved.selected.tenantReference,
            brandReference: String(resolved.context.brand.brandReference),
            storeReference: String(resolved.store.storeReference),
            sessionReference: String(session.sessionReference),
          };
        },
      });
      const result = await read({ ...input, limit: 50 });
      return Object.freeze({
        ...result,
        items: Object.freeze(
          result.items.map((item) =>
            Object.freeze({
              ...item,
              batches: Object.freeze(
                item.batches.map((batch) =>
                  Object.freeze({
                    ...batch,
                    canRequestAcceptance:
                      acceptanceAllowed &&
                      batch.acceptanceStatus === "NotAccepted" &&
                      item.currentVersion !== null &&
                      ["Submitted", "Accepted", "InProgress", "Ready"].includes(
                        String(item.currentPhase),
                      ) &&
                      (batch.sequence > 1 ||
                        item.orderType === "DineIn" ||
                        item.currentVersion === 1),
                  }),
                ),
              ),
              canRequestAcceptance:
                acceptanceAllowed && item.currentPhase === "Submitted" && item.currentVersion === 1,
            }),
          ),
        ),
      });
    });
}
