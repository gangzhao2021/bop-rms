import { parseOrderingInstant, parseOrderingReference } from "../../domain/cart.js";

/**
 * WP-2423 Q10/Q16: how long a customer's pickup contact and receipt email are kept. The days are a
 * proposal awaiting Owner confirmation (DEC-CUSTOMER-ORDER-CONTINUITY); the policy code/version is
 * written into each evidence row so a later change is visible in the history.
 */
export const checkoutContactRetentionPolicy = Object.freeze({
  policyCode: "CHECKOUT_CONTACT_RETENTION",
  policyVersion: 1,
  retentionDays: 30,
});

const fail = (): never => {
  throw new Error("CHECKOUT_CONTACT_RETENTION_UNAVAILABLE");
};
interface Query {
  query(text: string, values: readonly unknown[]): Promise<unknown>;
}
const rowsOf = (value: unknown): readonly Record<string, unknown>[] => {
  const rows: unknown =
    value !== null && typeof value === "object"
      ? Object.getOwnPropertyDescriptor(value, "rows")?.value
      : undefined;
  if (!Array.isArray(rows)) return fail();
  return rows as Record<string, unknown>[];
};
const rowCount = (value: unknown): number => {
  const count: unknown =
    value !== null && typeof value === "object"
      ? Object.getOwnPropertyDescriptor(value, "rowCount")?.value
      : undefined;
  return typeof count === "number" ? count : fail();
};

/**
 * Remove the contact from checkout details recorded more than the retention period ago, at most
 * `limit` per call, in the caller's transaction (one Store scope). Each removal appends evidence
 * first; the database accepts the details change only with that evidence and only as exactly this
 * removal. Returns how many records were cleared. Never reads or returns the removed values.
 */
export async function redactExpiredCheckoutContacts(
  transaction: Query,
  scope: { readonly brandReference: string; readonly storeReference: string },
  input: {
    readonly observedAt: string;
    readonly limit: number;
    readonly generateRedactionReference: () => string;
  },
): Promise<{ readonly redacted: number }> {
  const brand = parseOrderingReference(scope.brandReference),
    store = parseOrderingReference(scope.storeReference),
    observedAt = parseOrderingInstant(input.observedAt);
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 500) return fail();
  const { policyCode, policyVersion, retentionDays } = checkoutContactRetentionPolicy;
  await transaction.query(
    "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
    [brand, store],
  );
  const due = rowsOf(
    await transaction.query(
      "SELECT d.details_id::text AS details_id,d.details_version," +
        "to_char(d.recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS recorded_at " +
        "FROM rms_ordering.checkout_details_record d " +
        "WHERE d.brand_id=$1 AND d.store_id=$2 AND d.recorded_at<=$3::timestamptz-make_interval(days=>$4::int) " +
        "AND (d.snapshot_json->'pickupContact'<>'null'::jsonb OR d.snapshot_json#>'{receipt,email}'<>'null'::jsonb) " +
        "AND NOT EXISTS (SELECT 1 FROM rms_ordering.checkout_contact_redaction r WHERE r.brand_id=d.brand_id " +
        "AND r.store_id=d.store_id AND r.details_id=d.details_id AND r.details_version=d.details_version) " +
        "ORDER BY d.recorded_at,d.details_id,d.details_version LIMIT $5::int FOR UPDATE OF d SKIP LOCKED",
      [brand, store, observedAt, retentionDays, input.limit],
    ),
  );
  let redacted = 0;
  for (const row of due) {
    if (Object.keys(row).length !== 3) return fail();
    const detailsReference = String(parseOrderingReference(row.details_id));
    const detailsVersion = row.details_version;
    if (!Number.isSafeInteger(detailsVersion) || (detailsVersion as number) < 1) return fail();
    const recordedAt = parseOrderingInstant(row.recorded_at);
    const evidence = await transaction.query(
      "INSERT INTO rms_ordering.checkout_contact_redaction " +
        "(brand_id,store_id,details_id,details_version,redaction_id,policy_code,policy_version,retention_days,details_recorded_at,redacted_at) " +
        "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::timestamptz,$10::timestamptz)",
      [
        brand,
        store,
        detailsReference,
        detailsVersion,
        String(parseOrderingReference(input.generateRedactionReference())),
        policyCode,
        policyVersion,
        retentionDays,
        recordedAt,
        observedAt,
      ],
    );
    if (rowCount(evidence) !== 1) return fail();
    const cleared = await transaction.query(
      "UPDATE rms_ordering.checkout_details_record SET snapshot_json=snapshot_json||" +
        "jsonb_build_object('pickupContact','null'::jsonb,'receipt',jsonb_build_object('choice','InSession','email','null'::jsonb)) " +
        "WHERE brand_id=$1 AND store_id=$2 AND details_id=$3 AND details_version=$4",
      [brand, store, detailsReference, detailsVersion],
    );
    if (rowCount(cleared) !== 1) return fail();
    redacted++;
  }
  return Object.freeze({ redacted });
}
