import { createHash } from "node:crypto";
import { createPostgresOrderRevisionPosition } from "./order-revision-position.js";
import { createPostgresSubmittedOrderAmountSource } from "./submitted-order-amount-source.js";
import { parseOrderingReference, parseOrderingInstant } from "../../domain/cart.js";
type Options = Parameters<typeof createPostgresSubmittedOrderAmountSource>[0];
type Base = Awaited<ReturnType<ReturnType<typeof createPostgresSubmittedOrderAmountSource>>>;
const fail = (): never => {
  throw new Error("ORDER_CANCELLED_AMOUNT_UNAVAILABLE");
};
/** Current deduction from frozen submitted prices. No refund, history mutation or
 * financial finality. Caller retains the parent Order fence and transaction. */
export function createPostgresOrderCancelledAmountSource(options: Options) {
  const brand = String(parseOrderingReference(options.brandReference));
  const store = String(parseOrderingReference(options.storeReference));
  const revision = createPostgresOrderRevisionPosition(options);
  return async (tx: Parameters<Options["authorize"]>[0], base: Base) => {
    try {
      const query = {
        orderReference: String(parseOrderingReference(base.orderReference)),
        observedAt: String(parseOrderingInstant(base.observedAt)),
      };
      if (
        base.brandReference !== brand ||
        base.storeReference !== store ||
        (await options.authorize(tx, {
          ...query,
          brandReference: brand,
          storeReference: store,
        })) !== true
      )
        return fail();
      const rows = (
        await tx.query(
          `SELECT c.cancellation_id::text,c.order_batch_id::text,c.cancelled_at,c.cancelled_order_version,
         (c.phase='Cancelled' AND c.reason_code='CHECKOUT_DEADLINE_REACHED'
          AND EXISTS(SELECT 1 FROM rms_ordering.order_batch b WHERE b.brand_id=c.brand_id AND b.store_id=c.store_id AND b.order_id=c.order_id AND b.order_batch_id=c.order_batch_id AND b.submission_id=c.submission_id)
          AND EXISTS(SELECT 1 FROM rms_ordering.order_revision r WHERE r.brand_id=c.brand_id AND r.store_id=c.store_id AND r.order_id=c.order_id AND r.revision_id=c.cancellation_id AND r.kind='BatchCancellation' AND r.previous_revision_id=c.expected_source_checkpoint AND r.expected_version=c.expected_order_version AND r.version=c.cancelled_order_version AND r.occurred_at=c.cancelled_at)
          AND c.order_item_ids=ARRAY(SELECT i.order_item_id::uuid FROM rms_ordering.order_item i WHERE i.brand_id=c.brand_id AND i.store_id=c.store_id AND i.order_id=c.order_id AND i.order_batch_id=c.order_batch_id ORDER BY i.order_item_id)) AS source_bound
         FROM rms_ordering.order_batch_checkout_cancellation c WHERE c.brand_id=$1 AND c.store_id=$2 AND c.order_id=$3 ORDER BY c.cancelled_order_version LIMIT 10002`,
          [brand, store, query.orderReference],
        )
      ).rows;
      if (rows.length > base.batches.length) return fail();
      const position = rows.length ? await revision(tx, query) : null;
      const seen = new Set<string>();
      const evidence = rows.map((row) => {
        const batchReference = String(parseOrderingReference(row.order_batch_id));
        const cancellationReference = String(parseOrderingReference(row.cancellation_id));
        const at = String(
          parseOrderingInstant(
            row.cancelled_at instanceof Date ? row.cancelled_at.toISOString() : row.cancelled_at,
          ),
        );
        const batch = base.batches.find((b) => String(b.orderBatchReference) === batchReference);
        if (
          !position ||
          row.source_bound !== true ||
          seen.has(batchReference) ||
          !batch ||
          batch.itemCount < 1 ||
          typeof batch.totalMinor !== "bigint" ||
          batch.totalMinor < 0n ||
          at > query.observedAt ||
          typeof row.cancelled_order_version !== "number" ||
          !Number.isSafeInteger(row.cancelled_order_version) ||
          row.cancelled_order_version < 2 ||
          row.cancelled_order_version > position.version
        )
          return fail();
        seen.add(batchReference);
        return Object.freeze({
          batchReference,
          cancellationReference,
          cancelledAt: at,
          amountMinor: batch.totalMinor.toString(),
        });
      });
      const cancelledTotalMinor = evidence.reduce((sum, row) => sum + BigInt(row.amountMinor), 0n);
      if (
        cancelledTotalMinor > base.totalMinor ||
        (await options.authorize(tx, {
          ...query,
          brandReference: brand,
          storeReference: store,
        })) !== true
      )
        return fail();
      return Object.freeze({
        cancelledTotalMinor,
        snapshotDigest:
          "sha256:" +
          createHash("sha256")
            .update(
              JSON.stringify([
                brand,
                store,
                query.orderReference,
                base.snapshotDigest,
                position?.snapshotDigest ?? null,
                evidence,
              ]),
            )
            .digest("hex"),
      });
    } catch {
      return fail();
    }
  };
}
