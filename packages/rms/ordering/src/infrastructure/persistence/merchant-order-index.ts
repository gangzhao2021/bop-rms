import type { ConsumerTransaction } from "@bop/eventing";
import { parseOrderingReference, parseOrderingInstant } from "../../domain/cart.js";
import {
  decodeConfiguredOrderItemSnapshot,
  decodeOrderItemSnapshot,
} from "../../domain/order-item-snapshot-codec.js";

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
      /** WP-2423 OPS-ORDER-DETAIL: only this Order of the Store (an empty page when not here). */
      onlyOrderReference?: string;
    }) {
      const newest = input.newestFirst === true;
      if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100)
        return unavailable();
      const after =
        input.afterOrderReference === null
          ? null
          : parseOrderingReference(input.afterOrderReference);
      const only =
        input.onlyOrderReference === undefined
          ? null
          : parseOrderingReference(input.onlyOrderReference);
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
          "AND ($5::uuid IS NULL OR h.order_id=$5::uuid) " +
          (newest ? "ORDER BY h.order_id DESC LIMIT $4" : "ORDER BY h.order_id LIMIT $4"),
        [scope.brandReference, scope.storeReference, after, input.limit + 1, only],
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

export interface MerchantOrderLineMoney {
  readonly amountMinor: string;
  readonly currencyCode: string;
}
export interface MerchantOrderLine {
  readonly orderItemReference: string;
  readonly orderBatchReference: string;
  readonly name: string;
  readonly options: readonly { readonly name: string; readonly quantity: number }[];
  readonly quantity: number;
  /** The customer's note for the kitchen (may describe allergies: show, never log). */
  readonly customerNote: string | null;
  readonly unitPrice: MerchantOrderLineMoney;
  readonly subtotal: MerchantOrderLineMoney;
  readonly discount: MerchantOrderLineMoney;
  readonly tax: MerchantOrderLineMoney;
  readonly fee: MerchantOrderLineMoney;
  readonly total: MerchantOrderLineMoney;
}

/**
 * WP-2423 OPS-ORDER-DETAIL: what was ordered — each item's immutable snapshot (name and options in
 * the locale, quantity, the customer's note and the priced amounts) in batch and line order, with
 * the Order's totals. Read only; caller authorizes and owns the transaction. Null when the Order is
 * not this Store's.
 */
export async function loadMerchantOrderLines(
  transaction: ConsumerTransaction,
  scope: { readonly brandReference: string; readonly storeReference: string },
  orderReference: string,
  locale: string,
): Promise<{
  readonly items: readonly MerchantOrderLine[];
  readonly totals: Readonly<
    Record<"subtotal" | "discount" | "tax" | "fee" | "total", MerchantOrderLineMoney>
  >;
} | null> {
  const order = parseOrderingReference(orderReference);
  await transaction.query(
    "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
    [scope.brandReference, scope.storeReference],
  );
  const rows = (
    await transaction.query(
      "SELECT i.transaction_snapshot_json,i.transaction_snapshot_json#>>'{pricing,quoteVersion}' AS quote_version " +
        "FROM rms_ordering.order_item i JOIN rms_ordering.order_batch b ON b.brand_id=i.brand_id AND " +
        "b.store_id=i.store_id AND b.order_id=i.order_id AND b.order_batch_id=i.order_batch_id " +
        "WHERE i.brand_id=$1 AND i.store_id=$2 AND i.order_id=$3 " +
        "ORDER BY b.submitted_at,b.order_batch_id,i.ordinal LIMIT 101",
      [scope.brandReference, scope.storeReference, order],
    )
  ).rows;
  if (rows.length === 0) return null;
  if (rows.length > 100) return unavailable();
  const name = (names: Readonly<Record<string, string>>) =>
    names[locale] ?? names[locale.slice(0, 2)] ?? Object.values(names)[0] ?? "";
  const money = (value: { readonly amountMinor: bigint; readonly currencyCode: string }) =>
    Object.freeze({ amountMinor: String(value.amountMinor), currencyCode: value.currencyCode });
  const sums = { subtotal: 0n, discount: 0n, tax: 0n, fee: 0n, total: 0n };
  let currency: string | null = null;
  const items = rows.map((row) => {
    if (row.quote_version !== "1" && row.quote_version !== "2") return unavailable();
    const snapshot =
      row.quote_version === "2"
        ? decodeConfiguredOrderItemSnapshot(row.transaction_snapshot_json)
        : decodeOrderItemSnapshot(row.transaction_snapshot_json);
    const pricing = snapshot.pricing;
    for (const key of Object.keys(sums) as (keyof typeof sums)[]) {
      if ((currency ??= pricing[key].currencyCode) !== pricing[key].currencyCode)
        return unavailable();
      sums[key] += pricing[key].amountMinor;
    }
    return Object.freeze({
      orderItemReference: String(snapshot.orderItemReference),
      orderBatchReference: String(snapshot.orderBatchReference),
      name: name(snapshot.catalog.localizedNames),
      options: Object.freeze(
        snapshot.catalog.options.map((option) =>
          Object.freeze({ name: name(option.localizedNames), quantity: option.quantity }),
        ),
      ),
      quantity: snapshot.quantity,
      customerNote: snapshot.customerNote,
      unitPrice: money(pricing.unitPrice),
      subtotal: money(pricing.subtotal),
      discount: money(pricing.discount),
      tax: money(pricing.tax),
      fee: money(pricing.fee),
      total: money(pricing.total),
    });
  });
  const code = currency ?? unavailable();
  const total = (key: keyof typeof sums) =>
    Object.freeze({ amountMinor: String(sums[key]), currencyCode: code });
  return Object.freeze({
    items: Object.freeze(items),
    totals: Object.freeze({
      subtotal: total("subtotal"),
      discount: total("discount"),
      tax: total("tax"),
      fee: total("fee"),
      total: total("total"),
    }),
  });
}

/**
 * WP-2423: Orders of the Store that were paid but can no longer be fulfilled (not accepted before
 * capacity expired, submission cancelled, or no longer fulfillable). Payment refunds them through
 * compensation; staff must not be offered to accept them. Caller authorizes and owns the
 * transaction.
 */
export async function listStoreUnfulfillablePaidOrders(
  transaction: ConsumerTransaction,
  scope: { readonly brandReference: string; readonly storeReference: string },
  orderReferences: readonly string[],
): Promise<
  ReadonlyMap<string, "CapacityExpired" | "SubmissionCancelled" | "OrderNoLongerFulfillable">
> {
  if (orderReferences.length === 0) return new Map();
  if (orderReferences.length > 100) throw new Error("MERCHANT_ORDER_INDEX_UNAVAILABLE");
  const orders = orderReferences.map((reference) => parseOrderingReference(reference));
  await transaction.query(
    "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
    [scope.brandReference, scope.storeReference],
  );
  const rows = (
    await transaction.query(
      "SELECT DISTINCT ON (order_id) order_id::text order_id,reason FROM rms_ordering.order_payment_disposition_record " +
        "WHERE brand_id=$1 AND store_id=$2 AND order_id=ANY($3::uuid[]) AND disposition='PaidWithoutFulfillableOrder' " +
        "ORDER BY order_id,evaluated_at DESC",
      [scope.brandReference, scope.storeReference, orders],
    )
  ).rows as readonly { order_id: string; reason: unknown }[];
  const reasons = ["CapacityExpired", "SubmissionCancelled", "OrderNoLongerFulfillable"] as const;
  return new Map(
    rows.flatMap((row) =>
      reasons.includes(row.reason as (typeof reasons)[number])
        ? [[row.order_id, row.reason as (typeof reasons)[number]] as const]
        : [],
    ),
  );
}

/**
 * WP-2423 Q1: which of the Store's Orders have a recorded payment, and which batches are paid and
 * waiting for staff acceptance (payment recorded as awaiting acceptance, no outcome yet). An Order
 * with neither is still awaiting the customer's payment and is not offered for acceptance. Caller
 * authorizes and owns the transaction.
 */
export async function listStorePaidOrderBatches(
  transaction: ConsumerTransaction,
  scope: { readonly brandReference: string; readonly storeReference: string },
  orderReferences: readonly string[],
): Promise<{
  readonly paidOrders: ReadonlySet<string>;
  readonly awaitingAcceptance: ReadonlySet<string>;
}> {
  if (orderReferences.length === 0) return { paidOrders: new Set(), awaitingAcceptance: new Set() };
  if (orderReferences.length > 100) throw new Error("MERCHANT_ORDER_INDEX_UNAVAILABLE");
  const orders = orderReferences.map((reference) => parseOrderingReference(reference));
  await transaction.query(
    "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
    [scope.brandReference, scope.storeReference],
  );
  const rows = (
    await transaction.query(
      "SELECT w.order_id::text order_id,w.order_batch_id::text order_batch_id," +
        "NOT EXISTS (SELECT 1 FROM rms_ordering.order_payment_disposition_record d WHERE d.brand_id=w.brand_id " +
        "AND d.store_id=w.store_id AND d.order_batch_id=w.order_batch_id) awaiting " +
        "FROM rms_ordering.order_payment_acceptance_wait w WHERE w.brand_id=$1 AND w.store_id=$2 AND w.order_id=ANY($3::uuid[]) " +
        "UNION ALL SELECT d.order_id::text,d.order_batch_id::text,false FROM rms_ordering.order_payment_disposition_record d " +
        "WHERE d.brand_id=$1 AND d.store_id=$2 AND d.order_id=ANY($3::uuid[])",
      [scope.brandReference, scope.storeReference, orders],
    )
  ).rows as readonly { order_id: unknown; order_batch_id: unknown; awaiting: unknown }[];
  const paidOrders = new Set<string>(),
    awaitingAcceptance = new Set<string>();
  for (const row of rows) {
    const order = parseOrderingReference(row.order_id),
      batch = parseOrderingReference(row.order_batch_id);
    if (typeof row.awaiting !== "boolean" || !orders.includes(order))
      throw new Error("MERCHANT_ORDER_INDEX_UNAVAILABLE");
    paidOrders.add(order);
    if (row.awaiting) awaitingAcceptance.add(batch);
  }
  return { paidOrders, awaitingAcceptance };
}
