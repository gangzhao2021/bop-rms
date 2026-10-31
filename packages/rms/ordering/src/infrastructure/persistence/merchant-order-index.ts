import type { ConsumerTransaction } from "@bop/eventing";
import { parseOrderingReference, parseOrderingInstant } from "../../domain/cart.js";
import { orderLocalizedName } from "../../domain/order-item-option-lines.js";
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
      /**
       * WP-2423 (2026-10-16): Orders listed elsewhere on the page (earlier-day Orders shown with
       * today's), left out here so each page still holds exactly `limit` other Orders.
       */
      excludeOrderReferences?: readonly string[];
    }) {
      const newest = input.newestFirst === true;
      const excluded = (input.excludeOrderReferences ?? []).map((reference) =>
        parseOrderingReference(reference),
      );
      if (excluded.length > 100) return unavailable();
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
        "SELECT h.order_id,h.brand_id,h.store_id,h.order_number,h.order_type,h.source_channel,h.created_at,h.business_date::text AS business_date," +
          "s.submission_id,b.order_batch_id FROM rms_ordering.order_header h " +
          "JOIN rms_ordering.order_submission_record s ON s.order_id=h.order_id AND s.brand_id=h.brand_id AND s.store_id=h.store_id AND s.submission_kind='Initial' " +
          "JOIN rms_ordering.order_batch b ON b.order_id=h.order_id AND b.brand_id=h.brand_id AND b.store_id=h.store_id AND b.submission_id=s.submission_id " +
          "WHERE h.brand_id=$1 AND h.store_id=$2 AND ($3::uuid IS NULL OR " +
          (newest ? "h.order_id<$3::uuid) " : "h.order_id>$3::uuid) ") +
          "AND ($5::uuid IS NULL OR h.order_id=$5::uuid) AND NOT (h.order_id=ANY($6::uuid[])) " +
          (newest ? "ORDER BY h.order_id DESC LIMIT $4" : "ORDER BY h.order_id LIMIT $4"),
        [scope.brandReference, scope.storeReference, after, input.limit + 1, only, excluded],
      );
      if (result.rows.length > input.limit + 1) return unavailable();
      let previous = after;
      const items = result.rows.map((row) => {
        const orderReference = parseOrderingReference(row.order_id);
        if (
          row.brand_id !== scope.brandReference ||
          row.store_id !== scope.storeReference ||
          excluded.includes(orderReference) ||
          (previous !== null &&
            (newest ? orderReference >= previous : orderReference <= previous)) ||
          typeof row.order_number !== "string" ||
          !/^[A-Z0-9][A-Z0-9-]{0,39}$/.test(row.order_number) ||
          (row.order_type !== "DineIn" && row.order_type !== "Pickup") ||
          !["Api", "Pos", "Qr", "Web"].includes(String(row.source_channel)) ||
          typeof row.business_date !== "string" ||
          !/^\d{4}-\d{2}-\d{2}$/u.test(row.business_date)
        )
          return unavailable();
        previous = orderReference;
        return Object.freeze({
          orderReference,
          orderNumber: row.order_number,
          orderType: row.order_type as "DineIn" | "Pickup",
          sourceChannel: row.source_channel as "Api" | "Pos" | "Qr" | "Web",
          /** WP-2423 Q21: the Store business date the Store resolved when the Order was submitted. */
          businessDate: row.business_date as string,
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

/**
 * WP-2423: which of the given Orders of the Store staff took at the counter (source channel `Pos`).
 * The customer is standing at the counter, so no guest pickup code is sent and staff hand the
 * order over in person. Orders of other Stores and unknown Orders are not returned. Caller
 * authorizes and owns the transaction.
 */
export async function listStoreCounterOrders(
  transaction: ConsumerTransaction,
  scope: { readonly brandReference: string; readonly storeReference: string },
  orderReferences: readonly string[],
): Promise<ReadonlySet<string>> {
  if (orderReferences.length === 0) return new Set();
  if (orderReferences.length > 100) throw new Error("MERCHANT_ORDER_INDEX_UNAVAILABLE");
  const orders = orderReferences.map((reference) => String(parseOrderingReference(reference)));
  await transaction.query(
    "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
    [scope.brandReference, scope.storeReference],
  );
  const rows = (
    await transaction.query(
      "SELECT order_id::text order_id FROM rms_ordering.order_header WHERE brand_id=$1 AND store_id=$2 AND order_id=ANY($3::uuid[]) AND source_channel='Pos'",
      [scope.brandReference, scope.storeReference, orders],
    )
  ).rows as readonly { order_id: unknown }[];
  return new Set(
    rows.map((row) => String(row.order_id)).filter((reference) => orders.includes(reference)),
  );
}

/**
 * WP-2423 Q26: the business day each Order belongs to (order numbers restart every business day),
 * so staff screens can tell an earlier day's order from today's with the same number.
 */
export async function listStoreOrderBusinessDates(
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
      "SELECT order_id::text order_id,business_date::text business_date FROM rms_ordering.order_header WHERE brand_id=$1 AND store_id=$2 AND order_id=ANY($3::uuid[])",
      [scope.brandReference, scope.storeReference, orders],
    )
  ).rows as readonly { order_id: string; business_date: unknown }[];
  return new Map(
    rows
      .filter(
        (row) =>
          typeof row.business_date === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(row.business_date),
      )
      .map((row) => [row.order_id, row.business_date as string]),
  );
}

/** WP-2423 D4: one round (Order batch) of a Store Order, as Ordering recorded its submission. */
export interface StoreOrderRoundSubmission {
  readonly orderReference: string;
  /** When the round was submitted (UTC). */
  readonly submittedAt: string;
  /** The Order's first round, submitted with the Order itself. */
  readonly initial: boolean;
  /** The business date the Store resolved when the Order (its first round) was submitted. */
  readonly orderBusinessDate: string;
}

/**
 * WP-2423 D4: each given round (Order batch) of the Store — its Order, when it was submitted,
 * whether it is the Order's first round and the Order's business date. A table's later round can
 * be submitted on a later business day than the Order was opened; callers derive that round's
 * business date from `submittedAt` with the Store's business-date configuration. Rounds of other
 * Stores are not returned. Caller authorizes and owns the transaction.
 */
export async function listStoreOrderRoundSubmissions(
  transaction: ConsumerTransaction,
  scope: { readonly brandReference: string; readonly storeReference: string },
  orderBatchReferences: readonly string[],
): Promise<ReadonlyMap<string, StoreOrderRoundSubmission>> {
  if (orderBatchReferences.length === 0) return new Map();
  if (orderBatchReferences.length > 100) throw new Error("MERCHANT_ORDER_INDEX_UNAVAILABLE");
  const batches = orderBatchReferences.map((reference) => parseOrderingReference(reference));
  await transaction.query(
    "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
    [scope.brandReference, scope.storeReference],
  );
  const rows = (
    await transaction.query(
      "SELECT b.order_batch_id::text batch_id,b.order_id::text order_id,b.submitted_at," +
        "h.business_date::text business_date,(s.submission_kind='Initial') initial " +
        "FROM rms_ordering.order_batch b JOIN rms_ordering.order_header h ON h.order_id=b.order_id " +
        "AND h.brand_id=b.brand_id AND h.store_id=b.store_id " +
        "JOIN rms_ordering.order_submission_record s ON s.submission_id=b.submission_id " +
        "AND s.order_id=b.order_id AND s.brand_id=b.brand_id AND s.store_id=b.store_id " +
        "WHERE b.brand_id=$1 AND b.store_id=$2 AND b.order_batch_id=ANY($3::uuid[])",
      [scope.brandReference, scope.storeReference, batches],
    )
  ).rows as readonly Record<string, unknown>[];
  const rounds = new Map<string, StoreOrderRoundSubmission>();
  for (const row of rows) {
    const submittedAt =
      row.submitted_at instanceof Date ? row.submitted_at.toISOString() : row.submitted_at;
    if (
      typeof row.batch_id !== "string" ||
      typeof row.order_id !== "string" ||
      typeof row.initial !== "boolean" ||
      typeof row.business_date !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/u.test(row.business_date)
    )
      throw new Error("MERCHANT_ORDER_INDEX_UNAVAILABLE");
    rounds.set(
      row.batch_id,
      Object.freeze({
        orderReference: row.order_id,
        submittedAt: parseOrderingInstant(submittedAt),
        initial: row.initial,
        orderBusinessDate: row.business_date,
      }),
    );
  }
  return rounds;
}

/**
 * WP-2423 D4: Orders opened on an earlier business day (a table session left open, or open past
 * the day's end) that had a round submitted at or after `since` — the start of the Store's current
 * business day — latest round first. Such an Order is today's work, so the Orders page lists it
 * with today's orders. Caller authorizes and owns the transaction.
 */
export async function listStoreOrdersWithRoundsSince(
  transaction: ConsumerTransaction,
  scope: { readonly brandReference: string; readonly storeReference: string },
  input: { readonly since: string; readonly businessDate: string; readonly limit: number },
): Promise<readonly { readonly orderReference: string; readonly latestRoundAt: string }[]> {
  const since = parseOrderingInstant(input.since);
  if (
    !/^\d{4}-\d{2}-\d{2}$/u.test(input.businessDate) ||
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > 100
  )
    throw new Error("MERCHANT_ORDER_INDEX_UNAVAILABLE");
  await transaction.query(
    "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
    [scope.brandReference, scope.storeReference],
  );
  const rows = (
    await transaction.query(
      "SELECT h.order_id::text order_id,max(b.submitted_at) latest_round_at " +
        "FROM rms_ordering.order_batch b JOIN rms_ordering.order_header h ON h.order_id=b.order_id " +
        "AND h.brand_id=b.brand_id AND h.store_id=b.store_id " +
        "WHERE b.brand_id=$1 AND b.store_id=$2 AND b.submitted_at>=$3::timestamptz " +
        "AND h.business_date<$4::date GROUP BY h.order_id " +
        "ORDER BY max(b.submitted_at) DESC,h.order_id DESC LIMIT $5",
      [scope.brandReference, scope.storeReference, since, input.businessDate, input.limit],
    )
  ).rows as readonly Record<string, unknown>[];
  return Object.freeze(
    rows.map((row) => {
      const at =
        row.latest_round_at instanceof Date
          ? row.latest_round_at.toISOString()
          : row.latest_round_at;
      return Object.freeze({
        orderReference: parseOrderingReference(row.order_id),
        latestRoundAt: parseOrderingInstant(at),
      });
    }),
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
  readonly options: readonly {
    /** WP-2423 item 8 ⑥ part 4: the choice (a combo's dish is served on its own). */
    readonly optionReference: string;
    readonly name: string;
    readonly quantity: number;
  }[];
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
  /**
   * Names in the first of these locales each name has (Owner 2026-10-24: the staff member's
   * chosen language, then the Store's), else any name it has.
   */
  locale: string | readonly string[],
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
  const name = (names: Readonly<Record<string, string>>) => {
    try {
      return orderLocalizedName(names, locale);
    } catch {
      return "";
    }
  };
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
          Object.freeze({
            // WP-2423 item 8 ⑥ part 4: which choice (a combo's dish is served on its own).
            optionReference: String(option.optionReference),
            name: name(option.localizedNames),
            quantity: option.quantity,
          }),
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
 * WP-2423 Q9-G1: a pickup Order closed because it was not accepted in time (Ordering's
 * PaidWithoutFulfillableOrder / CapacityExpired outcome), with the payment it refunds. Caller
 * authorizes and owns the transaction.
 */
export async function loadOrderNotAcceptedClosure(
  transaction: ConsumerTransaction,
  scope: { readonly brandReference: string; readonly storeReference: string },
  orderReference: string,
): Promise<{
  readonly closedAt: string;
  readonly orderReference: string;
  readonly paymentTransactionReference: string;
  readonly paymentAttemptReference: string;
} | null> {
  const order = parseOrderingReference(orderReference);
  await transaction.query(
    "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
    [scope.brandReference, scope.storeReference],
  );
  const rows = (
    await transaction.query(
      "SELECT to_char(evaluated_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') closed_at,payment_transaction_id::text payment_transaction_id,payment_attempt_id::text payment_attempt_id " +
        "FROM rms_ordering.order_payment_disposition_record WHERE brand_id=$1 AND store_id=$2 AND order_id=$3 " +
        "AND disposition='PaidWithoutFulfillableOrder' AND reason='CapacityExpired' ORDER BY evaluated_at DESC LIMIT 2",
      [scope.brandReference, scope.storeReference, order],
    )
  ).rows as readonly {
    closed_at: unknown;
    payment_transaction_id: unknown;
    payment_attempt_id: unknown;
  }[];
  const row = rows[0];
  if (row === undefined) return null;
  if (rows.length > 1) throw new Error("MERCHANT_ORDER_INDEX_UNAVAILABLE");
  return Object.freeze({
    closedAt: String(parseOrderingInstant(row.closed_at)),
    orderReference: String(order),
    paymentTransactionReference: String(parseOrderingReference(row.payment_transaction_id)),
    paymentAttemptReference: String(parseOrderingReference(row.payment_attempt_id)),
  });
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
  /** WP-2423: every batch whose payment Ordering recorded (awaiting acceptance or disposed). */
  readonly paidBatches: ReadonlySet<string>;
  readonly awaitingAcceptance: ReadonlySet<string>;
  /** WP-2423: when Ordering recorded each batch awaiting acceptance as paid (by batch). */
  readonly awaitingSince: ReadonlyMap<string, string>;
}> {
  if (orderReferences.length === 0)
    return {
      paidOrders: new Set(),
      paidBatches: new Set(),
      awaitingAcceptance: new Set(),
      awaitingSince: new Map(),
    };
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
        "AND d.store_id=w.store_id AND d.order_batch_id=w.order_batch_id) " +
        // A never-accepted round staff cancelled (its payment refunded) no longer awaits acceptance.
        "AND NOT EXISTS (SELECT 1 FROM rms_ordering.order_staff_cancellation c WHERE c.brand_id=w.brand_id " +
        "AND c.store_id=w.store_id AND c.order_batch_id=w.order_batch_id) awaiting," +
        "to_char(w.evaluated_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') since " +
        "FROM rms_ordering.order_payment_acceptance_wait w WHERE w.brand_id=$1 AND w.store_id=$2 AND w.order_id=ANY($3::uuid[]) " +
        "UNION ALL SELECT d.order_id::text,d.order_batch_id::text,false,NULL FROM rms_ordering.order_payment_disposition_record d " +
        "WHERE d.brand_id=$1 AND d.store_id=$2 AND d.order_id=ANY($3::uuid[])",
      [scope.brandReference, scope.storeReference, orders],
    )
  ).rows as readonly {
    order_id: unknown;
    order_batch_id: unknown;
    awaiting: unknown;
    since: unknown;
  }[];
  const paidOrders = new Set<string>(),
    paidBatches = new Set<string>(),
    awaitingAcceptance = new Set<string>(),
    awaitingSince = new Map<string, string>();
  for (const row of rows) {
    const order = parseOrderingReference(row.order_id),
      batch = parseOrderingReference(row.order_batch_id);
    if (typeof row.awaiting !== "boolean" || !orders.includes(order))
      throw new Error("MERCHANT_ORDER_INDEX_UNAVAILABLE");
    paidOrders.add(order);
    paidBatches.add(batch);
    if (row.awaiting) {
      if (typeof row.since !== "string") throw new Error("MERCHANT_ORDER_INDEX_UNAVAILABLE");
      awaitingAcceptance.add(batch);
      awaitingSince.set(batch, parseOrderingInstant(row.since));
    }
  }
  return { paidOrders, paidBatches, awaitingAcceptance, awaitingSince };
}

/** WP-2423 (v15 2026-10-16): a Store Order with a paid round still waiting for staff acceptance. */
export interface StoreOrderAwaitingAcceptance {
  readonly orderReference: string;
  readonly orderNumber: string;
  readonly orderType: "Pickup" | "DineIn";
  readonly diningSessionReference: string | null;
}

/**
 * WP-2423 (v15 2026-10-16): the Store's Orders of the current business day with a paid round
 * still waiting for staff acceptance (payment recorded as awaiting acceptance, no outcome, not
 * cancelled by staff), oldest wait first. An Order is today's when it was opened today
 * (`businessDate`, order numbers restart every day) or, D4, when the waiting round was submitted
 * at or after `since` (the start of the Store's current business day). Such an Order has no
 * kitchen work yet, so the kitchen search says it is not accepted yet. Caller authorizes and owns
 * the transaction.
 */
export async function listStoreOrdersAwaitingAcceptance(
  transaction: ConsumerTransaction,
  scope: { readonly brandReference: string; readonly storeReference: string },
  input: { readonly since: string; readonly businessDate: string; readonly limit: number },
): Promise<readonly StoreOrderAwaitingAcceptance[]> {
  const since = parseOrderingInstant(input.since);
  if (
    !/^\d{4}-\d{2}-\d{2}$/u.test(input.businessDate) ||
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > 200
  )
    throw new Error("MERCHANT_ORDER_INDEX_UNAVAILABLE");
  await transaction.query(
    "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
    [scope.brandReference, scope.storeReference],
  );
  const rows = (
    await transaction.query(
      "SELECT h.order_id::text order_id,h.order_number,h.order_type,h.dining_session_id::text dining_session " +
        "FROM rms_ordering.order_payment_acceptance_wait w " +
        "JOIN rms_ordering.order_header h ON h.order_id=w.order_id AND h.brand_id=w.brand_id AND h.store_id=w.store_id " +
        "JOIN rms_ordering.order_batch b ON b.order_batch_id=w.order_batch_id AND b.order_id=w.order_id " +
        "AND b.brand_id=w.brand_id AND b.store_id=w.store_id " +
        "WHERE w.brand_id=$1 AND w.store_id=$2 " +
        "AND (h.business_date=$3::date OR b.submitted_at>=$4::timestamptz) " +
        "AND h.canonical_phase IN ('Submitted','Accepted','InProgress','Ready') " +
        "AND NOT EXISTS (SELECT 1 FROM rms_ordering.order_payment_disposition_record d WHERE d.brand_id=w.brand_id " +
        "AND d.store_id=w.store_id AND d.order_batch_id=w.order_batch_id) " +
        "AND NOT EXISTS (SELECT 1 FROM rms_ordering.order_staff_cancellation c WHERE c.brand_id=w.brand_id " +
        "AND c.store_id=w.store_id AND c.order_batch_id=w.order_batch_id) " +
        "GROUP BY h.order_id,h.order_number,h.order_type,h.dining_session_id " +
        "ORDER BY min(w.evaluated_at),h.order_id LIMIT $5",
      [scope.brandReference, scope.storeReference, input.businessDate, since, input.limit],
    )
  ).rows as readonly Record<string, unknown>[];
  return Object.freeze(
    rows.map((row) => {
      if (
        typeof row.order_number !== "string" ||
        (row.order_type !== "Pickup" && row.order_type !== "DineIn") ||
        (row.order_type === "DineIn") !== (row.dining_session !== null)
      )
        throw new Error("MERCHANT_ORDER_INDEX_UNAVAILABLE");
      return Object.freeze({
        orderReference: parseOrderingReference(row.order_id),
        orderNumber: row.order_number,
        orderType: row.order_type,
        diningSessionReference:
          row.dining_session === null ? null : parseOrderingReference(row.dining_session),
      });
    }),
  );
}

/**
 * WP-2423 Q2: how the kitchen names each Order — its number, type and, for dine-in, the dining
 * session it belongs to. No Customer identity. Caller authorizes and owns the transaction.
 */
export async function listStoreKitchenOrderLabels(
  transaction: ConsumerTransaction,
  scope: { readonly brandReference: string; readonly storeReference: string },
  orderReferences: readonly string[],
): Promise<
  ReadonlyMap<
    string,
    {
      readonly orderNumber: string;
      readonly orderType: "Pickup" | "DineIn";
      readonly diningSessionReference: string | null;
    }
  >
> {
  if (orderReferences.length === 0) return new Map();
  if (orderReferences.length > 200) throw new Error("MERCHANT_ORDER_INDEX_UNAVAILABLE");
  const orders = orderReferences.map((reference) => parseOrderingReference(reference));
  await transaction.query(
    "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
    [scope.brandReference, scope.storeReference],
  );
  const rows = (
    await transaction.query(
      "SELECT order_id::text order_id,order_number,order_type,dining_session_id::text dining_session FROM rms_ordering.order_header " +
        "WHERE brand_id=$1 AND store_id=$2 AND order_id=ANY($3::uuid[])",
      [scope.brandReference, scope.storeReference, orders],
    )
  ).rows as readonly Record<string, unknown>[];
  return new Map(
    rows.map((row) => {
      const order = parseOrderingReference(row.order_id);
      if (
        !orders.includes(order) ||
        typeof row.order_number !== "string" ||
        (row.order_type !== "Pickup" && row.order_type !== "DineIn") ||
        (row.order_type === "DineIn") !== (row.dining_session !== null)
      )
        throw new Error("MERCHANT_ORDER_INDEX_UNAVAILABLE");
      return [
        order,
        Object.freeze({
          orderNumber: row.order_number,
          orderType: row.order_type,
          diningSessionReference:
            row.dining_session === null ? null : parseOrderingReference(row.dining_session),
        }),
      ] as const;
    }),
  );
}

/**
 * WP-2423 Q6: which Batches of the given Orders (at most 100) are paid, captured and accepted
 * (a Confirmed payment disposition and an acceptance). Staff may only cancel such a Batch; whether
 * it is already cancelled or its kitchen work started are separate owner facts. Caller authorizes
 * and owns the transaction.
 */
export async function listStoreConfirmedOrderBatches(
  transaction: ConsumerTransaction,
  scope: { readonly brandReference: string; readonly storeReference: string },
  orderReferences: readonly string[],
): Promise<ReadonlySet<string>> {
  if (orderReferences.length === 0) return new Set();
  if (orderReferences.length > 100) throw new Error("MERCHANT_ORDER_INDEX_UNAVAILABLE");
  const brand = parseOrderingReference(scope.brandReference),
    store = parseOrderingReference(scope.storeReference);
  const orders = orderReferences.map((reference) => parseOrderingReference(reference));
  await transaction.query(
    "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
    [brand, store],
  );
  const rows = (
    await transaction.query(
      "SELECT d.order_id::text order_id,d.order_batch_id::text order_batch_id FROM rms_ordering.order_payment_disposition_record d " +
        "WHERE d.brand_id=$1 AND d.store_id=$2 AND d.order_id=ANY($3::uuid[]) AND d.disposition='Confirmed' " +
        "AND EXISTS (SELECT 1 FROM rms_ordering.order_acceptance_record a WHERE a.brand_id=d.brand_id AND a.store_id=d.store_id " +
        "AND a.order_id=d.order_id AND a.order_batch_id=d.order_batch_id)",
      [brand, store, orders],
    )
  ).rows as readonly { order_id: unknown; order_batch_id: unknown }[];
  const batches = new Set<string>();
  for (const row of rows) {
    const order = parseOrderingReference(row.order_id);
    if (!orders.includes(order)) throw new Error("MERCHANT_ORDER_INDEX_UNAVAILABLE");
    batches.add(parseOrderingReference(row.order_batch_id));
  }
  return batches;
}

/**
 * DEC-TABLE-CLOSE-GUESTS-LEFT: the payment Ordering recorded for each round of one Order — the
 * Confirmed disposition of an accepted round, or the payment still waiting for acceptance — so a
 * manager closing the table sees what each round's cancellation refunds. Rounds with no recorded
 * payment are absent. Read only; the caller authorizes and owns the transaction.
 */
export async function listStoreOrderBatchPayments(
  transaction: ConsumerTransaction,
  scope: { readonly brandReference: string; readonly storeReference: string },
  orderReference: string,
): Promise<
  readonly {
    readonly orderBatchReference: string;
    readonly status: "Confirmed" | "AwaitingAcceptance";
    readonly paymentTransactionReference: string;
    readonly paymentIntentReference: string;
    readonly paymentAttemptReference: string;
  }[]
> {
  const order = parseOrderingReference(orderReference);
  await transaction.query(
    "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
    [scope.brandReference, scope.storeReference],
  );
  const rows = (
    await transaction.query(
      "SELECT d.order_batch_id::text AS batch,'Confirmed' AS status,d.payment_transaction_id::text AS tx,d.payment_intent_id::text AS intent,d.payment_attempt_id::text AS attempt " +
        "FROM rms_ordering.order_payment_disposition_record d WHERE d.brand_id=$1 AND d.store_id=$2 AND d.order_id=$3 AND d.disposition='Confirmed' " +
        "UNION ALL SELECT w.order_batch_id::text,'AwaitingAcceptance',w.record_json->>'paymentTransactionReference',w.record_json->>'paymentIntentReference',w.record_json->>'paymentAttemptReference' " +
        "FROM rms_ordering.order_payment_acceptance_wait w WHERE w.brand_id=$1 AND w.store_id=$2 AND w.order_id=$3 " +
        "AND NOT EXISTS (SELECT 1 FROM rms_ordering.order_payment_disposition_record d WHERE d.brand_id=w.brand_id AND d.store_id=w.store_id AND d.order_batch_id=w.order_batch_id) " +
        "ORDER BY 1 LIMIT 10001",
      [scope.brandReference, scope.storeReference, order],
    )
  ).rows as readonly Record<string, unknown>[];
  if (rows.length > 10000) throw new Error("MERCHANT_ORDER_INDEX_UNAVAILABLE");
  const seen = new Set<string>();
  return Object.freeze(
    rows.map((row) => {
      const batch = parseOrderingReference(row.batch);
      if (seen.has(batch) || (row.status !== "Confirmed" && row.status !== "AwaitingAcceptance"))
        throw new Error("MERCHANT_ORDER_INDEX_UNAVAILABLE");
      seen.add(batch);
      return Object.freeze({
        orderBatchReference: String(batch),
        status: row.status as "Confirmed" | "AwaitingAcceptance",
        paymentTransactionReference: String(parseOrderingReference(row.tx)),
        paymentIntentReference: String(parseOrderingReference(row.intent)),
        paymentAttemptReference: String(parseOrderingReference(row.attempt)),
      });
    }),
  );
}

/** The Order round (submission) of this Store and what Ordering knows about whether it ended. */
export interface StoreSubmissionOrder {
  readonly submissionReference: string;
  readonly orderReference: string;
  readonly orderBatchReference: string;
  readonly orderNumber: string;
  readonly orderType: "Pickup" | "DineIn";
  readonly businessDate: string;
  /**
   * Ordering's own end facts: the Order was terminated (cancelled or closed by the System), handed
   * over (fulfilment completed) or its table closed, or this round was cancelled. Not-collected
   * pickup closure is Fulfillment's fact, so callers combine it themselves.
   */
  readonly ended: boolean;
}

/**
 * WP-2423 (2026-10-16 v15 stock leak): the Store's Orders for the given rounds (submissions), with
 * their business day and whether Ordering recorded that they ended. Rounds of other Stores are not
 * returned. Caller authorizes and owns the transaction.
 */
export async function listStoreOrdersOfSubmissions(
  transaction: ConsumerTransaction,
  scope: { readonly brandReference: string; readonly storeReference: string },
  submissionReferences: readonly string[],
): Promise<readonly StoreSubmissionOrder[]> {
  if (submissionReferences.length === 0) return Object.freeze([]);
  if (submissionReferences.length > 500) throw new Error("MERCHANT_ORDER_INDEX_UNAVAILABLE");
  const submissions = submissionReferences.map((reference) => parseOrderingReference(reference));
  await transaction.query(
    "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
    [scope.brandReference, scope.storeReference],
  );
  const rows = (
    await transaction.query(
      `SELECT b.submission_id::text submission_id,b.order_id::text order_id,b.order_batch_id::text batch_id,
          h.order_number,h.order_type,h.business_date::text business_date,
          (EXISTS (SELECT 1 FROM rms_ordering.order_termination_record t
              WHERE t.brand_id=h.brand_id AND t.store_id=h.store_id AND t.order_id=h.order_id)
            OR EXISTS (SELECT 1 FROM rms_ordering.order_fulfillment_completion_record c
              WHERE c.brand_id=h.brand_id AND c.store_id=h.store_id AND c.order_id=h.order_id)
            OR EXISTS (SELECT 1 FROM rms_ordering.order_closure_version z
              WHERE z.brand_id=h.brand_id AND z.store_id=h.store_id AND z.order_id=h.order_id AND z.status='Closed')
            OR EXISTS (SELECT 1 FROM rms_ordering.order_staff_cancellation s
              WHERE s.brand_id=b.brand_id AND s.store_id=b.store_id AND s.order_batch_id=b.order_batch_id)
            OR EXISTS (SELECT 1 FROM rms_ordering.order_batch_checkout_cancellation x
              WHERE x.brand_id=b.brand_id AND x.store_id=b.store_id AND x.order_batch_id=b.order_batch_id)) AS ended
        FROM rms_ordering.order_batch b JOIN rms_ordering.order_header h ON h.order_id=b.order_id
          AND h.brand_id=b.brand_id AND h.store_id=b.store_id
        WHERE b.brand_id=$1 AND b.store_id=$2 AND b.submission_id=ANY($3::uuid[])
        ORDER BY h.business_date,h.order_id,b.order_batch_id`,
      [scope.brandReference, scope.storeReference, submissions],
    )
  ).rows as readonly Record<string, unknown>[];
  return Object.freeze(
    rows.map((row) => {
      if (
        typeof row.order_number !== "string" ||
        (row.order_type !== "Pickup" && row.order_type !== "DineIn") ||
        typeof row.business_date !== "string" ||
        !/^\d{4}-\d{2}-\d{2}$/u.test(row.business_date) ||
        typeof row.ended !== "boolean"
      )
        throw new Error("MERCHANT_ORDER_INDEX_UNAVAILABLE");
      return Object.freeze({
        submissionReference: parseOrderingReference(row.submission_id),
        orderReference: parseOrderingReference(row.order_id),
        orderBatchReference: parseOrderingReference(row.batch_id),
        orderNumber: row.order_number,
        orderType: row.order_type,
        businessDate: row.business_date,
        ended: row.ended,
      });
    }),
  );
}
