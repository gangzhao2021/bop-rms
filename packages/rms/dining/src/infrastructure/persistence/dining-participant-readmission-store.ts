import {
  appendAuditRecordInTransaction,
  validateAuditRecord,
  type AppendAuditRecordInput,
} from "@bop/audit";
import type { DiningTableTransaction } from "./dining-table-store.js";

/**
 * WP-2423 M35 (DEC-STAFF-ROUND-SPEED): marks a plain read with no side effect, so the pilot's
 * transaction runner may answer an identical repeat of it from the same transaction while nothing
 * that could change its answer ran in between. An ordinary SQL comment everywhere else.
 */
const stableRead = "-- bop:stable-read\n";

/**
 * WP-2423 shared-table-checkout (b), lost cookie (DEC-DINING-CHECKOUT-SCOPE; 2000_525): Dining's
 * own record that a participant's phone came back on a later Guest Session (Identity's continuity
 * rotation, in the same transaction). Written only while the participant is Active at a table still
 * open; from then on the earlier Guest Session is not this participant's phone any more.
 */
export interface DiningReadmissionScope {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
}
const uuidV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
export class DiningReadmissionError extends Error {
  constructor(readonly code: "DINING_READMISSION_REFUSED" | "DINING_READMISSION_UNAVAILABLE") {
    super(code);
    this.name = "DiningReadmissionError";
  }
}
function ref(value: unknown): string {
  if (typeof value !== "string" || !uuidV7.test(value))
    throw new DiningReadmissionError("DINING_READMISSION_UNAVAILABLE");
  return value;
}
function rowsOf(value: unknown): readonly Record<string, unknown>[] {
  const rows = (value as { rows?: unknown } | null)?.rows;
  if (!Array.isArray(rows)) throw new DiningReadmissionError("DINING_READMISSION_UNAVAILABLE");
  return rows as Record<string, unknown>[];
}
async function scoped(tx: DiningTableTransaction, scope: DiningReadmissionScope) {
  const ids = {
    tenant: ref(scope.tenantReference),
    brand: ref(scope.brandReference),
    store: ref(scope.storeReference),
  };
  await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
    ids.brand,
    ids.store,
  ]);
  return ids;
}

/**
 * The participant came back on `toGuestSessionReference`. Refused (nothing written) when the
 * participant left or was removed, the table closed, or `from` is not the participant's current
 * phone session.
 */
export async function recordDiningParticipantReadmission(
  tx: DiningTableTransaction,
  scope: DiningReadmissionScope,
  input: {
    readonly readmissionReference: string;
    readonly operationReference: string;
    readonly diningSessionReference: string;
    readonly participantReference: string;
    readonly fromGuestSessionReference: string;
    readonly toGuestSessionReference: string;
    readonly observedAt: string;
    /** System audit DINING_PARTICIPANT_READMITTED on CUSTOMER_PWA, Restricted. */
    readonly audit: AppendAuditRecordInput;
  },
): Promise<void> {
  const ids = await scoped(tx, scope);
  if (typeof input.observedAt !== "string" || !instant.test(input.observedAt))
    throw new DiningReadmissionError("DINING_READMISSION_UNAVAILABLE");
  const audit = validateAuditRecord(input.audit, Date.parse(input.observedAt));
  if (
    audit.brandId !== ids.brand ||
    audit.storeId !== ids.store ||
    audit.actionCode !== "DINING_PARTICIPANT_READMITTED" ||
    audit.occurredAt !== input.observedAt
  )
    throw new DiningReadmissionError("DINING_READMISSION_UNAVAILABLE");
  const session = ref(input.diningSessionReference);
  const participant = ref(input.participantReference);
  const seated = rowsOf(
    await tx.query(
      `SELECT 1 FROM rms_dining.dining_participant p JOIN rms_dining.dining_session s
         ON s.tenant_id=p.tenant_id AND s.brand_id=p.brand_id AND s.store_id=p.store_id AND s.session_id=p.session_id
       WHERE p.tenant_id=$1 AND p.brand_id=$2 AND p.store_id=$3 AND p.session_id=$4 AND p.participant_id=$5
        AND p.status='Active' AND s.phase IN ('Active','Closing')
       FOR SHARE OF p`,
      [ids.tenant, ids.brand, ids.store, session, participant],
    ),
  );
  if (seated.length !== 1) throw new DiningReadmissionError("DINING_READMISSION_REFUSED");
  if (await isDiningGuestSessionSuperseded(tx, scope, input.fromGuestSessionReference))
    throw new DiningReadmissionError("DINING_READMISSION_REFUSED");
  await tx.query(
    `INSERT INTO rms_dining.dining_participant_readmission
     (readmission_id,tenant_id,brand_id,store_id,session_id,participant_id,from_guest_session_id,
      to_guest_session_id,operation_id,occurred_at,audit_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      ref(input.readmissionReference),
      ids.tenant,
      ids.brand,
      ids.store,
      session,
      participant,
      ref(input.fromGuestSessionReference),
      ref(input.toGuestSessionReference),
      ref(input.operationReference),
      input.observedAt,
      audit.auditId,
    ],
  );
  await appendAuditRecordInTransaction(tx as never, audit);
}

/** Whether this Guest Session's participant has since come back on a later session. */
export async function isDiningGuestSessionSuperseded(
  tx: DiningTableTransaction,
  scope: DiningReadmissionScope,
  guestSessionReference: string,
): Promise<boolean> {
  const ids = await scoped(tx, scope);
  return (
    rowsOf(
      await tx.query(
        stableRead +
          "SELECT 1 FROM rms_dining.dining_participant_readmission WHERE brand_id=$1 AND store_id=$2 AND from_guest_session_id=$3",
        [ids.brand, ids.store, ref(guestSessionReference)],
      ),
    ).length > 0
  );
}

/**
 * v15 batch 8 (member points): every Guest Session this participant's phone has used at its table
 * — the one it came on and each later one after a lost cookie — so a payment made on its own card
 * before the rotation is still known as this phone's. The participant's current session is the
 * caller's; this adds the earlier ones (and the later ones, when asked about an earlier session).
 */
export async function listDiningParticipantGuestSessions(
  tx: DiningTableTransaction,
  scope: DiningReadmissionScope,
  participantReference: string,
): Promise<readonly string[]> {
  const ids = await scoped(tx, scope);
  const found = rowsOf(
    await tx.query(
      stableRead +
        `SELECT from_guest_session_id::text AS from_session,to_guest_session_id::text AS to_session
 FROM rms_dining.dining_participant_readmission WHERE brand_id=$1 AND store_id=$2 AND participant_id=$3
 ORDER BY occurred_at,readmission_id LIMIT 50`,
      [ids.brand, ids.store, ref(participantReference)],
    ),
  );
  const sessions = new Set<string>();
  for (const row of found) {
    sessions.add(ref(row.from_session));
    sessions.add(ref(row.to_session));
  }
  return Object.freeze([...sessions]);
}
