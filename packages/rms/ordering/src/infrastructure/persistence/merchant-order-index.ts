import type { ConsumerTransaction } from "@bop/eventing";
import { parseOrderingReference, parseOrderingInstant } from "../../domain/cart.js";

const unavailable = (): never => {
  throw new Error("MERCHANT_ORDER_INDEX_UNAVAILABLE");
};
/** Owner-local discovery only. Initial header fields are not current phase, version or permission. */
export function createPostgresMerchantOrderIndex(options: {
  brandReference: string;
  storeReference: string;
  authorize(
    transaction: ConsumerTransaction,
    scope: Readonly<{ brandReference: string; storeReference: string }>,
  ): Promise<boolean>;
}) {
  const scope = Object.freeze({
    brandReference: parseOrderingReference(options.brandReference),
    storeReference: parseOrderingReference(options.storeReference),
  });
  return Object.freeze({
    async find(input: { transaction: ConsumerTransaction; orderReference: string }) {
      const orderReference = parseOrderingReference(input.orderReference);
      const tx = input.transaction;
      if ((await options.authorize(tx, scope)) !== true) return unavailable();
      await tx.query(
        "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
        [scope.brandReference, scope.storeReference],
      );
      const result = await tx.query(
        "SELECT h.order_id,h.brand_id,h.store_id,h.order_type,h.dining_session_id,s.guest_session_id,s.submission_id,b.order_batch_id FROM rms_ordering.order_header h " +
          "JOIN rms_ordering.order_submission_record s ON s.order_id=h.order_id AND s.brand_id=h.brand_id AND s.store_id=h.store_id AND s.submission_kind='Initial' " +
          "JOIN rms_ordering.order_batch b ON b.order_id=h.order_id AND b.brand_id=h.brand_id AND b.store_id=h.store_id AND b.submission_id=s.submission_id " +
          "WHERE h.brand_id=$1 AND h.store_id=$2 AND h.order_id=$3 LIMIT 2",
        [scope.brandReference, scope.storeReference, orderReference],
      );
      if ((await options.authorize(tx, scope)) !== true) return unavailable();
      if (result.rows.length === 0) return null;
      const row = result.rows[0];
      if (
        result.rows.length !== 1 ||
        !row ||
        row.order_id !== orderReference ||
        row.brand_id !== scope.brandReference ||
        row.store_id !== scope.storeReference ||
        (row.order_type !== "DineIn" && row.order_type !== "Pickup")
      )
        return unavailable();
      return Object.freeze({
        orderReference,
        orderType: row.order_type as "DineIn" | "Pickup",
        diningSessionReference:
          row.order_type === "DineIn" ? parseOrderingReference(row.dining_session_id) : null,
        guestSessionReference: parseOrderingReference(row.guest_session_id),
        initialSubmissionReference: parseOrderingReference(row.submission_id),
        initialBatchReference: parseOrderingReference(row.order_batch_id),
      });
    },
    async list(input: {
      transaction: ConsumerTransaction;
      afterOrderReference: string | null;
      limit: number;
      /**
       * WP-2423: the operations queue lists the newest Orders first and pages back to older ones, so
       * the current day's Orders are never behind earlier days'. Complete scans keep the default.
       */
      newestFirst?: boolean;
    }) {
      const newest = input.newestFirst === true;
      if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100)
        return unavailable();
      const after =
        input.afterOrderReference === null
          ? null
          : parseOrderingReference(input.afterOrderReference);
      const tx = input.transaction;
      if ((await options.authorize(tx, scope)) !== true) return unavailable();
      await tx.query(
        "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
        [scope.brandReference, scope.storeReference],
      );
      const result = await tx.query(
        "SELECT h.order_id,h.brand_id,h.store_id,h.order_number,h.order_type,h.source_channel,h.created_at," +
          "s.submission_id,b.order_batch_id FROM rms_ordering.order_header h " +
          "JOIN rms_ordering.order_submission_record s ON s.order_id=h.order_id AND s.brand_id=h.brand_id AND s.store_id=h.store_id AND s.submission_kind='Initial' " +
          "JOIN rms_ordering.order_batch b ON b.order_id=h.order_id AND b.brand_id=h.brand_id AND b.store_id=h.store_id AND b.submission_id=s.submission_id " +
          "WHERE h.brand_id=$1 AND h.store_id=$2 AND ($3::uuid IS NULL OR " +
          (newest ? "h.order_id<$3::uuid) " : "h.order_id>$3::uuid) ") +
          (newest ? "ORDER BY h.order_id DESC LIMIT $4" : "ORDER BY h.order_id LIMIT $4"),
        [scope.brandReference, scope.storeReference, after, input.limit + 1],
      );
      if (result.rows.length > input.limit + 1) return unavailable();
      let previous = after;
      const items = result.rows.map((row) => {
        const orderReference = parseOrderingReference(row.order_id);
        if (
          row.brand_id !== scope.brandReference ||
          row.store_id !== scope.storeReference ||
          (previous !== null &&
            (newest ? orderReference >= previous : orderReference <= previous)) ||
          typeof row.order_number !== "string" ||
          !/^[A-Z0-9][A-Z0-9-]{0,39}$/.test(row.order_number) ||
          (row.order_type !== "DineIn" && row.order_type !== "Pickup") ||
          !["Api", "Pos", "Qr", "Web"].includes(String(row.source_channel))
        )
          return unavailable();
        previous = orderReference;
        return Object.freeze({
          orderReference,
          orderNumber: row.order_number,
          orderType: row.order_type as "DineIn" | "Pickup",
          sourceChannel: row.source_channel as "Api" | "Pos" | "Qr" | "Web",
          submittedAt: parseOrderingInstant(
            row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
          ),
          initialSubmissionReference: parseOrderingReference(row.submission_id),
          initialBatchReference: parseOrderingReference(row.order_batch_id),
        });
      });
      if ((await options.authorize(tx, scope)) !== true) return unavailable();
      const page = Object.freeze(items.slice(0, input.limit));
      const last = page[page.length - 1];
      if (items.length > input.limit && last === undefined) return unavailable();
      return Object.freeze({
        items: page,
        nextAfterOrderReference: items.length > input.limit ? (last?.orderReference ?? null) : null,
      });
    },
  });
}

/**
 * WP-2423: the order numbers staff and customers use for the given Orders of the Store (e.g. on
 * pickup cards). Orders of other Stores are not returned. Caller authorizes and owns the
 * transaction.
 */
export async function listStoreOrderNumbers(
  transaction: ConsumerTransaction,
  scope: { readonly brandReference: string; readonly storeReference: string },
  orderReferences: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  if (orderReferences.length === 0) return new Map();
  if (orderReferences.length > 100) throw new Error("MERCHANT_ORDER_INDEX_UNAVAILABLE");
  const orders = orderReferences.map((reference) => parseOrderingReference(reference));
  await transaction.query(
    "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
    [scope.brandReference, scope.storeReference],
  );
  const rows = (
    await transaction.query(
      "SELECT order_id::text order_id,order_number FROM rms_ordering.order_header WHERE brand_id=$1 AND store_id=$2 AND order_id=ANY($3::uuid[])",
      [scope.brandReference, scope.storeReference, orders],
    )
  ).rows as readonly { order_id: string; order_number: unknown }[];
  return new Map(
    rows
      .filter((row) => typeof row.order_number === "string")
      .map((row) => [row.order_id, row.order_number as string]),
  );
}
