import {
  createPostgresDiningItemServiceStore,
  parseDiningItemServiceRecord,
  parseDiningInstant,
} from "@rms/dining";
import type { ConsumerTransaction } from "@bop/eventing";
import { createDiningOrderPreparationProgress } from "./dining-order-preparation-progress.js";

type WriterOptions = Parameters<typeof createPostgresDiningItemServiceStore>[0];
type Current = NonNullable<
  Awaited<ReturnType<ReturnType<typeof createDiningOrderPreparationProgress>["load"]>>
>;

/** Caller supplies authenticated merchant policy; current quantities/readiness are owner facts.
 * Retain Ordering/Kitchen before Dining table/session/item locks until caller commit.
 */
export function createMerchantDiningItemServiceComposition(options: {
  scope: WriterOptions["scope"];
  authorize: WriterOptions["authorize"];
  audit: WriterOptions["audit"];
  now(): string;
  validateSource(
    tx: ConsumerTransaction,
    record: Parameters<WriterOptions["authorize"]>[1],
    current: Current,
  ): Promise<boolean>;
}) {
  return Object.freeze({
    async commit(input: {
      transaction: ConsumerTransaction;
      record: unknown;
      guestSessionReference: string;
    }) {
      const record = parseDiningItemServiceRecord(input.record);
      if (
        record.tenantReference !== options.scope.tenantReference ||
        record.brandReference !== options.scope.brandReference ||
        record.storeReference !== options.scope.storeReference ||
        (await options.authorize(input.transaction, record)) !== true
      )
        throw new Error("DINING_ITEM_SERVICE_UNAVAILABLE");
      const observedAt = parseDiningInstant(options.now());
      if (observedAt < record.recordedAt) throw new Error("DINING_ITEM_SERVICE_UNAVAILABLE");
      const current = await createDiningOrderPreparationProgress({
        brandReference: options.scope.brandReference,
        storeReference: options.scope.storeReference,
        authorize: (tx) => options.authorize(tx, record),
        authorizeKitchen: (tx) => options.authorize(tx, record),
      }).load({
        transaction: input.transaction,
        brandReference: options.scope.brandReference,
        storeReference: options.scope.storeReference,
        diningSessionReference: record.diningSessionReference,
        orderReference: record.orderReference,
        guestSessionReference: input.guestSessionReference,
        observedAt,
      });
      return createPostgresDiningItemServiceStore({
        scope: options.scope,
        authorize: options.authorize,
        audit: options.audit,
        validateCurrent: async (tx, candidate) => {
          const item = current?.items.find(
            (entry) =>
              entry.orderItemReference === candidate.orderItemReference &&
              entry.orderBatchReference === candidate.orderBatchReference,
          );
          if (
            !current ||
            current.orderVersion !== candidate.expectedOrderVersion ||
            item?.phase !== "Ready" ||
            (await options.validateSource(tx as ConsumerTransaction, candidate, current)) !== true
          )
            throw new Error("DINING_ITEM_SERVICE_UNAVAILABLE");
          return { orderedQuantity: item.orderedQuantity, readyQuantity: item.orderedQuantity };
        },
      }).commit({ transaction: input.transaction, record });
    },
  });
}
