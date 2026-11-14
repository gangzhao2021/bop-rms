import { parseOrderingReference } from "../../domain/cart.js";
import { parseCheckoutDetailsSnapshot } from "../../domain/checkout-details.js";
import { orderLocalizedName } from "../../domain/order-item-option-lines.js";
import {
  decodeConfiguredOrderItemSnapshot,
  decodeOrderItemSnapshot,
} from "../../domain/order-item-snapshot-codec.js";

/**
 * Orders v2 (Owner 2026-10-26, "a row doesn't say what or who"): what each listed Order is and who
 * it is for, so a staff list row reads "1× Latte (Small) +2" and the pickup name. Item names, their
 * options and quantities only — no prices or notes — and the pickup name only, never the phone
 * or email (the order detail keeps those). A removed contact has no name.
 */
export interface MerchantOrderListSummary {
  /** The first lines in batch and line order (at most three). */
  readonly items: readonly {
    readonly name: string;
    readonly option: string | null;
    readonly quantity: number;
  }[];
  /** Lines on the Order (so a row can say "+2 more"). */
  readonly lineCount: number;
  /** The pickup name the customer gave; null when none, removed, or not a pickup. */
  readonly pickupName: string | null;
}

interface Transaction {
  query(text: string, values: readonly unknown[]): Promise<unknown>;
}
const fail = (): never => {
  throw new Error("MERCHANT_ORDER_LIST_SUMMARY_UNAVAILABLE");
};
const rowsOf = (result: unknown): readonly Record<string, unknown>[] => {
  const rows = (result as { readonly rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : fail();
};

/**
 * A line's chosen options as one text: every option, not only the first (v15 2026-10-29: a combo
 * row named its first dish only), in the staff language's list form, at most 200 characters.
 */
export function orderListOptionText(
  names: readonly string[],
  locale: string | readonly string[],
): string | null {
  const separator = (typeof locale === "string" ? locale : locale[0])?.startsWith("zh")
    ? "、"
    : ", ";
  const text = names.filter((name) => name.length > 0).join(separator);
  if (text === "") return null;
  return text.length > 200 ? text.slice(0, 199) + "…" : text;
}

/** Read only; the caller authorizes the Store and owns the transaction. At most 200 Orders. */
export async function loadMerchantOrderListSummaries(
  transaction: Transaction,
  scope: { readonly brandReference: string; readonly storeReference: string },
  orderReferences: readonly string[],
  /** Names in the first of these locales each name has (as the order detail reads them). */
  locale: string | readonly string[],
): Promise<ReadonlyMap<string, MerchantOrderListSummary>> {
  if (orderReferences.length === 0) return new Map();
  if (orderReferences.length > 200) return fail();
  const brand = parseOrderingReference(scope.brandReference),
    store = parseOrderingReference(scope.storeReference),
    orders = orderReferences.map((value) => parseOrderingReference(value));
  await transaction.query(
    "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
    [brand, store],
  );
  const name = (names: Readonly<Record<string, string>>) => {
    try {
      return orderLocalizedName(names, locale);
    } catch {
      return "";
    }
  };
  const lines = rowsOf(
    await transaction.query(
      "SELECT i.order_id::text order_id,i.transaction_snapshot_json snapshot," +
        "i.transaction_snapshot_json#>>'{pricing,quoteVersion}' quote_version " +
        "FROM rms_ordering.order_item i JOIN rms_ordering.order_batch b ON b.brand_id=i.brand_id AND " +
        "b.store_id=i.store_id AND b.order_id=i.order_id AND b.order_batch_id=i.order_batch_id " +
        "WHERE i.brand_id=$1 AND i.store_id=$2 AND i.order_id=ANY($3::uuid[]) " +
        "ORDER BY i.order_id,b.submitted_at,b.order_batch_id,i.ordinal LIMIT 20001",
      [brand, store, orders],
    ),
  );
  if (lines.length > 20_000) return fail();
  const found = new Map<
    string,
    { items: MerchantOrderListSummary["items"][number][]; lineCount: number }
  >();
  for (const row of lines) {
    const order = parseOrderingReference(row.order_id);
    if (!orders.includes(order)) return fail();
    if (row.quote_version !== "1" && row.quote_version !== "2") return fail();
    const snapshot =
      row.quote_version === "2"
        ? decodeConfiguredOrderItemSnapshot(row.snapshot)
        : decodeOrderItemSnapshot(row.snapshot);
    const entry = found.get(order) ?? { items: [], lineCount: 0 };
    entry.lineCount += 1;
    if (entry.items.length < 3) {
      const chosen = orderListOptionText(
        snapshot.catalog.options.map((option) => name(option.localizedNames)),
        locale,
      );
      entry.items.push(
        Object.freeze({
          name: name(snapshot.catalog.localizedNames),
          option: chosen,
          quantity: snapshot.quantity,
        }),
      );
    }
    found.set(order, entry);
  }
  // The pickup name of each Order's initial submission, unless the contact was removed.
  const names = new Map<string, string>();
  for (const row of rowsOf(
    await transaction.query(
      "SELECT s.order_id::text order_id,d.snapshot_json snapshot," +
        "EXISTS (SELECT 1 FROM rms_ordering.checkout_contact_redaction r WHERE r.brand_id=d.brand_id " +
        "AND r.store_id=d.store_id AND r.details_id=d.details_id AND r.details_version=d.details_version) removed " +
        "FROM rms_ordering.order_submission_record s " +
        "JOIN rms_ordering.order_checkout_details_link l ON l.brand_id=s.brand_id AND l.store_id=s.store_id AND l.submission_id=s.submission_id " +
        "JOIN rms_ordering.checkout_details_record d ON d.brand_id=l.brand_id AND d.store_id=l.store_id AND d.details_id=l.details_id AND d.details_version=l.details_version " +
        "WHERE s.brand_id=$1 AND s.store_id=$2 AND s.order_id=ANY($3::uuid[]) AND s.submission_kind='Initial'",
      [brand, store, orders],
    ),
  )) {
    const order = parseOrderingReference(row.order_id);
    if (!orders.includes(order) || names.has(order)) return fail();
    if (row.removed === true) continue;
    if (row.removed !== false) return fail();
    const snapshot = parseCheckoutDetailsSnapshot(row.snapshot);
    if (snapshot.brandReference !== brand || snapshot.storeReference !== store) return fail();
    if (snapshot.pickupContact !== null) names.set(order, snapshot.pickupContact.name);
  }
  const summaries = new Map<string, MerchantOrderListSummary>();
  for (const [order, entry] of found)
    summaries.set(
      order,
      Object.freeze({
        items: Object.freeze(entry.items),
        lineCount: entry.lineCount,
        pickupName: names.get(order) ?? null,
      }),
    );
  return summaries;
}
