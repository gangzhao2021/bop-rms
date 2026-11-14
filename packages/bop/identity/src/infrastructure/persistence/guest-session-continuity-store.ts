import { GuestSessionError } from "../../contracts/guest-session.js";

/**
 * WP-2423 shared-table-checkout (b), lost cookie (DEC-DINING-CHECKOUT-SCOPE; 2000_523). A seated
 * Guest Session is given a continuity token the page keeps (only its SHA-256 is stored here). A
 * scan that comes without a usable cookie but with that token is the same phone: while the old
 * session is live and seated, it is rotated ('Rotated') into a successor session bound to the same
 * dining session and participant, once per token. No login, no contact. The caller owns the
 * transaction, checks the scanned table against the old session's table and records Dining's
 * readmission in the same transaction.
 */
export interface GuestContinuityScope {
  readonly brandReference: string;
  readonly storeReference: string;
}
export interface GuestContinuitySeat {
  readonly continuityReference: string;
  readonly guestSessionReference: string;
  readonly publicStoreReference: string;
  readonly publicTableReference: string;
  readonly qrReference: string;
  readonly qrRevocationVersion: number;
  readonly diningSessionReference: string;
  readonly participantReference: string;
  readonly locale: string;
}
interface Transaction {
  query(sql: string, values: readonly unknown[]): Promise<unknown>;
}

const uuidV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const hex32 = /^[0-9a-f]{64}$/u;
const instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
function unavailable(): never {
  throw new GuestSessionError("GUEST_SESSION_UNAVAILABLE");
}
function check(pattern: RegExp, value: unknown): string {
  if (typeof value !== "string" || !pattern.test(value)) return unavailable();
  return value;
}
function rowsOf(value: unknown): readonly Record<string, unknown>[] {
  const rows = (value as { rows?: unknown } | null)?.rows;
  if (!Array.isArray(rows)) return unavailable();
  return rows as Record<string, unknown>[];
}
async function scoped(tx: Transaction, scope: GuestContinuityScope) {
  const brand = check(uuidV7, scope.brandReference);
  const store = check(uuidV7, scope.storeReference);
  await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
    brand,
    store,
  ]);
  return { brand, store };
}

/** Records a token (its SHA-256, hex) for this live seated session; the same operation replays. */
export async function issueGuestSessionContinuity(
  tx: Transaction,
  scope: GuestContinuityScope,
  input: {
    readonly continuityReference: string;
    readonly operationReference: string;
    readonly guestSessionReference: string;
    readonly tokenHash: string;
    readonly observedAt: string;
  },
): Promise<void> {
  const { brand, store } = await scoped(tx, scope);
  const operation = check(uuidV7, input.operationReference);
  const prior = rowsOf(
    await tx.query(
      "SELECT guest_session_id::text AS session FROM bop_identity.guest_session_continuity WHERE brand_id=$1 AND store_id=$2 AND operation_id=$3",
      [brand, store, operation],
    ),
  );
  if (prior.length === 1) {
    if (prior[0]?.session !== input.guestSessionReference) return unavailable();
    // A replay can't show the token again (only its hash is kept): the caller issues a new one.
    throw new GuestSessionError("GUEST_SESSION_UNAVAILABLE");
  }
  await tx.query(
    `INSERT INTO bop_identity.guest_session_continuity
     (continuity_id,brand_id,store_id,guest_session_id,continuity_hash,operation_id,issued_at)
     VALUES ($1,$2,$3,$4,decode($5,'hex'),$6,$7)`,
    [
      check(uuidV7, input.continuityReference),
      brand,
      store,
      check(uuidV7, input.guestSessionReference),
      check(hex32, input.tokenHash),
      operation,
      check(instant, input.observedAt),
    ],
  );
}

const seatQuery = `SELECT c.continuity_id::text AS continuity, s.guest_session_id::text AS session,
   s.public_store_id::text AS public_store, s.public_table_id::text AS public_table, s.qr_id::text AS qr,
   s.qr_revocation_version AS qr_version, s.dining_session_id::text AS dining_session,
   s.dining_participant_id::text AS participant, s.locale, s.version
 FROM bop_identity.guest_session_continuity c
 JOIN bop_identity.guest_session s ON s.brand_id=c.brand_id AND s.store_id=c.store_id AND s.guest_session_id=c.guest_session_id
 WHERE c.brand_id=$1 AND c.store_id=$2 AND c.continuity_hash=decode($3,'hex')
  AND NOT EXISTS (SELECT 1 FROM bop_identity.guest_session_continuity_use u WHERE u.brand_id=c.brand_id AND u.store_id=c.store_id AND u.continuity_id=c.continuity_id)
  AND s.status='Active' AND s.channel='DineIn' AND s.dining_state='DiningBound'
  AND s.order_closed_at IS NULL AND s.idle_expires_at>$4::timestamptz AND s.absolute_expires_at>$4::timestamptz`;

function seatOf(row: Record<string, unknown>): GuestContinuitySeat {
  const qrRevocationVersion = Number(row.qr_version);
  if (!Number.isSafeInteger(qrRevocationVersion) || qrRevocationVersion < 1) return unavailable();
  return Object.freeze({
    continuityReference: check(uuidV7, row.continuity),
    guestSessionReference: check(uuidV7, row.session),
    publicStoreReference: check(uuidV7, row.public_store),
    publicTableReference: check(uuidV7, row.public_table),
    qrReference: check(uuidV7, row.qr),
    qrRevocationVersion,
    diningSessionReference: check(uuidV7, row.dining_session),
    participantReference: check(uuidV7, row.participant),
    locale: check(/^[a-z]{2,3}(-[A-Z][a-z]{3})?(-[A-Z]{2}|[0-9]{3})?$/u, row.locale),
  });
}

/** Where the token's session is seated, while the token is unused and that session live; or null. */
export async function findGuestSessionContinuity(
  tx: Transaction,
  scope: GuestContinuityScope,
  input: { readonly tokenHash: string; readonly observedAt: string },
): Promise<GuestContinuitySeat | null> {
  const { brand, store } = await scoped(tx, scope);
  const rows = rowsOf(
    await tx.query(seatQuery, [
      brand,
      store,
      check(hex32, input.tokenHash),
      check(instant, input.observedAt),
    ]),
  );
  return rows.length === 1 ? seatOf(rows[0] as Record<string, unknown>) : null;
}

/**
 * Rotates the token's live seated session into the successor (same dining session, participant,
 * Store, table and code), revoking it 'Rotated', and records the use. Null when the token is used,
 * unknown, or its session is no longer live and seated (nothing written).
 */
export async function rotateGuestSessionByContinuity(
  tx: Transaction,
  scope: GuestContinuityScope,
  input: {
    readonly tokenHash: string;
    readonly operationReference: string;
    readonly observedAt: string;
    readonly successor: {
      readonly guestSessionReference: string;
      readonly sessionSelectorHash: string;
      readonly csrfSelectorHash: string;
      readonly operationIntentHash: string;
    };
  },
): Promise<{
  readonly from: GuestContinuitySeat;
  readonly toGuestSessionReference: string;
} | null> {
  const { brand, store } = await scoped(tx, scope);
  const at = check(instant, input.observedAt);
  const rows = rowsOf(
    await tx.query(seatQuery + " FOR UPDATE OF s", [
      brand,
      store,
      check(hex32, input.tokenHash),
      at,
    ]),
  );
  if (rows.length !== 1) return null;
  const row = rows[0] as Record<string, unknown>;
  const from = seatOf(row);
  const to = check(uuidV7, input.successor.guestSessionReference);
  const retired = rowsOf(
    await tx.query(
      `UPDATE bop_identity.guest_session SET status='Revoked',revocation_reason='Rotated',revoked_at=$5,version=version+1
       WHERE brand_id=$1 AND store_id=$2 AND guest_session_id=$3 AND version=$4 AND status='Active' RETURNING guest_session_id`,
      [brand, store, from.guestSessionReference, Number(row.version), at],
    ),
  );
  if (retired.length !== 1) return unavailable();
  const inserted = rowsOf(
    await tx.query(
      `INSERT INTO bop_identity.guest_session
       (guest_session_id,session_selector_hash,csrf_selector_hash,operation_id,operation_intent_hash,
        brand_id,store_id,public_store_id,public_table_id,channel,locale,qr_id,qr_revocation_version,
        dining_state,status,created_at,last_seen_at,idle_expires_at,absolute_expires_at,version,
        rotated_from_guest_session_id,dining_session_id,dining_participant_id)
       SELECT $1,decode($2,'hex'),decode($3,'hex'),$4,decode($5,'hex'),brand_id,store_id,public_store_id,
        public_table_id,'DineIn',locale,qr_id,qr_revocation_version,'DiningBound','Active',$6,$6,
        $6::timestamptz + interval '4 hours',$6::timestamptz + interval '24 hours',1,guest_session_id,
        dining_session_id,dining_participant_id
       FROM bop_identity.guest_session WHERE brand_id=$7 AND store_id=$8 AND guest_session_id=$9
       RETURNING guest_session_id`,
      [
        to,
        check(hex32, input.successor.sessionSelectorHash),
        check(hex32, input.successor.csrfSelectorHash),
        check(uuidV7, input.operationReference),
        check(hex32, input.successor.operationIntentHash),
        at,
        brand,
        store,
        from.guestSessionReference,
      ],
    ),
  );
  if (inserted.length !== 1) return unavailable();
  const history = rowsOf(
    await tx.query(
      `INSERT INTO bop_identity.guest_session_operation (guest_session_id,session_selector_hash,csrf_selector_hash,operation_id,operation_intent_hash,brand_id,store_id,public_store_id,public_table_id,channel,locale,qr_id,qr_revocation_version,dining_state,status,created_at,last_seen_at,idle_expires_at,absolute_expires_at,version,order_closed_at,closure_expires_at,rotated_from_guest_session_id,revocation_reason,revoked_at,dining_session_id,dining_participant_id)
       SELECT guest_session_id,session_selector_hash,csrf_selector_hash,operation_id,operation_intent_hash,brand_id,store_id,public_store_id,public_table_id,channel,locale,qr_id,qr_revocation_version,dining_state,status,created_at,last_seen_at,idle_expires_at,absolute_expires_at,version,order_closed_at,closure_expires_at,rotated_from_guest_session_id,revocation_reason,revoked_at,dining_session_id,dining_participant_id FROM bop_identity.guest_session WHERE brand_id=$1 AND store_id=$2 AND guest_session_id=$3
       RETURNING operation_id`,
      [brand, store, to],
    ),
  );
  if (history.length !== 1) return unavailable();
  await tx.query(
    `INSERT INTO bop_identity.guest_session_continuity_use
     (continuity_id,brand_id,store_id,from_guest_session_id,to_guest_session_id,operation_id,occurred_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      from.continuityReference,
      brand,
      store,
      from.guestSessionReference,
      to,
      check(uuidV7, input.operationReference),
      at,
    ],
  );
  return Object.freeze({ from, toGuestSessionReference: to });
}
