import { parseOrderingReference } from "../../domain/cart.js";
import { parseCheckoutDetailsSnapshot } from "../../domain/checkout-details.js";
import { decodeDigitalReceiptRecord } from "../../domain/digital-receipt-codec.js";
import {
  parseDigitalReceiptChain,
  type DigitalReceiptSnapshot,
} from "../../domain/digital-receipt.js";

/**
 * WP-2423 Q10: the contact a pickup customer gave "so the store can reach you about this order".
 * `Removed` once the retention period deleted it (the evidence row says so; the value is gone).
 */
export type OrderPickupContact =
  | {
      readonly status: "Available";
      readonly name: string;
      readonly channel: "Phone" | "Email";
      readonly value: string;
      /** Which checkout details record holds it (evidence pointer; never shown to staff). */
      readonly detailsReference: string;
      readonly detailsVersion: number;
    }
  | { readonly status: "Removed"; readonly removedAt: string }
  | { readonly status: "NotGiven" };

const fail = (): never => {
  throw new Error("ORDER_PICKUP_CONTACT_UNAVAILABLE");
};

/**
 * Staff order detail only (never a list, a log, an event or a projection). The caller must have
 * authorized the staff member for this Store's orders in the same transaction.
 */
export async function loadOrderPickupContact(
  transaction: { query(text: string, values: readonly unknown[]): Promise<unknown> },
  scope: { readonly brandReference: string; readonly storeReference: string },
  orderReference: string,
): Promise<OrderPickupContact> {
  const brand = parseOrderingReference(scope.brandReference),
    store = parseOrderingReference(scope.storeReference),
    order = parseOrderingReference(orderReference);
  await transaction.query(
    "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
    [brand, store],
  );
  const result = (await transaction.query(
    "SELECT d.snapshot_json AS snapshot," +
      "(SELECT to_char(r.redacted_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') FROM rms_ordering.checkout_contact_redaction r " +
      "WHERE r.brand_id=d.brand_id AND r.store_id=d.store_id AND r.details_id=d.details_id AND r.details_version=d.details_version) AS removed_at " +
      "FROM rms_ordering.order_submission_record s " +
      "JOIN rms_ordering.order_checkout_details_link l ON l.brand_id=s.brand_id AND l.store_id=s.store_id AND l.submission_id=s.submission_id " +
      "JOIN rms_ordering.checkout_details_record d ON d.brand_id=l.brand_id AND d.store_id=l.store_id AND d.details_id=l.details_id AND d.details_version=l.details_version " +
      "WHERE s.brand_id=$1 AND s.store_id=$2 AND s.order_id=$3 AND s.submission_kind='Initial' LIMIT 2",
    [brand, store, order],
  )) as { readonly rows?: unknown } | null;
  const rows = result?.rows;
  if (!Array.isArray(rows) || rows.length > 1) return fail();
  const row = rows[0] as Record<string, unknown> | undefined;
  if (row === undefined) return Object.freeze({ status: "NotGiven" });
  if (Object.keys(row).length !== 2) return fail();
  const snapshot = parseCheckoutDetailsSnapshot(row.snapshot);
  if (snapshot.brandReference !== brand || snapshot.storeReference !== store) return fail();
  if (typeof row.removed_at === "string")
    return Object.freeze({ status: "Removed", removedAt: row.removed_at });
  if (row.removed_at !== null) return fail();
  const contact = snapshot.pickupContact;
  return contact === null
    ? Object.freeze({ status: "NotGiven" })
    : Object.freeze({
        status: "Available",
        name: contact.name,
        channel: contact.channel,
        value: contact.value,
        detailsReference: snapshot.detailsReference,
        detailsVersion: snapshot.detailsVersion,
      });
}

/**
 * DEC-PILOT-NOTIFICATIONS: the receipt a customer asked to have emailed ("Email my receipt") with
 * the address, read just before the send. `ReceiptPending` until the original receipt is issued;
 * `Removed` once the retention period (or the customer) removed the contact.
 */
export type OrderReceiptEmail =
  | { readonly status: "NotRequested" }
  | { readonly status: "Removed" }
  | { readonly status: "ReceiptPending" }
  | {
      readonly status: "Ready";
      readonly email: string;
      readonly detailsReference: string;
      readonly detailsVersion: number;
      /** The original (first) receipt as issued. */
      readonly receipt: DigitalReceiptSnapshot;
    };

export async function loadOrderReceiptEmail(
  transaction: { query(text: string, values: readonly unknown[]): Promise<unknown> },
  scope: { readonly brandReference: string; readonly storeReference: string },
  orderReference: string,
): Promise<OrderReceiptEmail> {
  const brand = parseOrderingReference(scope.brandReference),
    store = parseOrderingReference(scope.storeReference),
    order = parseOrderingReference(orderReference);
  await transaction.query(
    "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
    [brand, store],
  );
  const result = (await transaction.query(
    "SELECT d.snapshot_json AS snapshot," +
      "EXISTS (SELECT 1 FROM rms_ordering.checkout_contact_redaction r " +
      "WHERE r.brand_id=d.brand_id AND r.store_id=d.store_id AND r.details_id=d.details_id AND r.details_version=d.details_version) AS removed " +
      "FROM rms_ordering.order_submission_record s " +
      "JOIN rms_ordering.order_checkout_details_link l ON l.brand_id=s.brand_id AND l.store_id=s.store_id AND l.submission_id=s.submission_id " +
      "JOIN rms_ordering.checkout_details_record d ON d.brand_id=l.brand_id AND d.store_id=l.store_id AND d.details_id=l.details_id AND d.details_version=l.details_version " +
      "WHERE s.brand_id=$1 AND s.store_id=$2 AND s.order_id=$3 AND s.submission_kind='Initial' LIMIT 2",
    [brand, store, order],
  )) as { readonly rows?: unknown } | null;
  const rows = result?.rows;
  if (!Array.isArray(rows) || rows.length > 1) return fail();
  const row = rows[0] as Record<string, unknown> | undefined;
  if (row === undefined) return Object.freeze({ status: "NotRequested" });
  if (Object.keys(row).length !== 2 || typeof row.removed !== "boolean") return fail();
  const snapshot = parseCheckoutDetailsSnapshot(row.snapshot);
  if (snapshot.brandReference !== brand || snapshot.storeReference !== store) return fail();
  if (row.removed) return Object.freeze({ status: "Removed" });
  if (snapshot.receipt.choice !== "TransactionalEmail")
    return Object.freeze({ status: "NotRequested" });
  const receipts = (await transaction.query(
    "SELECT receipt_record_json::text AS record FROM rms_ordering.digital_receipt_record " +
      "WHERE brand_id=$1 AND store_id=$2 AND order_id=$3 ORDER BY version LIMIT 101",
    [brand, store, order],
  )) as { readonly rows?: unknown } | null;
  const receiptRows = receipts?.rows;
  if (!Array.isArray(receiptRows)) return fail();
  if (receiptRows.length === 0) return Object.freeze({ status: "ReceiptPending" });
  const chain = parseDigitalReceiptChain({
    orderReference: order,
    records: receiptRows.map((value) =>
      decodeDigitalReceiptRecord((value as Record<string, unknown>).record),
    ),
  });
  const original = chain.records[0];
  if (
    original === undefined ||
    original.snapshot.brandReference !== brand ||
    original.snapshot.storeReference !== store
  )
    return fail();
  return Object.freeze({
    status: "Ready",
    email: snapshot.receipt.email,
    detailsReference: snapshot.detailsReference,
    detailsVersion: snapshot.detailsVersion,
    receipt: original.snapshot,
  });
}
