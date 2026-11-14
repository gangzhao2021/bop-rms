import type { ConsumerTransaction } from "@bop/eventing";
import { parseOrderingReference, parseOrderingInstant } from "../../domain/cart.js";
import {
  decodeOrderItemSnapshot,
  decodeConfiguredOrderItemSnapshot,
} from "../../domain/order-item-snapshot-codec.js";
const fail = (): never => {
  throw new Error("ORDER_REFUND_BASIS_UNAVAILABLE");
};
interface Query {
  readonly orderReference: string;
  readonly orderBatchReference: string;
  readonly submissionReference: string;
  readonly quoteReference: string;
  readonly observedAt: string;
}
/** Immutable financial membership only, never current Order readiness/authority.
 * No note, Actor, allergy, catalog text or current-state inference is returned. */
export function createPostgresOrderRefundBasisReader(options: {
  readonly brandReference: string;
  readonly storeReference: string;
  readonly authorize: (
    tx: ConsumerTransaction,
    query: Query & {
      readonly brandReference: string;
      readonly storeReference: string;
    },
  ) => Promise<boolean>;
}) {
  const brandReference = String(parseOrderingReference(options.brandReference));
  const storeReference = String(parseOrderingReference(options.storeReference));
  return {
    async load(tx: ConsumerTransaction, value: Query) {
      const query = {
        brandReference,
        storeReference,
        orderReference: String(parseOrderingReference(value.orderReference)),
        orderBatchReference: String(parseOrderingReference(value.orderBatchReference)),
        submissionReference: String(parseOrderingReference(value.submissionReference)),
        quoteReference: String(parseOrderingReference(value.quoteReference)),
        observedAt: parseOrderingInstant(value.observedAt),
      };
      const authorize = async () => {
        if ((await options.authorize(tx, query)) !== true) return fail();
      };
      await authorize();
      await tx.query(
        "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
        [brandReference, storeReference],
      );
      const result = await tx.query(
        "SELECT s.submission_kind,b.source_cart_id::text AS cart,b.source_cart_version::text AS cart_version," +
          "b.submitted_at,i.ordinal,i.order_item_id::text AS item,i.source_cart_line_id::text AS cart_item,i.quantity," +
          "i.quote_input_digest AS quote_digest,i.transaction_snapshot_json AS snapshot," +
          "i.transaction_snapshot_json->'pricing'->>'quoteVersion' AS quote_version " +
          "FROM rms_ordering.order_batch b " +
          "JOIN rms_ordering.order_submission_record s ON s.brand_id=b.brand_id AND s.store_id=b.store_id AND s.order_id=b.order_id AND s.submission_id=b.submission_id " +
          "LEFT JOIN rms_ordering.order_item i ON i.brand_id=b.brand_id AND i.store_id=b.store_id AND i.order_id=b.order_id AND i.order_batch_id=b.order_batch_id " +
          "WHERE b.brand_id=$1 AND b.store_id=$2 AND b.order_id=$3 AND b.order_batch_id=$4 AND b.submission_id=$5 AND b.quote_id=$6 " +
          "ORDER BY i.ordinal LIMIT 1001",
        [
          brandReference,
          storeReference,
          query.orderReference,
          query.orderBatchReference,
          query.submissionReference,
          query.quoteReference,
        ],
      );
      if (result.rows.length < 1 || result.rows.length > 1000) return fail();
      const seen = new Set<string>();
      let common:
        | {
            cartReference: string;
            cartVersion: number;
            quoteVersion: 1 | 2;
            quoteInputDigest: string;
          }
        | undefined;
      const items = result.rows.map((row, index) => {
        if (
          (row.submission_kind !== "Initial" && row.submission_kind !== "Additional") ||
          row.ordinal !== index + 1 ||
          (row.quote_version !== "1" && row.quote_version !== "2")
        )
          return fail();
        const snapshot = (
          row.quote_version === "2" ? decodeConfiguredOrderItemSnapshot : decodeOrderItemSnapshot
        )(row.snapshot);
        const submittedAt = parseOrderingInstant(
          row.submitted_at instanceof Date ? row.submitted_at.toISOString() : row.submitted_at,
        );
        if (
          snapshot.orderBatchReference !== query.orderBatchReference ||
          snapshot.orderItemReference !== row.item ||
          snapshot.cartItemReference !== row.cart_item ||
          snapshot.quantity !== row.quantity ||
          snapshot.pricing.quoteReference !== query.quoteReference ||
          snapshot.pricing.quoteInputDigest !== row.quote_digest ||
          snapshot.snapshotCapturedAt > submittedAt ||
          submittedAt > query.observedAt ||
          seen.has(snapshot.orderItemReference)
        )
          return fail();
        seen.add(snapshot.orderItemReference);
        const cartReference = String(parseOrderingReference(row.cart));
        if (
          typeof row.cart_version !== "string" ||
          !/^[1-9][0-9]*$/u.test(row.cart_version) ||
          !Number.isSafeInteger(Number(row.cart_version))
        )
          return fail();
        const identity = {
          cartReference,
          cartVersion: Number(row.cart_version),
          quoteVersion: snapshot.pricing.quoteVersion,
          quoteInputDigest: String(snapshot.pricing.quoteInputDigest),
        };
        if (
          common &&
          (common.cartReference !== identity.cartReference ||
            common.cartVersion !== identity.cartVersion ||
            common.quoteVersion !== identity.quoteVersion ||
            common.quoteInputDigest !== identity.quoteInputDigest)
        )
          return fail();
        common = identity;
        return Object.freeze({
          orderItemReference: String(snapshot.orderItemReference),
          quantity: snapshot.quantity,
          quoteLineReference: String(snapshot.pricing.lineReference),
          subtotalMinor: snapshot.pricing.subtotal.amountMinor,
          discountMinor: snapshot.pricing.discount.amountMinor,
          taxMinor: snapshot.pricing.tax.amountMinor,
          feeMinor: snapshot.pricing.fee.amountMinor,
          totalMinor: snapshot.pricing.total.amountMinor,
        });
      });
      if (!common) return fail();
      await authorize();
      return Object.freeze({ ...query, ...common, items: Object.freeze(items) });
    },
  };
}
