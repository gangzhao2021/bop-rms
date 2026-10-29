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
  /**
   * Owner 2026-10-24: the staff member's chosen language for item names (for example
   * zh-Hans-CA), used where the item has a name in it; otherwise `locale` (the Store's).
   */
  preferredLocale?: string | null;
  authorize(tx: ConsumerTransaction, orderReference: string): Promise<boolean>;
}) {
  const brand = parseOrderingReference(options.brandReference),
    store = parseOrderingReference(options.storeReference);
  if (!/^[a-z]{2}(?:-[A-Z]{2})?$/.test(options.locale)) return fail();
  const preferred = options.preferredLocale ?? null;
  if (preferred !== null && !/^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-[A-Z]{2}|\d{3})?$/.test(preferred))
    return fail();
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
        "SELECT i.order_item_id,i.order_batch_id,i.ordinal,COALESCE(NULLIF(i.transaction_snapshot_json->'catalog'->'localizedNames'->>$5,''),i.transaction_snapshot_json->'catalog'->'localizedNames'->>$4) AS display_name,s.submission_kind,a.batch_sequence FROM rms_ordering.order_item i JOIN rms_ordering.order_batch b ON b.brand_id=i.brand_id AND b.store_id=i.store_id AND b.order_id=i.order_id AND b.order_batch_id=i.order_batch_id JOIN rms_ordering.order_submission_record s ON s.brand_id=b.brand_id AND s.store_id=b.store_id AND s.order_id=b.order_id AND s.submission_id=b.submission_id LEFT JOIN rms_ordering.additional_dining_batch_record a ON a.brand_id=b.brand_id AND a.store_id=b.store_id AND a.order_id=b.order_id AND a.order_batch_id=b.order_batch_id AND a.submission_id=b.submission_id WHERE i.brand_id=$1 AND i.store_id=$2 AND i.order_id=$3 ORDER BY i.order_batch_id,i.ordinal LIMIT 10001",
        [brand, store, order, options.locale, preferred],
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

/**
 * WP-2423 item 8 ⑦ (Owner decision 2): the lines of one menu item (sellable) on an Order, in the order
 * they were sent, each with whether staff took it off (its line or its whole round cancelled) —
 * for the per-head tea charge, which follows the table's party size. Caller holds the Order's
 * current fences and permission; the Brand and Store context is set here.
 */
export async function listOrderSkuLines(
  tx: ConsumerTransaction,
  scope: { readonly brandReference: string; readonly storeReference: string },
  input: { readonly orderReference: string; readonly sellableReference: string },
): Promise<{
  /** The Order's current version (what a change of its lines is made against). */
  readonly orderVersion: number;
  readonly lines: readonly {
    readonly orderItemReference: string;
    readonly orderBatchReference: string;
    readonly quantity: number;
    readonly takenOff: boolean;
  }[];
}> {
  const brand = parseOrderingReference(scope.brandReference),
    store = parseOrderingReference(scope.storeReference);
  const order = parseOrderingReference(input.orderReference),
    sku = parseOrderingReference(input.sellableReference);
  await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
    brand,
    store,
  ]);
  const result = await tx.query(
    "SELECT i.order_item_id::text AS item,i.order_batch_id::text AS batch,i.quantity," +
      "(EXISTS (SELECT 1 FROM rms_ordering.order_item_staff_cancellation c WHERE c.brand_id=i.brand_id AND c.store_id=i.store_id AND c.order_id=i.order_id AND c.order_batch_id=i.order_batch_id AND i.order_item_id=ANY(c.order_item_ids))" +
      " OR EXISTS (SELECT 1 FROM rms_ordering.order_staff_cancellation s WHERE s.brand_id=i.brand_id AND s.store_id=i.store_id AND s.order_batch_id=i.order_batch_id)" +
      " OR EXISTS (SELECT 1 FROM rms_ordering.order_batch_checkout_cancellation x WHERE x.brand_id=i.brand_id AND x.store_id=i.store_id AND x.order_batch_id=i.order_batch_id)) AS taken_off" +
      " FROM rms_ordering.order_item i JOIN rms_ordering.order_batch b ON b.brand_id=i.brand_id AND b.store_id=i.store_id AND b.order_id=i.order_id AND b.order_batch_id=i.order_batch_id" +
      " WHERE i.brand_id=$1 AND i.store_id=$2 AND i.order_id=$3 AND i.transaction_snapshot_json->'catalog'->>'sellableReference'=$4" +
      " ORDER BY b.order_batch_id,i.order_item_id LIMIT 1001",
    [brand, store, order, sku],
  );
  const rows = (result as { rows?: unknown }).rows;
  if (!Array.isArray(rows) || rows.length > 1000) return fail();
  const version = (
    (await tx.query(
      "SELECT max(version)::int AS version FROM rms_ordering.order_revision WHERE brand_id=$1 AND store_id=$2 AND order_id=$3",
      [brand, store, order],
    )) as unknown as { rows?: readonly { version?: unknown }[] }
  ).rows?.[0]?.version;
  const orderVersion = Number(version);
  if (!Number.isSafeInteger(orderVersion) || orderVersion < 1) return fail();
  const lines = Object.freeze(
    rows.map((row: Record<string, unknown>) => {
      const quantity = Number(row.quantity);
      if (!Number.isSafeInteger(quantity) || quantity < 1 || typeof row.taken_off !== "boolean")
        return fail();
      return Object.freeze({
        orderItemReference: String(parseOrderingReference(row.item)),
        orderBatchReference: String(parseOrderingReference(row.batch)),
        quantity,
        takenOff: row.taken_off,
      });
    }),
  );
  return Object.freeze({ orderVersion, lines });
}
