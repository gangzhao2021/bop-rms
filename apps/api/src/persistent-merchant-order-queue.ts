import type { ConsumerTransaction } from "@bop/eventing";
import { listStoreUnfulfillablePaidOrders, loadMerchantOrderLines } from "@rms/ordering";
import { createPostgresCurrentBrowserSessionSource } from "@bop/identity";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import { createMerchantOrderQueueRead } from "./merchant-order-queue-read.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";

/** Read-only merchant intent; session identity and selected scope are resolved inside its transaction. */
export function createPersistentMerchantOrderQueue(options: {
  persistence: PersistentMerchantBffOptions;
  quoteVersion: 1 | 2;
  acceptanceConfigured?: boolean;
  /** WP-2423: the locale item names are shown in on the order detail (the Store's locale). */
  locale?: string;
}) {
  const source = options.persistence;
  const currentSession = createPostgresCurrentBrowserSessionSource({
    hasher: source.identity.hasher,
    now: source.now,
    currentActor: source.currentActor,
  });
  const resolveScope = createMerchantStoreScope(source);
  return async (input: {
    sessionCookie: unknown;
    afterOrderReference: string | null;
    /** WP-2423 OPS-ORDER-DETAIL: the one Order the detail shows. */
    orderReference?: string;
  }) =>
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
      let ownerScope: { brandReference: string; storeReference: string } | null = null;
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
          ownerScope = {
            brandReference: String(resolved.context.brand.brandReference),
            storeReference: String(resolved.store.storeReference),
          };
          return {
            tenantReference: resolved.selected.tenantReference,
            brandReference: String(resolved.context.brand.brandReference),
            storeReference: String(resolved.store.storeReference),
            sessionReference: String(session.sessionReference),
          };
        },
      });
      const result = await read({
        sessionCookie: input.sessionCookie,
        afterOrderReference: input.orderReference === undefined ? input.afterOrderReference : null,
        limit: input.orderReference === undefined ? 50 : 1,
        ...(input.orderReference === undefined ? {} : { onlyOrderReference: input.orderReference }),
      });
      // What was ordered, read in the same transaction under the same ordering.operate scope.
      const only = result.items[0];
      const lines =
        input.orderReference === undefined || only === undefined
          ? null
          : await (async () => {
              const resolved = await resolveScope(
                transaction,
                input.sessionCookie,
                "ordering.operate",
                session.sessionReference,
              );
              if ((await resolved.allowed()) !== true)
                throw new Error("MERCHANT_ORDER_QUEUE_UNAVAILABLE");
              return loadMerchantOrderLines(
                businessTransaction,
                {
                  brandReference: String(resolved.context.brand.brandReference),
                  storeReference: String(resolved.store.storeReference),
                },
                only.orderReference,
                options.locale ?? "en-CA",
              );
            })();
      // WP-2423: a paid Order that can no longer be fulfilled (for example not accepted before its
      // capacity expired) is refunded by Payment; it is shown as such and never offered for acceptance.
      const unfulfillable =
        ownerScope === null || result.items.length === 0
          ? new Map<string, string>()
          : await listStoreUnfulfillablePaidOrders(
              businessTransaction,
              ownerScope,
              result.items.map((item) => item.orderReference),
            );
      return Object.freeze({
        ...result,
        lines,
        items: Object.freeze(
          result.items.map((item) => {
            const latestBatchSequence = item.batches.reduce(
              (latest, batch) => Math.max(latest, batch.sequence),
              0,
            );
            const closed = unfulfillable.get(item.orderReference) ?? null;
            return Object.freeze({
              ...item,
              unfulfillable: closed,
              batches: Object.freeze(
                item.batches.map((batch) =>
                  Object.freeze({
                    ...batch,
                    canRequestAcceptance:
                      closed === null &&
                      acceptanceAllowed &&
                      batch.acceptanceStatus === "NotAccepted" &&
                      item.currentVersion !== null &&
                      ["Submitted", "Accepted", "InProgress", "Ready"].includes(
                        String(item.currentPhase),
                      ) &&
                      (batch.sequence > 1 ||
                        (item.orderType === "DineIn" && batch.sequence === latestBatchSequence) ||
                        item.currentVersion === 1),
                  }),
                ),
              ),
              canRequestAcceptance:
                closed === null &&
                acceptanceAllowed &&
                item.currentPhase === "Submitted" &&
                item.currentVersion === 1,
            });
          }),
        ),
      });
    });
}
