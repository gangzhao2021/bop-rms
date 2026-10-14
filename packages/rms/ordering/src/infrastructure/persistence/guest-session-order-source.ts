import { parseOrderingInstant, parseOrderingReference } from "../../domain/cart.js";

export interface GuestSessionLatestOrder {
  readonly orderReference: string;
  readonly orderNumber: string;
  readonly orderType: "Pickup" | "DineIn";
  readonly createdAt: string;
}

const fail = (): never => {
  throw new Error("GUEST_SESSION_ORDER_UNAVAILABLE");
};

/**
 * WP-2423 Q10: the latest Order this exact Guest Session placed in this Store, so a customer who
 * reopens the app can go back to it. The caller must have authorized the Guest Session in the same
 * transaction; this read never searches by anything the browser supplies.
 */
export async function findLatestGuestSessionOrder(
  transaction: { query(text: string, values: readonly unknown[]): Promise<unknown> },
  scope: { readonly brandReference: string; readonly storeReference: string },
  input: { readonly guestSessionReference: string; readonly observedAt: string },
): Promise<GuestSessionLatestOrder | null> {
  const brand = parseOrderingReference(scope.brandReference),
    store = parseOrderingReference(scope.storeReference),
    guest = parseOrderingReference(input.guestSessionReference),
    observedAt = parseOrderingInstant(input.observedAt);
  await transaction.query(
    "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
    [brand, store],
  );
  const result = (await transaction.query(
    "SELECT h.order_id::text AS order_id,h.order_number,h.order_type," +
      "to_char(h.created_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS created_at " +
      "FROM rms_ordering.order_header h JOIN rms_ordering.order_submission_record s " +
      "ON s.order_id=h.order_id AND s.brand_id=h.brand_id AND s.store_id=h.store_id AND s.submission_kind='Initial' " +
      "WHERE h.brand_id=$1 AND h.store_id=$2 AND s.guest_session_id=$3 AND h.created_at<=$4::timestamptz " +
      "ORDER BY h.created_at DESC,h.order_id DESC LIMIT 1",
    [brand, store, guest, observedAt],
  )) as { readonly rows?: unknown } | null;
  const rows = result?.rows;
  if (!Array.isArray(rows) || rows.length > 1) return fail();
  const row = rows[0] as Record<string, unknown> | undefined;
  if (row === undefined) return null;
  if (
    Object.keys(row).length !== 4 ||
    typeof row.order_number !== "string" ||
    !/^[1-9][0-9]{0,18}$/u.test(row.order_number) ||
    (row.order_type !== "Pickup" && row.order_type !== "DineIn")
  )
    return fail();
  return Object.freeze({
    orderReference: String(parseOrderingReference(row.order_id)),
    orderNumber: row.order_number,
    orderType: row.order_type,
    createdAt: String(parseOrderingInstant(row.created_at)),
  });
}

/** WP-2423 Q10: the customer-facing number and type of one Order (for a message about it). */
export async function loadOrderCustomerSummary(
  transaction: { query(text: string, values: readonly unknown[]): Promise<unknown> },
  scope: { readonly brandReference: string; readonly storeReference: string },
  orderReference: string,
): Promise<{ readonly orderNumber: string; readonly orderType: "Pickup" | "DineIn" } | null> {
  const brand = parseOrderingReference(scope.brandReference),
    store = parseOrderingReference(scope.storeReference),
    order = parseOrderingReference(orderReference);
  await transaction.query(
    "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
    [brand, store],
  );
  const result = (await transaction.query(
    "SELECT order_number,order_type FROM rms_ordering.order_header WHERE brand_id=$1 AND store_id=$2 AND order_id=$3 LIMIT 2",
    [brand, store, order],
  )) as { readonly rows?: unknown } | null;
  const rows = result?.rows;
  if (!Array.isArray(rows) || rows.length > 1) return fail();
  const row = rows[0] as Record<string, unknown> | undefined;
  if (row === undefined) return null;
  if (
    Object.keys(row).length !== 2 ||
    typeof row.order_number !== "string" ||
    !/^[1-9][0-9]{0,18}$/u.test(row.order_number) ||
    (row.order_type !== "Pickup" && row.order_type !== "DineIn")
  )
    return fail();
  return Object.freeze({ orderNumber: row.order_number, orderType: row.order_type });
}
