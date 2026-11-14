import type { ConsumerTransaction } from "@bop/eventing";
import {
  createPostgresOrderCreationQueryStore,
  createPostgresAdditionalDiningBatchHistoryReader,
  type AdditionalDiningBatchSnapshot,
  parseOrderingReference,
  type OrderCreationRecord,
} from "@rms/ordering";
import {
  parsePaymentIntentCreationRecord,
  parsePaymentInstant,
  type PaymentIntentClaimAdmission,
  type PaymentIntentCreationRecord,
} from "@rms/payment";

/** Current Ordering header fence precedes capacity/Inventory fences for a new Payment claim. */
export function createCustomerOrderPaymentClaimAdmission(
  options: Readonly<{
    scope: Readonly<{ brandReference: string; storeReference: string }>;
    quoteVersion: 1 | 2;
    capacityForOrder: (current: OrderCreationRecord<1 | 2>) => PaymentIntentClaimAdmission;
  }>,
): PaymentIntentClaimAdmission {
  const scope = Object.freeze({
    brandReference: String(parseOrderingReference(options.scope.brandReference)),
    storeReference: String(parseOrderingReference(options.scope.storeReference)),
  });
  const quoteVersion = options.quoteVersion;
  const { capacityForOrder } = options;
  return Object.freeze({
    async admit(
      tx: Parameters<PaymentIntentClaimAdmission["admit"]>[0],
      value: PaymentIntentCreationRecord,
      observedAt: string,
    ) {
      try {
        const payment = parsePaymentIntentCreationRecord(value);
        const preparation = payment.intent.preparation;
        if (
          String(preparation.brandReference) !== scope.brandReference ||
          String(preparation.storeReference) !== scope.storeReference
        )
          return false;
        const store = createPostgresOrderCreationQueryStore(
          { run: async (work) => work(tx) },
          scope,
          quoteVersion,
        );
        return (
          (await store.withCurrentSubmission(
            preparation.submissionReference,
            async (transaction, current) => {
              const batch = current.order.batches[0];
              if (
                String(current.order.orderReference) !== String(preparation.orderReference) ||
                String(current.guestSessionReference) !==
                  String(preparation.guestSessionReference) ||
                String(batch.orderBatchReference) !== String(preparation.orderBatchReference) ||
                String(batch.sourceCartReference) !== String(preparation.sourceCartReference) ||
                batch.sourceCartVersion !== preparation.sourceCartVersion ||
                String(batch.quoteReference) !== String(preparation.quoteReference) ||
                current.createdAt > observedAt
              )
                return false;
              return capacityForOrder(current).admit(transaction, payment, observedAt);
            },
          )) ?? false
        );
      } catch {
        return false;
      }
    },
  });
}

/** Only adapts the result envelope; each owner still validates its own row fields. */
export function customerPaymentConsumerTransaction(
  transaction: Parameters<PaymentIntentClaimAdmission["admit"]>[0],
): ConsumerTransaction {
  return {
    async query<Row = Record<string, unknown>>(sql: string, values: readonly unknown[]) {
      const result = await transaction.query(sql, values);
      if (!result || typeof result !== "object") throw new Error("PAYMENT_ORDER_QUERY_UNAVAILABLE");
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
        throw new Error("PAYMENT_ORDER_QUERY_UNAVAILABLE");
      return { rows: rows.value as readonly Row[], rowCount: count.value as number | null };
    },
  };
}

/** Ordering disposition fence precedes existing Dining/Inventory admission. */
export function createCustomerAdditionalOrderPaymentClaimAdmission(options: {
  scope: { brandReference: string; storeReference: string };
  quoteVersion: 1 | 2;
  authorizeHistory(
    transaction: Parameters<PaymentIntentClaimAdmission["admit"]>[0],
    scope: { brandReference: string; storeReference: string; submissionReference: string },
  ): Promise<boolean>;
  capacityForSubmission(snapshot: AdditionalDiningBatchSnapshot): PaymentIntentClaimAdmission;
}): PaymentIntentClaimAdmission {
  const scope = {
    brandReference: String(parseOrderingReference(options.scope.brandReference)),
    storeReference: String(parseOrderingReference(options.scope.storeReference)),
  };
  return Object.freeze({
    async admit(
      transaction: Parameters<PaymentIntentClaimAdmission["admit"]>[0],
      value: PaymentIntentCreationRecord,
      at: string,
    ) {
      try {
        const payment = parsePaymentIntentCreationRecord(value);
        const observedAt = parsePaymentInstant(at);
        const p = payment.intent.preparation;
        if (
          String(p.brandReference) !== scope.brandReference ||
          String(p.storeReference) !== scope.storeReference
        )
          return false;
        const borrowed = customerPaymentConsumerTransaction(transaction);
        const owner = createPostgresAdditionalDiningBatchHistoryReader({
          ...scope,
          transactions: { run: async (work) => work(borrowed) },
          authorize: (_tx, binding) => options.authorizeHistory(transaction, binding),
        });
        return (
          (await owner.withCurrentSubmission(
            p.submissionReference,
            observedAt,
            async (_tx, current, link) => {
              const b = current.batch;
              if (
                current.snapshotVersion !== options.quoteVersion ||
                String(current.orderReference) !== String(p.orderReference) ||
                String(current.guestSessionReference) !== String(p.guestSessionReference) ||
                String(b.orderBatchReference) !== String(p.orderBatchReference) ||
                String(b.submissionReference) !== String(p.submissionReference) ||
                String(b.sourceCartReference) !== String(p.sourceCartReference) ||
                b.sourceCartVersion !== p.sourceCartVersion ||
                String(b.quoteReference) !== String(p.quoteReference) ||
                String(link.paymentOperationReference) !==
                  String(payment.intent.paymentOperationReference) ||
                String(link.commitmentReference) !== String(p.capacityAllocationReference) ||
                Date.parse(b.submittedAt) > Date.parse(observedAt)
              )
                return false;
              return options.capacityForSubmission(current).admit(transaction, payment, observedAt);
            },
          )) ?? false
        );
      } catch {
        return false;
      }
    },
  });
}
