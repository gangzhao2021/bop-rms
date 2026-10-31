import {
  parseStoreReceiptProfileDetails,
  StoreReceiptProfileError,
  type StoreReceiptProfile,
  type StoreReceiptProfileDetails,
} from "../../contracts/store-receipt-profile.js";

/**
 * WP-2423 Q15/Q16 (DEC-RECEIPT-TAX-AND-PRIVACY): the Store's receipt registration numbers and
 * privacy notice link (`rms_store.store_receipt_profile`, append-only versions).
 */
interface Transaction {
  query(sql: string, values: readonly unknown[]): Promise<unknown>;
}
interface Scope {
  readonly brandReference: string;
  readonly storeReference: string;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const fail = (
  code: StoreReceiptProfileError["code"] = "STORE_RECEIPT_PROFILE_UNAVAILABLE",
): never => {
  throw new StoreReceiptProfileError(code);
};
function ref(value: unknown): string {
  return typeof value === "string" && uuid.test(value)
    ? value
    : fail("STORE_RECEIPT_PROFILE_INVALID");
}
function instant(value: unknown): string {
  if (typeof value !== "string") return fail("STORE_RECEIPT_PROFILE_INVALID");
  const at = Date.parse(value);
  return Number.isFinite(at) && new Date(at).toISOString() === value
    ? value
    : fail("STORE_RECEIPT_PROFILE_INVALID");
}
function rowsOf(result: unknown): readonly Record<string, unknown>[] {
  const rows: unknown =
    result !== null && typeof result === "object"
      ? Object.getOwnPropertyDescriptor(result, "rows")?.value
      : undefined;
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : fail();
}
const columns =
  "version::int AS version,gst_hst_number,qst_number,pst_number,privacy_notice_url," +
  "actor_id::text AS actor_id,operation_id::text AS operation_id," +
  "to_char(recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS recorded_at";
function profileOf(row: Record<string, unknown>): StoreReceiptProfile {
  if (!Number.isSafeInteger(row.version) || (row.version as number) < 1) return fail();
  let details: StoreReceiptProfileDetails;
  try {
    details = parseStoreReceiptProfileDetails({
      gstHstNumber: row.gst_hst_number,
      qstNumber: row.qst_number,
      pstNumber: row.pst_number,
      privacyNoticeUrl: row.privacy_notice_url,
    });
  } catch {
    return fail();
  }
  return Object.freeze({
    ...details,
    version: row.version as number,
    recordedAt: instant(row.recorded_at),
  });
}
async function setScope(tx: Transaction, scope: Scope) {
  await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
    ref(scope.brandReference),
    ref(scope.storeReference),
  ]);
}

/**
 * The Store's current receipt and privacy details, or `null` when the Owner never entered any.
 * Public facts (they are printed on receipts and linked at checkout); the caller decides who may
 * see them and owns the transaction.
 */
export async function readCurrentStoreReceiptProfile(
  tx: Transaction,
  scope: Scope,
): Promise<StoreReceiptProfile | null> {
  try {
    await setScope(tx, scope);
    const rows = rowsOf(
      await tx.query(
        "SELECT " +
          columns +
          " FROM rms_store.store_receipt_profile WHERE brand_id=$1 AND store_id=$2 ORDER BY version DESC LIMIT 1",
        [scope.brandReference, scope.storeReference],
      ),
    );
    return rows[0] === undefined ? null : profileOf(rows[0]);
  } catch (error) {
    if (error instanceof StoreReceiptProfileError) throw error;
    return fail();
  }
}

export interface StoreReceiptProfileAudit {
  readonly auditId: string;
  readonly brandId: string;
  readonly storeId: string;
  readonly actor: { readonly type: "User"; readonly reference: string };
  readonly actionCode: "STORE_RECEIPT_PROFILE_CHANGED";
  readonly targetType: "StoreReceiptProfile";
  readonly targetId: string;
  readonly reasonCode: "OWNER_ENTERED";
  readonly correlationId: string;
  readonly occurredAt: string;
  readonly sourceChannel: "MERCHANT_WEB";
  readonly dataClassification: "Internal";
  readonly beforeSummary: Readonly<Record<string, unknown>>;
  readonly afterSummary: Readonly<Record<string, unknown>>;
  readonly retentionPolicyCode: string;
  readonly retentionPolicyVersion: number;
}

/** Which fields changed, never their values (audit summaries stay free of the numbers). */
function presence(details: StoreReceiptProfileDetails | null, version: number) {
  return Object.freeze({
    version,
    gstHstNumber: details?.gstHstNumber != null,
    qstNumber: details?.qstNumber != null,
    pstNumber: details?.pstNumber != null,
    privacyNoticeUrl: details?.privacyNoticeUrl != null,
  });
}

/**
 * Records a new version of the Store's receipt and privacy details. Exactly the version the Owner
 * saw (`expectedVersion`, 0 when none) may be replaced; a retry of the same operation returns the
 * version it recorded. The Store scope, Owner authority and audit append are the caller's; this
 * store rechecks authority before and after writing and writes the audit in the same transaction.
 */
export function createPostgresStoreReceiptProfileStore(options: {
  authorize(tx: Transaction, scope: Scope & { readonly actorReference: string }): Promise<boolean>;
  appendAudit(tx: Transaction, record: StoreReceiptProfileAudit): Promise<void>;
  retentionPolicyCode: string;
  retentionPolicyVersion: number;
}) {
  return async (
    tx: Transaction,
    input: Scope & {
      readonly actorReference: string;
      readonly operationReference: string;
      readonly auditReference: string;
      readonly expectedVersion: number;
      readonly recordedAt: string;
      readonly details: unknown;
    },
  ): Promise<{ status: "Recorded" | "AlreadyRecorded"; profile: StoreReceiptProfile }> => {
    const scope = {
      brandReference: ref(input.brandReference),
      storeReference: ref(input.storeReference),
    };
    const actorReference = ref(input.actorReference),
      operationReference = ref(input.operationReference),
      auditReference = ref(input.auditReference),
      recordedAt = instant(input.recordedAt);
    const details = parseStoreReceiptProfileDetails(input.details);
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0)
      return fail("STORE_RECEIPT_PROFILE_INVALID");
    const authorize = async () => {
      if ((await options.authorize(tx, { ...scope, actorReference })) !== true)
        fail("STORE_RECEIPT_PROFILE_DENIED");
    };
    try {
      await authorize();
      await setScope(tx, scope);
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        "StoreReceiptProfile:" + scope.brandReference + ":" + scope.storeReference,
      ]);
      const prior = rowsOf(
        await tx.query(
          "SELECT " +
            columns +
            " FROM rms_store.store_receipt_profile WHERE brand_id=$1 AND store_id=$2 AND operation_id=$3",
          [scope.brandReference, scope.storeReference, operationReference],
        ),
      );
      if (prior[0] !== undefined) {
        const saved = profileOf(prior[0]);
        if (
          prior[0].actor_id !== actorReference ||
          saved.gstHstNumber !== details.gstHstNumber ||
          saved.qstNumber !== details.qstNumber ||
          saved.pstNumber !== details.pstNumber ||
          saved.privacyNoticeUrl !== details.privacyNoticeUrl
        )
          return fail("STORE_RECEIPT_PROFILE_OPERATION_CONFLICT");
        await authorize();
        return Object.freeze({ status: "AlreadyRecorded" as const, profile: saved });
      }
      const current = await readCurrentStoreReceiptProfile(tx, scope);
      const currentVersion = current?.version ?? 0;
      if (currentVersion !== input.expectedVersion)
        return fail("STORE_RECEIPT_PROFILE_VERSION_CONFLICT");
      if (
        (current?.gstHstNumber ?? null) === details.gstHstNumber &&
        (current?.qstNumber ?? null) === details.qstNumber &&
        (current?.pstNumber ?? null) === details.pstNumber &&
        (current?.privacyNoticeUrl ?? null) === details.privacyNoticeUrl
      )
        return fail("STORE_RECEIPT_PROFILE_NO_CHANGE");
      if (current !== null && recordedAt < current.recordedAt) return fail();
      const version = currentVersion + 1;
      await tx.query(
        "INSERT INTO rms_store.store_receipt_profile (brand_id,store_id,version,gst_hst_number,qst_number,pst_number,privacy_notice_url,actor_id,operation_id,audit_id,recorded_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::timestamptz)",
        [
          scope.brandReference,
          scope.storeReference,
          version,
          details.gstHstNumber,
          details.qstNumber,
          details.pstNumber,
          details.privacyNoticeUrl,
          actorReference,
          operationReference,
          auditReference,
          recordedAt,
        ],
      );
      await options.appendAudit(
        tx,
        Object.freeze({
          auditId: auditReference,
          brandId: scope.brandReference,
          storeId: scope.storeReference,
          actor: Object.freeze({ type: "User" as const, reference: actorReference }),
          actionCode: "STORE_RECEIPT_PROFILE_CHANGED" as const,
          targetType: "StoreReceiptProfile" as const,
          targetId: scope.storeReference,
          reasonCode: "OWNER_ENTERED" as const,
          correlationId: operationReference,
          occurredAt: recordedAt,
          sourceChannel: "MERCHANT_WEB" as const,
          dataClassification: "Internal" as const,
          beforeSummary: presence(current, currentVersion),
          afterSummary: presence(details, version),
          retentionPolicyCode: options.retentionPolicyCode,
          retentionPolicyVersion: options.retentionPolicyVersion,
        }),
      );
      await authorize();
      return Object.freeze({
        status: "Recorded" as const,
        profile: Object.freeze({ ...details, version, recordedAt }),
      });
    } catch (error) {
      if (error instanceof StoreReceiptProfileError) throw error;
      return fail();
    }
  };
}
