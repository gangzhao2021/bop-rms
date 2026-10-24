import { parseOrderingInstant, parseOrderingReference } from "../../domain/cart.js";
import { parseCheckoutDetailsSnapshot } from "../../domain/checkout-details.js";

/**
 * WP-2423 Q16 (DEC-RECEIPT-TAX-AND-PRIVACY): a customer removes the pickup contact (and any receipt
 * email) they gave for their own order, from the order page while their visit is active. Same
 * one-time change and evidence as the retention removal (Q10), recorded under the policy
 * `CUSTOMER_REQUEST`; the order, payment and audit history are unchanged. Never reads out or
 * returns the removed values.
 */
export type CheckoutContactPresence = "Stored" | "Removed" | "NotGiven";

export const checkoutContactCustomerRequestPolicy = Object.freeze({
  policyCode: "CUSTOMER_REQUEST",
  policyVersion: 1,
});

export class CheckoutContactRemovalError extends Error {
  constructor(
    readonly code: "CHECKOUT_CONTACT_REMOVAL_NOT_FOUND" | "CHECKOUT_CONTACT_REMOVAL_UNAVAILABLE",
  ) {
    super(code);
    this.name = "CheckoutContactRemovalError";
  }
}
const unavailable = (): never => {
  throw new CheckoutContactRemovalError("CHECKOUT_CONTACT_REMOVAL_UNAVAILABLE");
};
interface Query {
  query(text: string, values: readonly unknown[]): Promise<unknown>;
}
const rowsOf = (value: unknown): readonly Record<string, unknown>[] => {
  const rows: unknown =
    value !== null && typeof value === "object"
      ? Object.getOwnPropertyDescriptor(value, "rows")?.value
      : undefined;
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : unavailable();
};
const rowCount = (value: unknown): number => {
  const count: unknown =
    value !== null && typeof value === "object"
      ? Object.getOwnPropertyDescriptor(value, "rowCount")?.value
      : undefined;
  return typeof count === "number" ? count : unavailable();
};

interface Located {
  readonly detailsReference: string;
  readonly detailsVersion: number;
  readonly recordedAt: string;
  readonly presence: CheckoutContactPresence;
}

/**
 * The checkout details of this Guest Session's order (its first submission). `null` when the order
 * is not this Session's or has no checkout details. `lock` holds the details row for the removal.
 */
async function locate(
  transaction: Query,
  scope: { readonly brandReference: string; readonly storeReference: string },
  input: { readonly orderReference: string; readonly guestSessionReference: string },
  lock: boolean,
): Promise<Located | null> {
  const brand = parseOrderingReference(scope.brandReference),
    store = parseOrderingReference(scope.storeReference),
    order = parseOrderingReference(input.orderReference),
    guest = parseOrderingReference(input.guestSessionReference);
  await transaction.query(
    "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
    [brand, store],
  );
  const rows = rowsOf(
    await transaction.query(
      "SELECT d.details_id::text AS details_id,d.details_version,d.snapshot_json AS snapshot," +
        "to_char(d.recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS recorded_at," +
        "EXISTS (SELECT 1 FROM rms_ordering.checkout_contact_redaction r WHERE r.brand_id=d.brand_id " +
        "AND r.store_id=d.store_id AND r.details_id=d.details_id AND r.details_version=d.details_version) AS removed " +
        "FROM rms_ordering.order_submission_record s " +
        "JOIN rms_ordering.order_checkout_details_link l ON l.brand_id=s.brand_id AND l.store_id=s.store_id AND l.submission_id=s.submission_id " +
        "JOIN rms_ordering.checkout_details_record d ON d.brand_id=l.brand_id AND d.store_id=l.store_id AND d.details_id=l.details_id AND d.details_version=l.details_version " +
        "WHERE s.brand_id=$1 AND s.store_id=$2 AND s.order_id=$3 AND s.submission_kind='Initial' " +
        "AND s.guest_session_id=$4 AND d.guest_session_id=$4 LIMIT 2" +
        (lock ? " FOR UPDATE OF d" : ""),
      [brand, store, order, guest],
    ),
  );
  if (rows.length > 1) return unavailable();
  const row = rows[0];
  if (row === undefined) return null;
  if (Object.keys(row).length !== 5 || typeof row.removed !== "boolean") return unavailable();
  const detailsVersion = row.details_version;
  if (!Number.isSafeInteger(detailsVersion) || (detailsVersion as number) < 1) return unavailable();
  if (row.removed)
    return Object.freeze({
      detailsReference: String(parseOrderingReference(row.details_id)),
      detailsVersion: detailsVersion as number,
      recordedAt: parseOrderingInstant(row.recorded_at),
      presence: "Removed" as const,
    });
  const snapshot = parseCheckoutDetailsSnapshot(row.snapshot);
  if (
    snapshot.brandReference !== brand ||
    snapshot.storeReference !== store ||
    snapshot.detailsReference !== row.details_id ||
    snapshot.detailsVersion !== detailsVersion
  )
    return unavailable();
  return Object.freeze({
    detailsReference: snapshot.detailsReference,
    detailsVersion: snapshot.detailsVersion,
    recordedAt: parseOrderingInstant(row.recorded_at),
    presence:
      snapshot.pickupContact !== null || snapshot.receipt.email !== null
        ? ("Stored" as const)
        : ("NotGiven" as const),
  });
}

/** Whether this Session's order still holds a contact the customer could remove. */
export async function readCheckoutContactPresence(
  transaction: Query,
  scope: { readonly brandReference: string; readonly storeReference: string },
  input: { readonly orderReference: string; readonly guestSessionReference: string },
): Promise<CheckoutContactPresence> {
  try {
    return (await locate(transaction, scope, input, false))?.presence ?? "NotGiven";
  } catch (error) {
    if (error instanceof CheckoutContactRemovalError) throw error;
    return unavailable();
  }
}

/**
 * Removes the contact now, once. A repeat request (or one after the retention removal) returns
 * `AlreadyRemoved` without writing; an order without a contact returns `NotGiven`. The caller has
 * authorized the Guest Session for this order, owns the transaction and records the audit when the
 * result is `Removed`.
 */
export async function removeCheckoutContactOnCustomerRequest(
  transaction: Query,
  scope: { readonly brandReference: string; readonly storeReference: string },
  input: {
    readonly orderReference: string;
    readonly guestSessionReference: string;
    readonly observedAt: string;
    readonly redactionReference: string;
  },
): Promise<{ readonly status: "Removed" | "AlreadyRemoved" | "NotGiven" }> {
  try {
    const observedAt = parseOrderingInstant(input.observedAt),
      redaction = String(parseOrderingReference(input.redactionReference));
    const located = await locate(transaction, scope, input, true);
    if (located === null)
      throw new CheckoutContactRemovalError("CHECKOUT_CONTACT_REMOVAL_NOT_FOUND");
    if (located.presence === "Removed") return Object.freeze({ status: "AlreadyRemoved" as const });
    if (located.presence === "NotGiven") return Object.freeze({ status: "NotGiven" as const });
    if (observedAt < located.recordedAt) return unavailable();
    const brand = String(parseOrderingReference(scope.brandReference)),
      store = String(parseOrderingReference(scope.storeReference));
    const { policyCode, policyVersion } = checkoutContactCustomerRequestPolicy;
    const evidence = await transaction.query(
      "INSERT INTO rms_ordering.checkout_contact_redaction " +
        "(brand_id,store_id,details_id,details_version,redaction_id,policy_code,policy_version,retention_days,details_recorded_at,redacted_at) " +
        "VALUES ($1,$2,$3,$4,$5,$6,$7,NULL,$8::timestamptz,$9::timestamptz)",
      [
        brand,
        store,
        located.detailsReference,
        located.detailsVersion,
        redaction,
        policyCode,
        policyVersion,
        located.recordedAt,
        observedAt,
      ],
    );
    if (rowCount(evidence) !== 1) return unavailable();
    const cleared = await transaction.query(
      "UPDATE rms_ordering.checkout_details_record SET snapshot_json=snapshot_json||" +
        "jsonb_build_object('pickupContact','null'::jsonb,'receipt',jsonb_build_object('choice','InSession','email','null'::jsonb)) " +
        "WHERE brand_id=$1 AND store_id=$2 AND details_id=$3 AND details_version=$4",
      [brand, store, located.detailsReference, located.detailsVersion],
    );
    if (rowCount(cleared) !== 1) return unavailable();
    return Object.freeze({ status: "Removed" as const });
  } catch (error) {
    if (error instanceof CheckoutContactRemovalError) throw error;
    return unavailable();
  }
}
