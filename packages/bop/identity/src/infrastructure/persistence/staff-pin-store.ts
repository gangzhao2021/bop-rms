import { Buffer } from "node:buffer";
import { appendAuditRecordInTransaction } from "@bop/audit";
import { parseCanonicalInstant, parseOpaqueUuidV7 } from "../../contracts/identity-actor.js";
import {
  assessNewStaffPin,
  parseStoreDeviceLabel,
  readSubmittedStaffPin,
  staffPinPolicy,
  type StaffPinProblem,
  type StaffPinState,
} from "../../contracts/staff-pin.js";
import {
  staffPinBinding,
  staffPinHashesEqual,
  type StaffPinKdf,
  type StaffPinKdfParameters,
} from "../crypto/staff-pin-kdf.js";

/**
 * WP-2423 Q18 option A (DEC-STAFF-SESSION-CONTINUITY section 5): Identity owner of the registered
 * Store tablets, staff PIN credentials, PIN checks and PIN-issued sessions. Every function runs in
 * the caller's transaction; the caller has already authorized the actor (manager permission or the
 * staff member's own full sign-in) except for the tablet checks, which a tablet secret and a PIN
 * authorize by themselves. No PIN, hash, salt, pepper or tablet secret is ever logged, audited or
 * returned; audits name people, tablets and sessions only.
 */
interface Transaction {
  query(sql: string, values: readonly unknown[]): Promise<unknown>;
}
export class StaffPinError extends Error {
  constructor(readonly code: "STAFF_PIN_DENIED" | "STAFF_PIN_UNAVAILABLE") {
    super(code);
    this.name = "StaffPinError";
  }
}
export interface StaffPinAuditPolicy {
  readonly retentionPolicyCode: string;
  readonly retentionPolicyVersion: number;
}
interface Scope {
  readonly brandReference: string;
  readonly storeReference: string;
}
export interface StoreSignInDevice extends Scope {
  readonly deviceReference: string;
  readonly label: string;
  readonly active: boolean;
}
export interface StoreSignInDeviceSummary {
  readonly deviceReference: string;
  readonly label: string;
  readonly registeredAt: string;
  readonly registeredByActorReference: string;
  readonly lastUsedAt: string | null;
}
export interface StaffPinStatus {
  readonly state: StaffPinState;
  readonly changedAt: string | null;
  readonly lockedUntil: string | null;
}
export type StaffPinCheckResult =
  | { readonly status: "Verified"; readonly attemptReference: string }
  | { readonly status: "Rejected" }
  | { readonly status: "Locked"; readonly lockedUntil: string }
  | { readonly status: "Throttled"; readonly retryAfterSeconds: number }
  | { readonly status: "DeviceInactive" };

const denied = (): never => {
  throw new StaffPinError("STAFF_PIN_DENIED");
};
const unavailable = (): never => {
  throw new StaffPinError("STAFF_PIN_UNAVAILABLE");
};
const ref = (value: unknown): string => {
  try {
    return String(parseOpaqueUuidV7(value, "ACTOR_REFERENCE_INVALID"));
  } catch {
    return denied();
  }
};
const instant = (value: unknown): string => {
  try {
    return parseCanonicalInstant(value);
  } catch {
    return denied();
  }
};
function rows(result: unknown): readonly Record<string, unknown>[] {
  if (result === null || typeof result !== "object") return unavailable();
  const descriptor = Object.getOwnPropertyDescriptor(result, "rows");
  if (!descriptor || !("value" in descriptor) || !Array.isArray(descriptor.value))
    return unavailable();
  return descriptor.value as readonly Record<string, unknown>[];
}
function at(value: unknown): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) return unavailable();
  return value.toISOString();
}
const minutes = (n: number) => n * 60_000;
const hex64 = /^[0-9a-f]{64}$/u;
function selector(value: unknown): string {
  return typeof value === "string" && hex64.test(value) ? value : denied();
}
async function setScope(tx: Transaction, scope: Scope) {
  await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
    scope.brandReference,
    scope.storeReference,
  ]);
}
function scopeOf(input: Scope): Scope {
  return { brandReference: ref(input.brandReference), storeReference: ref(input.storeReference) };
}
/** Serialises PIN checks and changes of one staff member at one Store (same key the trigger takes). */
async function lockStaff(tx: Transaction, scope: Scope, actorReference: string) {
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    "StaffPinAttempt:" + scope.brandReference + ":" + scope.storeReference + ":" + actorReference,
  ]);
}
async function lockDevice(tx: Transaction, scope: Scope, deviceReference: string) {
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    "StaffPinDevice:" + scope.brandReference + ":" + scope.storeReference + ":" + deviceReference,
  ]);
}
async function audit(
  tx: Transaction,
  policy: StaffPinAuditPolicy,
  record: {
    readonly auditReference: string;
    readonly scope: Scope;
    readonly actorReference: string | null;
    readonly actionCode: string;
    readonly targetType: string;
    readonly targetReference: string;
    readonly reasonCode: string;
    readonly correlationReference: string;
    readonly occurredAt: string;
    readonly deviceReference?: string;
    readonly afterSummary?: Readonly<Record<string, string | number | boolean | null>>;
  },
) {
  await appendAuditRecordInTransaction(tx, {
    auditId: record.auditReference,
    brandId: record.scope.brandReference,
    storeId: record.scope.storeReference,
    actor:
      record.actorReference === null
        ? { type: "System" }
        : { type: "User", reference: record.actorReference },
    actionCode: record.actionCode,
    targetType: record.targetType,
    targetId: record.targetReference,
    reasonCode: record.reasonCode,
    correlationId: record.correlationReference,
    occurredAt: record.occurredAt,
    sourceChannel: "MERCHANT_WEB",
    ...(record.deviceReference === undefined
      ? {}
      : { deviceNetworkReference: record.deviceReference }),
    ...(record.afterSummary === undefined ? {} : { afterSummary: { ...record.afterSummary } }),
    dataClassification: "Restricted",
    retentionPolicyCode: policy.retentionPolicyCode,
    retentionPolicyVersion: policy.retentionPolicyVersion,
  });
}
/** Ends active sessions; returns how many ended. Caller restricts which ones. */
async function revoke(
  tx: Transaction,
  sql: string,
  values: readonly unknown[],
): Promise<readonly string[]> {
  return rows(await tx.query(sql, values)).map((row) => String(row.session_id));
}

// ---------------------------------------------------------------- Store tablets

/** The tablet a secret's keyed hash names (any Store), or null. Reads that one row only. */
export async function findStoreSignInDevice(
  tx: Transaction,
  input: { readonly selectorHash: string },
): Promise<StoreSignInDevice | null> {
  const hash = selector(input.selectorHash);
  await tx.query("SELECT set_config('bop.identity_device_selector',$1,true)", [hash]);
  try {
    const found = rows(
      await tx.query(
        "SELECT brand_id::text AS brand,store_id::text AS store,device_id::text AS device,label,status FROM bop_identity.store_sign_in_device WHERE device_selector_hash=decode($1,'hex')",
        [hash],
      ),
    );
    if (found.length > 1) return unavailable();
    const row = found[0];
    if (row === undefined) return null;
    return Object.freeze({
      brandReference: ref(row.brand),
      storeReference: ref(row.store),
      deviceReference: ref(row.device),
      label: String(row.label),
      active: row.status === "Active",
    });
  } finally {
    await tx.query("SELECT set_config('bop.identity_device_selector','',true)", []);
  }
}

export async function registerStoreSignInDevice(
  tx: Transaction,
  input: Scope & {
    readonly deviceReference: string;
    readonly selectorHash: string;
    readonly label: unknown;
    readonly actorReference: string;
    readonly sessionReference: string;
    readonly at: string;
    readonly auditReference: string;
  },
  policy: StaffPinAuditPolicy,
): Promise<StoreSignInDeviceSummary | "LabelInvalid"> {
  const scope = scopeOf(input);
  const label = parseStoreDeviceLabel(input.label);
  if (label === null) return "LabelInvalid";
  const device = ref(input.deviceReference),
    actor = ref(input.actorReference),
    session = ref(input.sessionReference),
    observedAt = instant(input.at);
  await setScope(tx, scope);
  await tx.query(
    "INSERT INTO bop_identity.store_sign_in_device (brand_id,store_id,device_id,device_selector_hash,label,status,registered_by_actor_id,registered_by_session_id,registered_at,version,data_classification) VALUES ($1,$2,$3,decode($4,'hex'),$5,'Active',$6,$7,$8,1,'RestrictedCredential')",
    [
      scope.brandReference,
      scope.storeReference,
      device,
      selector(input.selectorHash),
      label,
      actor,
      session,
      observedAt,
    ],
  );
  await audit(tx, policy, {
    auditReference: ref(input.auditReference),
    scope,
    actorReference: actor,
    actionCode: "IDENTITY_STORE_DEVICE_REGISTERED",
    targetType: "StoreSignInDevice",
    targetReference: device,
    reasonCode: "STAFF_PIN_TABLET",
    correlationReference: session,
    occurredAt: observedAt,
    deviceReference: device,
  });
  return Object.freeze({
    deviceReference: device,
    label,
    registeredAt: observedAt,
    registeredByActorReference: actor,
    lastUsedAt: null,
  });
}

/** Revokes an active tablet of this Store and ends every active session a PIN issued on it.
 * null: no such active tablet. */
export async function revokeStoreSignInDevice(
  tx: Transaction,
  input: Scope & {
    readonly deviceReference: string;
    readonly actorReference: string;
    readonly sessionReference: string;
    readonly at: string;
    readonly auditReference: string;
  },
  policy: StaffPinAuditPolicy,
): Promise<{ readonly signedOut: number } | null> {
  const scope = scopeOf(input);
  const device = ref(input.deviceReference),
    actor = ref(input.actorReference),
    session = ref(input.sessionReference),
    observedAt = instant(input.at);
  await setScope(tx, scope);
  await lockDevice(tx, scope, device);
  const updated = rows(
    await tx.query(
      "UPDATE bop_identity.store_sign_in_device SET status='Revoked',version=2,revoked_by_actor_id=$4,revoked_at=$5 WHERE brand_id=$1 AND store_id=$2 AND device_id=$3 AND status='Active' RETURNING device_id",
      [scope.brandReference, scope.storeReference, device, actor, observedAt],
    ),
  );
  if (updated.length !== 1) return null;
  const ended = await revoke(
    tx,
    "UPDATE bop_identity.authentication_session s SET status='Revoked',revocation_reason='Administrative',revoked_at=$4,version=s.version+1 FROM bop_identity.staff_pin_session p WHERE p.brand_id=$1 AND p.store_id=$2 AND p.device_id=$3 AND s.session_id=p.session_id AND s.status='Active' AND s.created_at<=$4 RETURNING s.session_id",
    [scope.brandReference, scope.storeReference, device, observedAt],
  );
  await audit(tx, policy, {
    auditReference: ref(input.auditReference),
    scope,
    actorReference: actor,
    actionCode: "IDENTITY_STORE_DEVICE_REVOKED",
    targetType: "StoreSignInDevice",
    targetReference: device,
    reasonCode: "STAFF_PIN_TABLET",
    correlationReference: session,
    occurredAt: observedAt,
    deviceReference: device,
    afterSummary: { signedOut: ended.length },
  });
  return Object.freeze({ signedOut: ended.length });
}

/** Active tablets of this Store with when a PIN last started a session on each. */
export async function listStoreSignInDevices(
  tx: Transaction,
  input: Scope,
): Promise<readonly StoreSignInDeviceSummary[]> {
  const scope = scopeOf(input);
  await setScope(tx, scope);
  return rows(
    await tx.query(
      "SELECT d.device_id::text AS device,d.label,d.registered_at,d.registered_by_actor_id::text AS registered_by,(SELECT max(p.issued_at) FROM bop_identity.staff_pin_session p WHERE p.brand_id=d.brand_id AND p.store_id=d.store_id AND p.device_id=d.device_id) AS last_used FROM bop_identity.store_sign_in_device d WHERE d.brand_id=$1 AND d.store_id=$2 AND d.status='Active' ORDER BY d.registered_at,d.device_id LIMIT 200",
      [scope.brandReference, scope.storeReference],
    ),
  ).map((row) =>
    Object.freeze({
      deviceReference: ref(row.device),
      label: String(row.label),
      registeredAt: at(row.registered_at),
      registeredByActorReference: ref(row.registered_by),
      lastUsedAt: row.last_used === null ? null : at(row.last_used),
    }),
  );
}

// ---------------------------------------------------------------- PIN credentials

function lockedUntil(
  status: unknown,
  failureNumber: unknown,
  attemptedAt: unknown,
  observedAt: string,
): string | null {
  if (status !== "Active" || Number(failureNumber) !== staffPinPolicy.failureLimit) return null;
  const until = Date.parse(at(attemptedAt)) + minutes(staffPinPolicy.lockMinutes);
  return until > Date.parse(observedAt) ? new Date(until).toISOString() : null;
}

/** Each listed (or every) staff member's PIN state at this Store; absent means never set. */
export async function readStaffPinStates(
  tx: Transaction,
  input: Scope & { readonly at: string; readonly actorReferences?: readonly string[] },
): Promise<ReadonlyMap<string, StaffPinStatus>> {
  const scope = scopeOf(input);
  const observedAt = instant(input.at);
  const actors = input.actorReferences?.map(ref);
  if (actors !== undefined && (actors.length === 0 || actors.length > 500)) return new Map();
  await setScope(tx, scope);
  const found = rows(
    await tx.query(
      "SELECT c.actor_id::text AS actor,c.status,c.changed_at,l.failure_number,l.attempted_at FROM bop_identity.staff_pin_credential c LEFT JOIN LATERAL (SELECT a.failure_number,a.attempted_at FROM bop_identity.staff_pin_attempt a WHERE a.brand_id=c.brand_id AND a.store_id=c.store_id AND a.actor_id=c.actor_id AND a.credential_version=c.credential_version AND a.attempted_at<=$3 ORDER BY a.attempted_at DESC,a.attempt_id DESC LIMIT 1) l ON true WHERE c.brand_id=$1 AND c.store_id=$2" +
        (actors === undefined ? "" : " AND c.actor_id=ANY($4::uuid[])") +
        " LIMIT 1000",
      actors === undefined
        ? [scope.brandReference, scope.storeReference, observedAt]
        : [scope.brandReference, scope.storeReference, observedAt, actors],
    ),
  );
  const states = new Map<string, StaffPinStatus>();
  for (const row of found) {
    if (row.status !== "Active" && row.status !== "Reset") return unavailable();
    states.set(
      ref(row.actor),
      Object.freeze({
        state: row.status === "Active" ? ("Set" as const) : ("Reset" as const),
        changedAt: at(row.changed_at),
        lockedUntil:
          row.attempted_at === null || row.attempted_at === undefined
            ? null
            : lockedUntil(row.status, row.failure_number, row.attempted_at, observedAt),
      }),
    );
  }
  return states;
}

/** The staff member sets (or changes) their own PIN at this Store. */
export async function setStaffPin(
  tx: Transaction,
  input: Scope & {
    readonly actorReference: string;
    readonly sessionReference: string;
    readonly pin: unknown;
    readonly confirmation: unknown;
    readonly at: string;
    readonly auditReference: string;
  },
  kdf: StaffPinKdf,
  policy: StaffPinAuditPolicy,
): Promise<
  | { readonly status: "Set"; readonly changedAt: string }
  | { readonly status: "Invalid"; readonly problem: StaffPinProblem }
> {
  const scope = scopeOf(input);
  const actor = ref(input.actorReference),
    session = ref(input.sessionReference),
    observedAt = instant(input.at);
  const problem = assessNewStaffPin(input.pin, input.confirmation);
  if (problem !== null) return Object.freeze({ status: "Invalid" as const, problem });
  const pin = input.pin as string;
  await setScope(tx, scope);
  await lockStaff(tx, scope, actor);
  const current = rows(
    await tx.query(
      "SELECT credential_version FROM bop_identity.staff_pin_credential WHERE brand_id=$1 AND store_id=$2 AND actor_id=$3 FOR UPDATE",
      [scope.brandReference, scope.storeReference, actor],
    ),
  );
  const parameters = kdf.current;
  const salt = kdf.newSalt();
  let hash: Buffer;
  try {
    hash = await kdf.derive({
      pin,
      salt,
      binding: staffPinBinding({ ...scope, actorReference: actor }),
      parameters,
    });
  } catch {
    return unavailable();
  }
  const values = [
    scope.brandReference,
    scope.storeReference,
    actor,
    parameters.memoryKib,
    parameters.passes,
    parameters.parallelism,
    parameters.pepperVersion,
    salt,
    hash,
    observedAt,
  ];
  let version: number;
  if (current.length === 0) {
    version = 1;
    await tx.query(
      "INSERT INTO bop_identity.staff_pin_credential (brand_id,store_id,actor_id,credential_version,status,kdf_algorithm,kdf_memory_kib,kdf_passes,kdf_parallelism,pepper_version,pin_salt,pin_hash,changed_by_actor_id,changed_at,data_classification) VALUES ($1,$2,$3,1,'Active','argon2id',$4,$5,$6,$7,$8,$9,$3,$10,'RestrictedCredential')",
      values,
    );
  } else {
    version = Number(current[0]?.credential_version) + 1;
    await tx.query(
      "UPDATE bop_identity.staff_pin_credential SET credential_version=credential_version+1,status='Active',kdf_algorithm='argon2id',kdf_memory_kib=$4,kdf_passes=$5,kdf_parallelism=$6,pepper_version=$7,pin_salt=$8,pin_hash=$9,changed_by_actor_id=$3,changed_at=$10 WHERE brand_id=$1 AND store_id=$2 AND actor_id=$3",
      values,
    );
  }
  hash.fill(0);
  await audit(tx, policy, {
    auditReference: ref(input.auditReference),
    scope,
    actorReference: actor,
    actionCode: "IDENTITY_STAFF_PIN_SET",
    targetType: "StaffPin",
    targetReference: actor,
    reasonCode: "STAFF_PIN_SELF_SERVICE",
    correlationReference: session,
    occurredAt: observedAt,
    afterSummary: { pinVersion: version },
  });
  return Object.freeze({ status: "Set" as const, changedAt: observedAt });
}

/** A manager resets a staff member's PIN: the hash is erased (they set a new one after a full
 * sign-in), a lock ends with it, and their PIN-issued sessions at this Store end. */
export async function resetStaffPin(
  tx: Transaction,
  input: Scope & {
    readonly staffReference: string;
    readonly actorReference: string;
    readonly sessionReference: string;
    readonly at: string;
    readonly auditReference: string;
  },
  policy: StaffPinAuditPolicy,
): Promise<
  | { readonly status: "Reset"; readonly changedAt: string; readonly signedOut: number }
  | { readonly status: "NotSet" }
> {
  const scope = scopeOf(input);
  const staff = ref(input.staffReference),
    actor = ref(input.actorReference),
    session = ref(input.sessionReference),
    observedAt = instant(input.at);
  await setScope(tx, scope);
  await lockStaff(tx, scope, staff);
  const current = rows(
    await tx.query(
      "SELECT credential_version,status FROM bop_identity.staff_pin_credential WHERE brand_id=$1 AND store_id=$2 AND actor_id=$3 FOR UPDATE",
      [scope.brandReference, scope.storeReference, staff],
    ),
  );
  if (current.length !== 1 || current[0]?.status !== "Active")
    return Object.freeze({ status: "NotSet" as const });
  await tx.query(
    "UPDATE bop_identity.staff_pin_credential SET credential_version=credential_version+1,status='Reset',kdf_algorithm=NULL,kdf_memory_kib=NULL,kdf_passes=NULL,kdf_parallelism=NULL,pepper_version=NULL,pin_salt=NULL,pin_hash=NULL,changed_by_actor_id=$4,changed_at=$5 WHERE brand_id=$1 AND store_id=$2 AND actor_id=$3",
    [scope.brandReference, scope.storeReference, staff, actor, observedAt],
  );
  const ended = await revoke(
    tx,
    "UPDATE bop_identity.authentication_session s SET status='Revoked',revocation_reason='CredentialReset',revoked_at=$4,version=s.version+1 FROM bop_identity.staff_pin_session p WHERE p.brand_id=$1 AND p.store_id=$2 AND p.actor_id=$3 AND s.session_id=p.session_id AND s.status='Active' AND s.created_at<=$4 RETURNING s.session_id",
    [scope.brandReference, scope.storeReference, staff, observedAt],
  );
  await audit(tx, policy, {
    auditReference: ref(input.auditReference),
    scope,
    actorReference: actor,
    actionCode: "IDENTITY_STAFF_PIN_RESET",
    targetType: "StaffPin",
    targetReference: staff,
    reasonCode: "STAFF_PIN_MANAGER_RESET",
    correlationReference: session,
    occurredAt: observedAt,
    afterSummary: {
      pinVersion: Number(current[0]?.credential_version) + 1,
      signedOut: ended.length,
    },
  });
  return Object.freeze({
    status: "Reset" as const,
    changedAt: observedAt,
    signedOut: ended.length,
  });
}

// ---------------------------------------------------------------- PIN checks on a tablet

/**
 * Checks a staff member's PIN on an active tablet of this Store. The tablet limit is checked
 * first, then the staff member's lock; a wrong or malformed PIN (or a person without a current PIN)
 * is recorded as a rejected check; the fifth consecutive wrong PIN locks the PIN for 15 minutes.
 * A verified check is single-use: `recordStaffPinSession` turns it into one session.
 */
export async function checkStaffPin(
  tx: Transaction,
  input: Scope & {
    readonly deviceReference: string;
    readonly actorReference: string;
    /** False when the person is not an active member of this Store: treated as having no PIN. */
    readonly eligible: boolean;
    readonly pin: unknown;
    readonly at: string;
    readonly attemptReference: string;
    readonly auditReference: string;
    readonly lockAuditReference: string;
  },
  kdf: StaffPinKdf,
  policy: StaffPinAuditPolicy,
): Promise<StaffPinCheckResult> {
  const scope = scopeOf(input);
  const device = ref(input.deviceReference),
    actor = ref(input.actorReference),
    attempt = ref(input.attemptReference),
    observedAt = instant(input.at);
  const now = Date.parse(observedAt);
  await setScope(tx, scope);
  await lockStaff(tx, scope, actor);
  await lockDevice(tx, scope, device);
  const tablet = rows(
    await tx.query(
      "SELECT status FROM bop_identity.store_sign_in_device WHERE brand_id=$1 AND store_id=$2 AND device_id=$3",
      [scope.brandReference, scope.storeReference, device],
    ),
  );
  if (tablet[0]?.status !== "Active") return Object.freeze({ status: "DeviceInactive" as const });
  const deviceFailures = rows(
    await tx.query(
      "SELECT attempted_at FROM bop_identity.staff_pin_attempt WHERE brand_id=$1 AND store_id=$2 AND device_id=$3 AND outcome='Rejected' AND attempted_at>$4 AND attempted_at<=$5 ORDER BY attempted_at ASC LIMIT 100",
      [
        scope.brandReference,
        scope.storeReference,
        device,
        new Date(now - minutes(staffPinPolicy.deviceWindowMinutes)).toISOString(),
        observedAt,
      ],
    ),
  );
  if (deviceFailures.length >= staffPinPolicy.deviceFailureLimit) {
    const freeing = deviceFailures[deviceFailures.length - staffPinPolicy.deviceFailureLimit];
    const freeAt =
      Date.parse(at(freeing?.attempted_at)) + minutes(staffPinPolicy.deviceWindowMinutes);
    return Object.freeze({
      status: "Throttled" as const,
      retryAfterSeconds: Math.max(1, Math.ceil((freeAt - now) / 1000)),
    });
  }
  const credential = rows(
    await tx.query(
      "SELECT credential_version,status,kdf_algorithm,kdf_memory_kib,kdf_passes,kdf_parallelism,pepper_version,pin_salt,pin_hash FROM bop_identity.staff_pin_credential WHERE brand_id=$1 AND store_id=$2 AND actor_id=$3",
      [scope.brandReference, scope.storeReference, actor],
    ),
  )[0];
  const insert =
    "INSERT INTO bop_identity.staff_pin_attempt (brand_id,store_id,attempt_id,device_id,actor_id,credential_version,outcome,rejection_reason,failure_number,attempted_at,audit_id,data_classification) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'IndirectIdentifier')";
  const auditReference = ref(input.auditReference);
  const rejectedAudit = (failureNumber: number | null) =>
    audit(tx, policy, {
      auditReference,
      scope,
      // An unverified claim: recorded by the system about the named staff member's PIN.
      actorReference: null,
      actionCode: "IDENTITY_STAFF_PIN_REJECTED",
      targetType: "StaffPinAttempt",
      targetReference: attempt,
      reasonCode: failureNumber === null ? "STAFF_PIN_NOT_SET" : "STAFF_PIN_MISMATCH",
      correlationReference: attempt,
      occurredAt: observedAt,
      deviceReference: device,
      afterSummary: { subjectActor: actor, failureNumber },
    });
  if (input.eligible !== true || credential === undefined || credential.status !== "Active") {
    // Same work as a real check, so the answer time does not reveal who has a PIN.
    await kdf
      .derive({
        pin: "000000",
        salt: Buffer.alloc(16),
        binding: staffPinBinding({ ...scope, actorReference: actor }),
        parameters: kdf.current,
      })
      .catch(() => undefined);
    await tx.query(insert, [
      scope.brandReference,
      scope.storeReference,
      attempt,
      device,
      actor,
      null,
      "Rejected",
      "NoActivePin",
      null,
      observedAt,
      auditReference,
    ]);
    await rejectedAudit(null);
    return Object.freeze({ status: "Rejected" as const });
  }
  const version = Number(credential.credential_version);
  const latest = rows(
    await tx.query(
      "SELECT outcome,failure_number,attempted_at FROM bop_identity.staff_pin_attempt WHERE brand_id=$1 AND store_id=$2 AND actor_id=$3 AND credential_version=$4 ORDER BY attempted_at DESC,attempt_id DESC LIMIT 1",
      [scope.brandReference, scope.storeReference, actor, version],
    ),
  )[0];
  const latestAt = latest === undefined ? null : Date.parse(at(latest.attempted_at));
  const within = (t: number | null) => t !== null && t > now - minutes(staffPinPolicy.lockMinutes);
  if (
    latest !== undefined &&
    Number(latest.failure_number) === staffPinPolicy.failureLimit &&
    within(latestAt)
  )
    return Object.freeze({
      status: "Locked" as const,
      lockedUntil: new Date((latestAt ?? now) + minutes(staffPinPolicy.lockMinutes)).toISOString(),
    });
  const submitted = readSubmittedStaffPin(input.pin);
  let matched = false;
  if (submitted !== null) {
    const parameters: StaffPinKdfParameters = {
      algorithm: credential.kdf_algorithm === "argon2id" ? "argon2id" : unavailable(),
      memoryKib: Number(credential.kdf_memory_kib),
      passes: Number(credential.kdf_passes),
      parallelism: Number(credential.kdf_parallelism),
      pepperVersion: Number(credential.pepper_version),
    };
    const salt = credential.pin_salt,
      stored = credential.pin_hash;
    if (!(salt instanceof Uint8Array) || !(stored instanceof Uint8Array)) return unavailable();
    let derived: Buffer;
    try {
      derived = await kdf.derive({
        pin: submitted,
        salt: Buffer.from(salt),
        binding: staffPinBinding({ ...scope, actorReference: actor }),
        parameters,
      });
    } catch {
      return unavailable();
    }
    matched = staffPinHashesEqual(derived, stored);
    derived.fill(0);
  }
  if (!matched) {
    const failureNumber =
      latest !== undefined &&
      latest.outcome === "Rejected" &&
      Number(latest.failure_number) < staffPinPolicy.failureLimit &&
      within(latestAt)
        ? Number(latest.failure_number) + 1
        : 1;
    await tx.query(insert, [
      scope.brandReference,
      scope.storeReference,
      attempt,
      device,
      actor,
      version,
      "Rejected",
      "PinMismatch",
      failureNumber,
      observedAt,
      auditReference,
    ]);
    await rejectedAudit(failureNumber);
    if (failureNumber < staffPinPolicy.failureLimit)
      return Object.freeze({ status: "Rejected" as const });
    await audit(tx, policy, {
      auditReference: ref(input.lockAuditReference),
      scope,
      actorReference: null,
      actionCode: "IDENTITY_STAFF_PIN_LOCKED",
      targetType: "StaffPin",
      targetReference: actor,
      reasonCode: "STAFF_PIN_FAILURE_LIMIT",
      correlationReference: attempt,
      occurredAt: observedAt,
      deviceReference: device,
      afterSummary: { lockMinutes: staffPinPolicy.lockMinutes },
    });
    return Object.freeze({
      status: "Locked" as const,
      lockedUntil: new Date(now + minutes(staffPinPolicy.lockMinutes)).toISOString(),
    });
  }
  await tx.query(insert, [
    scope.brandReference,
    scope.storeReference,
    attempt,
    device,
    actor,
    version,
    "Verified",
    null,
    null,
    observedAt,
    auditReference,
  ]);
  await audit(tx, policy, {
    auditReference,
    scope,
    actorReference: actor,
    actionCode: "IDENTITY_STAFF_PIN_VERIFIED",
    targetType: "StaffPinAttempt",
    targetReference: attempt,
    reasonCode: "STAFF_PIN_SWITCH",
    correlationReference: attempt,
    occurredAt: observedAt,
    deviceReference: device,
  });
  return Object.freeze({ status: "Verified" as const, attemptReference: attempt });
}

/**
 * Inside the transaction that creates the new session: ends the session this browser held and
 * every other session a PIN started on this tablet (one person per tablet), then records the new
 * session as PIN-issued from the verified check (once; the database refuses reuse).
 */
export async function recordStaffPinSession(
  tx: Transaction,
  input: Scope & {
    readonly sessionReference: string;
    readonly attemptReference: string;
    readonly deviceReference: string;
    readonly actorReference: string;
    readonly issuedAt: string;
    readonly replacedSessionSelectorHash: string | null;
    readonly auditReference: string;
  },
  policy: StaffPinAuditPolicy,
): Promise<{ readonly signedOut: number }> {
  const scope = scopeOf(input);
  const session = ref(input.sessionReference),
    attempt = ref(input.attemptReference),
    device = ref(input.deviceReference),
    actor = ref(input.actorReference),
    issuedAt = instant(input.issuedAt);
  await setScope(tx, scope);
  await lockDevice(tx, scope, device);
  const onTablet = await revoke(
    tx,
    "UPDATE bop_identity.authentication_session s SET status='Revoked',revocation_reason='Logout',revoked_at=$5,version=s.version+1 FROM bop_identity.staff_pin_session p WHERE p.brand_id=$1 AND p.store_id=$2 AND p.device_id=$3 AND s.session_id=p.session_id AND s.session_id<>$4 AND s.status='Active' AND s.created_at<=$5 RETURNING s.session_id",
    [scope.brandReference, scope.storeReference, device, session, issuedAt],
  );
  const replaced =
    input.replacedSessionSelectorHash === null
      ? []
      : await revoke(
          tx,
          "UPDATE bop_identity.authentication_session SET status='Revoked',revocation_reason='Logout',revoked_at=$3,version=version+1 WHERE session_selector_hash=decode($1,'hex') AND session_id<>$2 AND status='Active' AND created_at<=$3 RETURNING session_id",
          [selector(input.replacedSessionSelectorHash), session, issuedAt],
        );
  await tx.query(
    "INSERT INTO bop_identity.staff_pin_session (brand_id,store_id,session_id,attempt_id,device_id,actor_id,issued_at,data_classification) VALUES ($1,$2,$3,$4,$5,$6,$7,'IndirectIdentifier')",
    [scope.brandReference, scope.storeReference, session, attempt, device, actor, issuedAt],
  );
  const signedOut = new Set([...onTablet, ...replaced]).size;
  await audit(tx, policy, {
    auditReference: ref(input.auditReference),
    scope,
    actorReference: actor,
    actionCode: "IDENTITY_STAFF_PIN_SIGNED_IN",
    targetType: "AuthenticationSession",
    targetReference: session,
    reasonCode: "STAFF_PIN_SWITCH",
    correlationReference: attempt,
    occurredAt: issuedAt,
    deviceReference: device,
    afterSummary: { signedOutOnTablet: signedOut },
  });
  return Object.freeze({ signedOut });
}

/**
 * Inside the transaction that creates a full sign-in on a registered tablet: ends every session a
 * PIN started on that tablet (one person per tablet), so the person who used the tablet before is
 * signed out at once rather than at the next PIN sign-in. Audited only when a session ended.
 */
export async function endStaffPinSessionsOnDevice(
  tx: Transaction,
  input: Scope & {
    readonly deviceReference: string;
    /** The new full sign-in session (kept) and its person. */
    readonly sessionReference: string;
    readonly actorReference: string;
    readonly at: string;
    readonly auditReference: string;
  },
  policy: StaffPinAuditPolicy,
): Promise<{ readonly signedOut: number }> {
  const scope = scopeOf(input);
  const device = ref(input.deviceReference),
    session = ref(input.sessionReference),
    actor = ref(input.actorReference),
    observedAt = instant(input.at);
  await setScope(tx, scope);
  await lockDevice(tx, scope, device);
  const ended = await revoke(
    tx,
    "UPDATE bop_identity.authentication_session s SET status='Revoked',revocation_reason='Logout',revoked_at=$5,version=s.version+1 FROM bop_identity.staff_pin_session p WHERE p.brand_id=$1 AND p.store_id=$2 AND p.device_id=$3 AND s.session_id=p.session_id AND s.session_id<>$4 AND s.status='Active' AND s.created_at<=$5 RETURNING s.session_id",
    [scope.brandReference, scope.storeReference, device, session, observedAt],
  );
  if (ended.length > 0)
    await audit(tx, policy, {
      auditReference: ref(input.auditReference),
      scope,
      actorReference: actor,
      actionCode: "IDENTITY_STAFF_PIN_TABLET_SIGNED_OUT",
      targetType: "AuthenticationSession",
      targetReference: session,
      reasonCode: "FULL_SIGN_IN_ON_TABLET",
      correlationReference: session,
      occurredAt: observedAt,
      deviceReference: device,
      afterSummary: { signedOutOnTablet: ended.length },
    });
  return Object.freeze({ signedOut: ended.length });
}

/**
 * Whether a session was started with a PIN, and if so until when a second-factor step-up made in
 * that session lets it do sensitive actions (null: none recent). Any Store may be selected.
 */
export async function readStaffPinSession(
  tx: Transaction,
  input: { readonly sessionReference: string; readonly at: string },
): Promise<{
  readonly pinIssued: boolean;
  readonly verifiedUntil: string | null;
}> {
  const session = ref(input.sessionReference),
    observedAt = instant(input.at);
  await tx.query("SELECT set_config('bop.identity_session_id',$1,true)", [session]);
  let found: Record<string, unknown> | undefined;
  try {
    const result = rows(
      await tx.query(
        "SELECT brand_id::text AS brand,store_id::text AS store FROM bop_identity.staff_pin_session WHERE session_id=$1",
        [session],
      ),
    );
    if (result.length > 1) return unavailable();
    found = result[0];
  } finally {
    await tx.query("SELECT set_config('bop.identity_session_id','',true)", []);
  }
  if (found === undefined) return Object.freeze({ pinIssued: false, verifiedUntil: null });
  const scope = scopeOf({
    brandReference: String(found.brand),
    storeReference: String(found.store),
  });
  await setScope(tx, scope);
  const now = Date.parse(observedAt);
  const latest = rows(
    await tx.query(
      "SELECT max(attempted_at) AS verified_at FROM bop_identity.workforce_mfa_step_up WHERE brand_id=$1 AND store_id=$2 AND session_id=$3 AND outcome='Verified' AND attempted_at<=$4 AND attempted_at>$5",
      [
        scope.brandReference,
        scope.storeReference,
        session,
        observedAt,
        new Date(now - minutes(staffPinPolicy.elevationMinutes)).toISOString(),
      ],
    ),
  )[0]?.verified_at;
  return Object.freeze({
    pinIssued: true,
    verifiedUntil:
      latest === null || latest === undefined
        ? null
        : new Date(Date.parse(at(latest)) + minutes(staffPinPolicy.elevationMinutes)).toISOString(),
  });
}
