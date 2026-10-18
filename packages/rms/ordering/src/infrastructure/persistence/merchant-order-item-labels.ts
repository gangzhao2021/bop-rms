import type { ConsumerTransaction } from "@bop/eventing";
import { parseOrderingReference } from "../../domain/cart.js";
const fail = (): never => {
  throw new Error("MERCHANT_ORDER_LABELS_UNAVAILABLE");
};
/** Immutable display fields only; caller retains current Order fences and permission. */
export function createPostgresMerchantOrderItemLabels(options: {
  brandReference: string;
  storeReference: string;
  locale: string;
  authorize(tx: ConsumerTransaction, orderReference: string): Promise<boolean>;
}) {
  const brand = parseOrderingReference(options.brandReference),
    store = parseOrderingReference(options.storeReference);
  if (!/^[a-z]{2}(?:-[A-Z]{2})?$/.test(options.locale)) return fail();
  return {
    async load(input: { transaction: ConsumerTransaction; orderReference: string }) {
      const order = parseOrderingReference(input.orderReference),
        tx = input.transaction;
      if ((await options.authorize(tx, order)) !== true) return fail();
      await tx.query(
        "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
        [brand, store],
      );
      const result = await tx.query(
        "SELECT i.order_item_id,i.order_batch_id,i.ordinal,i.transaction_snapshot_json->'catalog'->'localizedNames'->$4 AS display_name,s.submission_kind,a.batch_sequence FROM rms_ordering.order_item i JOIN rms_ordering.order_batch b ON b.brand_id=i.brand_id AND b.store_id=i.store_id AND b.order_id=i.order_id AND b.order_batch_id=i.order_batch_id JOIN rms_ordering.order_submission_record s ON s.brand_id=b.brand_id AND s.store_id=b.store_id AND s.order_id=b.order_id AND s.submission_id=b.submission_id LEFT JOIN rms_ordering.additional_dining_batch_record a ON a.brand_id=b.brand_id AND a.store_id=b.store_id AND a.order_id=b.order_id AND a.order_batch_id=b.order_batch_id AND a.submission_id=b.submission_id WHERE i.brand_id=$1 AND i.store_id=$2 AND i.order_id=$3 ORDER BY i.order_batch_id,i.ordinal LIMIT 10001",
        [brand, store, order, options.locale],
      );
      if (result.rows.length > 10000) return fail();
      const seen = new Set<string>(),
        ordinals = new Set<string>(),
        sequences = new Map<number, string>();
      const items = result.rows.map((row) => {
        const orderItemReference = parseOrderingReference(row.order_item_id),
          orderBatchReference = parseOrderingReference(row.order_batch_id);
        const sequence =
          row.submission_kind === "Initial" && row.batch_sequence === null
            ? 1
            : row.submission_kind === "Additional"
              ? row.batch_sequence
              : null;
        if (
          seen.has(orderItemReference) ||
          typeof sequence !== "number" ||
          !Number.isSafeInteger(sequence) ||
          sequence < (row.submission_kind === "Additional" ? 2 : 1) ||
          typeof row.ordinal !== "number" ||
          !Number.isSafeInteger(row.ordinal) ||
          row.ordinal < 1 ||
          row.ordinal > 100 ||
          typeof row.display_name !== "string" ||
          row.display_name.length < 1 ||
          row.display_name.length > 240 ||
          Array.from(row.display_name).some(
            (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
          ) ||
          ordinals.has(orderBatchReference + ":" + row.ordinal) ||
          (sequences.has(sequence) && sequences.get(sequence) !== orderBatchReference)
        )
          return fail();
        seen.add(orderItemReference);
        ordinals.add(orderBatchReference + ":" + row.ordinal);
        sequences.set(sequence, orderBatchReference);
        return Object.freeze({
          orderItemReference,
          orderBatchReference,
          batchSequence: sequence,
          itemOrdinal: row.ordinal,
          displayName: row.display_name,
        });
      });
      if ((await options.authorize(tx, order)) !== true) return fail();
      return Object.freeze(
        items.sort((a, b) => a.batchSequence - b.batchSequence || a.itemOrdinal - b.itemOrdinal),
      );
    },
  };
}
