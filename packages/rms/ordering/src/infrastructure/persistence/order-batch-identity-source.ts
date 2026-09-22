import type { ConsumerTransaction } from "@bop/eventing";
import { parseOrderingReference, parseOrderingInstant } from "../../domain/cart.js";
const unavailable = (): never => {
  throw new Error("ORDER_BATCH_IDENTITY_UNAVAILABLE");
};

/** Immutable batch identity for server composition, not payment or execution eligibility. */
export function createPostgresOrderBatchIdentitySource(options: {
  brandReference: string;
  storeReference: string;
  authorize(
    transaction: ConsumerTransaction,
    query: {
      orderReference: string;
      orderBatchReference: string;
      observedAt: string;
    },
  ): Promise<boolean>;
}) {
  const brand = String(parseOrderingReference(options.brandReference));
  const store = String(parseOrderingReference(options.storeReference));
  return Object.freeze({
    async load(
      transaction: ConsumerTransaction,
      input: {
        orderReference: string;
        orderBatchReference: string;
        observedAt: string;
      },
    ) {
      try {
        const query = Object.freeze({
          orderReference: String(parseOrderingReference(input.orderReference)),
          orderBatchReference: String(parseOrderingReference(input.orderBatchReference)),
          observedAt: String(parseOrderingInstant(input.observedAt)),
        });
        if (!(await options.authorize(transaction, query))) return unavailable();
        await transaction.query(
          "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
          [brand, store],
        );
        const result = await transaction.query(
          "SELECT b.submission_id,s.submission_kind,h.order_type FROM rms_ordering.order_batch b " +
            "JOIN rms_ordering.order_submission_record s ON s.brand_id=b.brand_id AND s.store_id=b.store_id AND s.order_id=b.order_id AND s.submission_id=b.submission_id " +
            "JOIN rms_ordering.order_header h ON h.brand_id=b.brand_id AND h.store_id=b.store_id AND h.order_id=b.order_id " +
            "WHERE b.brand_id=$1 AND b.store_id=$2 AND b.order_id=$3 AND b.order_batch_id=$4 " +
            "AND b.submitted_at <= $5::timestamptz AND s.created_at <= $5::timestamptz LIMIT 2",
          [brand, store, query.orderReference, query.orderBatchReference, query.observedAt],
        );
        if (!(await options.authorize(transaction, query))) return unavailable();
        if (result.rows.length === 0) return null;
        if (result.rows.length !== 1) return unavailable();
        const row = result.rows[0];
        if (
          !row ||
          (row.submission_kind !== "Initial" && row.submission_kind !== "Additional") ||
          (row.order_type !== "DineIn" && row.order_type !== "Pickup") ||
          (row.submission_kind === "Additional" && row.order_type !== "DineIn")
        )
          return unavailable();
        return Object.freeze({
          ...query,
          brandReference: brand,
          storeReference: store,
          submissionReference: String(parseOrderingReference(row.submission_id)),
          kind: row.submission_kind as "Initial" | "Additional",
          orderType: row.order_type as "DineIn" | "Pickup",
        });
      } catch {
        return unavailable();
      }
    },
  });
}
