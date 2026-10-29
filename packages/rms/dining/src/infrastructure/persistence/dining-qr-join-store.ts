import { appendAuditRecordInTransaction, validateAuditRecord } from "@bop/audit";
import {
  parseDiningJoinCapability,
  parseDiningJoinHumanCode,
  parseDiningJoinInvitationCredential,
  parsePublicCapabilityReference,
  regenerateDiningJoinCapability,
  diningJoinMaximumLifetimeMs,
  type DiningJoinHumanCode,
  type DiningJoinInvitationCredential,
} from "@bop/public-capability";
import {
  DiningSessionError,
  parseDiningInstant,
  parseDiningReference,
  parseDiningSession,
} from "../../domain/dining-session.js";
import { captureSessionData } from "../../application/dining-session-snapshot.js";
import type { DiningCredentialPort } from "../../application/ports/dining-session-ports.js";
import type {
  DiningTableStoreScope,
  DiningTableTransaction,
  DiningTableTransactionRunner,
} from "./dining-table-store.js";

/**
 * WP-2423 item 8 ⑤ DEC-DINING-QR-JOIN (Owner 2026-10-28 decisions 1 and 17): while a table is open,
 * a guest scanning its QR code joins it directly. This store issues the Session's next one-time
 * join capability for that guest (recorded in `dining_qr_join_issue`, never the code) — the
 * existing join then consumes it, so joins keep their records and checks. Staff pause or resume QR
 * joining for the table (then a code from staff or the host is needed) and take a phone off the
 * table (its participant leaves). The database refuses a QR issue while paused, for a Session that
 * is not Active, and beyond 12 per Session in any 10 minutes. Lock order as join and invitation:
 * Guest identity (in `authorize`) -> Dining Table (advisory) -> Session -> current code.
 */
export const diningQrJoinBudget = Object.freeze({ joins: 12, windowMinutes: 10 });

export type DiningQrJoinRefusal = "NotOpen" | "CheckingOut" | "Paused" | "TooManyJoins";

export type DiningQrJoinIssueResult =
  | {
      readonly status: "Issued";
      readonly diningSessionReference: string;
      readonly joinCredential: DiningJoinInvitationCredential | DiningJoinHumanCode;
    }
  | { readonly status: "Refused"; readonly reason: DiningQrJoinRefusal };

export interface DiningQrJoinPhone {
  readonly participantReference: string;
  /** "Phone 1, 2, …" in the order they joined the table (no name). */
  readonly phoneNumber: number;
  readonly joinedAt: string;
  readonly left: boolean;
  readonly removed: boolean;
}

export interface DiningQrJoinState {
  readonly diningSessionReference: string;
  readonly paused: boolean;
  readonly phones: readonly DiningQrJoinPhone[];
}

export interface DiningQrJoinStoreOptions {
  readonly scope: DiningTableStoreScope;
  readonly credentials: Pick<
    DiningCredentialPort,
    "generateReference" | "generateJoinCredential" | "hashJoinCredential" | "hashOperationIntent"
  >;
  readonly pepperVersion: number;
  now(): string;
  /**
   * Called before and after the owner writes on the same transaction; anything but `true` rolls
   * the transaction back. For a QR issue: the guest session is this table's (scanned, not yet
   * joined); for a staff action: the staff member may operate this table.
   */
  authorize(tx: DiningTableTransaction): Promise<boolean>;
  audit(input: {
    readonly action: "Issue" | "Pause" | "Resume" | "Remove";
    readonly operationReference: string;
    readonly tableReference: string;
    readonly actorReference: string | null;
    readonly observedAt: string;
  }): unknown;
}

const fail = (): never => {
  throw new DiningSessionError("DINING_SESSION_DEPENDENCY_UNAVAILABLE");
};
function rows(value: unknown, maximum = 1): readonly Record<string, unknown>[] {
  if (value === null || typeof value !== "object") return fail();
  const descriptor = Object.getOwnPropertyDescriptor(value, "rows");
  if (!descriptor || !("value" in descriptor)) return fail();
  const copied = captureSessionData(descriptor.value);
  if (!Array.isArray(copied) || copied.length > maximum) return fail();
  return copied as Record<string, unknown>[];
}
function changed(value: unknown) {
  if (
    value === null ||
    typeof value !== "object" ||
    Object.getOwnPropertyDescriptor(value, "rowCount")?.value !== 1
  )
    return fail();
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function createPostgresDiningQrJoinStore(
  runner: DiningTableTransactionRunner,
  options: DiningQrJoinStoreOptions,
) {
  const tenant = parseDiningReference(options.scope.tenantReference);
  const brand = parseDiningReference(options.scope.brandReference);
  const store = parseDiningReference(options.scope.storeReference);
  if (!Number.isSafeInteger(options.pepperVersion) || options.pepperVersion < 1) return fail();
  const { credentials } = options;
  const context = (tx: DiningTableTransaction) =>
    tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
      brand,
      store,
    ]);
  const authorized = async (tx: DiningTableTransaction) => {
    if ((await options.authorize(tx)) !== true)
      throw new DiningSessionError("DINING_SESSION_PERMISSION_DENIED");
  };
  const lockTable = (tx: DiningTableTransaction, table: string) =>
    tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `DiningTable:${tenant}:${brand}:${store}:${table}`,
    ]);
  const lockSession = (tx: DiningTableTransaction, session: string) =>
    tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `DiningQrJoin:${brand}:${store}:${session}`,
    ]);
  const pausedOf = async (tx: DiningTableTransaction, session: string) =>
    rows(
      await tx.query(
        "SELECT state FROM rms_dining.dining_qr_join_control WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND session_id=$4 ORDER BY occurred_at DESC, operation_id DESC LIMIT 1",
        [tenant, brand, store, session],
      ),
    )[0]?.state === "Paused";
  const sessionOf = async (tx: DiningTableTransaction, session: string) => {
    const found = rows(
      await tx.query(
        "SELECT session_snapshot AS session, table_id FROM rms_dining.dining_session WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND session_id=$4",
        [tenant, brand, store, session],
      ),
    )[0];
    return found === undefined
      ? null
      : { session: parseDiningSession(found.session), table: parseDiningReference(found.table_id) };
  };
  const audit = async (
    tx: DiningTableTransaction,
    input: Parameters<DiningQrJoinStoreOptions["audit"]>[0],
  ) => {
    const record = validateAuditRecord(options.audit(input), Date.parse(input.observedAt));
    if (
      record.brandId !== brand ||
      record.storeId !== store ||
      record.targetType !== "DiningTable" ||
      record.targetId !== input.tableReference ||
      record.correlationId !== input.operationReference ||
      record.occurredAt !== input.observedAt
    )
      return fail();
    await appendAuditRecordInTransaction(tx, record);
  };
  const guard = <T>(work: () => Promise<T>) =>
    work().catch((error: unknown) => {
      if (
        error instanceof DiningSessionError &&
        [
          "DINING_SESSION_PERMISSION_DENIED",
          "DINING_SESSION_IDEMPOTENCY_CONFLICT",
          "DINING_SESSION_INPUT_INVALID",
        ].includes(error.code)
      )
        throw new DiningSessionError(error.code);
      return fail();
    });

  return Object.freeze({
    /**
     * The guest scanning `tableReference` joins: the open Session's next one-time code, issued
     * for them now (the caller hands it straight to the join). Refused when the table is not
     * open, is checking out, has QR joining paused, or had 12 joins in the last 10 minutes.
     */
    issue(input: {
      readonly operationReference: string;
      readonly guestSessionReference: string;
      readonly tableReference: string;
      readonly observedAt: string;
    }): Promise<DiningQrJoinIssueResult> {
      const operation = parseDiningReference(input.operationReference);
      const guestSession = parseDiningReference(input.guestSessionReference);
      const table = parseDiningReference(input.tableReference);
      const observedAt = parseDiningInstant(input.observedAt);
      return guard(() =>
        runner.run(async (tx) => {
          await authorized(tx);
          await context(tx);
          await lockTable(tx, table);
          const current = rows(
            await tx.query(
              "SELECT session_id, phase FROM rms_dining.dining_session WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND table_id=$4 AND phase IN ('Active','Closing') ORDER BY (session_snapshot->>'startedAt') DESC LIMIT 1",
              [tenant, brand, store, table],
            ),
          )[0];
          if (current === undefined) return refused("NotOpen");
          if (current.phase === "Closing") return refused("CheckingOut");
          const sessionReference = parseDiningReference(current.session_id);
          await lockSession(tx, sessionReference);
          const located = await sessionOf(tx, sessionReference);
          if (located === null || located.table !== table) return fail();
          const session = located.session;
          if (await pausedOf(tx, sessionReference)) return refused("Paused");
          const recent = Number(
            rows(
              await tx.query(
                "SELECT count(*)::int AS n FROM rms_dining.dining_qr_join_issue WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND session_id=$4 AND occurred_at > $5::timestamptz - interval '10 minutes'",
                [tenant, brand, store, sessionReference, observedAt],
              ),
            )[0]?.n ?? 0,
          );
          if (recent >= diningQrJoinBudget.joins) return refused("TooManyJoins");
          const caps = rows(
            await tx.query(
              "SELECT capability_snapshot AS capability FROM rms_dining.dining_join_capability WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND session_id=$4 ORDER BY (capability_snapshot->>'generation')::numeric DESC LIMIT 1 FOR UPDATE",
              [tenant, brand, store, sessionReference],
            ),
          );
          if (!caps.length) return fail();
          const latest = parseDiningJoinCapability(caps[0]?.capability);
          if (
            String(latest.storeReference) !== store ||
            String(latest.diningSessionReference) !== session.diningSessionReference ||
            String(latest.tableReference) !== session.tableReference ||
            latest.assignmentVersion !== session.tableAssignmentVersion ||
            String(latest.issuedAt) > observedAt
          )
            return fail();
          const raw = credentials.generateJoinCredential(latest.kind);
          const joinCredential =
            latest.kind === "Invitation"
              ? parseDiningJoinInvitationCredential(raw)
              : parseDiningJoinHumanCode(raw);
          const replacement = parseDiningJoinCapability({
            ...latest,
            capabilityReference: parsePublicCapabilityReference(
              credentials.generateReference("JoinCapability"),
            ),
            selectorHash: credentials.hashJoinCredential(latest.kind, joinCredential),
            pepperVersion: options.pepperVersion,
            generation: latest.generation + 1,
            status: "Active",
            version: 1,
            issuedAt: observedAt,
            expiresAt: new Date(Date.parse(observedAt) + diningJoinMaximumLifetimeMs).toISOString(),
            consumedAt: null,
            revokedAt: null,
          });
          const transition = regenerateDiningJoinCapability({
            previous: latest,
            replacement,
            observedAt,
          });
          if (!same(transition.current, replacement)) return fail();
          if (latest.status === "Active")
            changed(
              await tx.query(
                "UPDATE rms_dining.dining_join_capability SET version=$6,status=$7,capability_snapshot=$8::jsonb WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND capability_id=$4 AND version=$5",
                [
                  tenant,
                  brand,
                  store,
                  latest.capabilityReference,
                  latest.version,
                  transition.previous.version,
                  transition.previous.status,
                  JSON.stringify(transition.previous),
                ],
              ),
            );
          changed(
            await tx.query(
              "INSERT INTO rms_dining.dining_join_capability (capability_id,tenant_id,brand_id,store_id,session_id,version,status,capability_snapshot) VALUES ($1,$2,$3,$4,$5,1,'Active',$6::jsonb)",
              [
                replacement.capabilityReference,
                tenant,
                brand,
                store,
                sessionReference,
                JSON.stringify(replacement),
              ],
            ),
          );
          const intent = String(
            credentials.hashOperationIntent(`QrJoin:${sessionReference}:${guestSession}`),
          );
          changed(
            await tx.query(
              "INSERT INTO rms_dining.dining_qr_join_issue (tenant_id,brand_id,store_id,operation_id,session_id,guest_session_id,capability_id,intent_hash,occurred_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
              [
                tenant,
                brand,
                store,
                operation,
                sessionReference,
                guestSession,
                replacement.capabilityReference,
                intent,
                observedAt,
              ],
            ),
          );
          await audit(tx, {
            action: "Issue",
            operationReference: operation,
            tableReference: table,
            actorReference: null,
            observedAt,
          });
          await authorized(tx);
          return Object.freeze({
            status: "Issued" as const,
            diningSessionReference: sessionReference,
            joinCredential,
          });
        }),
      );
    },

    /** Whether QR joining is paused, and the table's phones in the order they joined. */
    state(diningSessionReference: string): Promise<DiningQrJoinState> {
      const session = parseDiningReference(diningSessionReference);
      return guard(() =>
        runner.run(async (tx) => {
          await authorized(tx);
          await context(tx);
          const paused = await pausedOf(tx, session);
          const phones = await loadDiningSessionPhones(tx, options.scope, session);
          await authorized(tx);
          return Object.freeze({
            diningSessionReference: session,
            paused,
            phones,
          });
        }),
      );
    },

    /** Staff pause or resume QR joining for the table's open Session. */
    setPaused(input: {
      readonly operationReference: string;
      readonly diningSessionReference: string;
      readonly paused: boolean;
      readonly actorReference: string;
      readonly observedAt: string;
    }): Promise<{ readonly status: "Applied" | "Unchanged" }> {
      const operation = parseDiningReference(input.operationReference);
      const session = parseDiningReference(input.diningSessionReference);
      const actor = parseDiningReference(input.actorReference);
      const observedAt = parseDiningInstant(input.observedAt);
      return guard(() =>
        runner.run(async (tx) => {
          await authorized(tx);
          await context(tx);
          const located = await sessionOf(tx, session);
          if (located === null) return fail();
          await lockTable(tx, located.table);
          await lockSession(tx, session);
          const prior = rows(
            await tx.query(
              "SELECT state FROM rms_dining.dining_qr_join_control WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND operation_id=$4",
              [tenant, brand, store, operation],
            ),
          )[0];
          if (prior !== undefined) {
            if ((prior.state === "Paused") !== input.paused)
              throw new DiningSessionError("DINING_SESSION_IDEMPOTENCY_CONFLICT");
            return { status: "Applied" as const };
          }
          if ((await pausedOf(tx, session)) === input.paused)
            return { status: "Unchanged" as const };
          changed(
            await tx.query(
              "INSERT INTO rms_dining.dining_qr_join_control (tenant_id,brand_id,store_id,operation_id,session_id,state,actor_id,occurred_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
              [
                tenant,
                brand,
                store,
                operation,
                session,
                input.paused ? "Paused" : "Open",
                actor,
                observedAt,
              ],
            ),
          );
          await audit(tx, {
            action: input.paused ? "Pause" : "Resume",
            operationReference: operation,
            tableReference: located.table,
            actorReference: actor,
            observedAt,
          });
          await authorized(tx);
          return { status: "Applied" as const };
        }),
      );
    },

    /**
     * Staff take a phone off the table: its participant leaves (Active -> Left, the existing
     * transition) and the removal is recorded. Its rounds stay on the table's records.
     */
    remove(input: {
      readonly operationReference: string;
      readonly diningSessionReference: string;
      readonly participantReference: string;
      readonly actorReference: string;
      readonly observedAt: string;
    }): Promise<{ readonly status: "Removed" | "AlreadyRemoved" | "NotAtTable" }> {
      const operation = parseDiningReference(input.operationReference);
      const session = parseDiningReference(input.diningSessionReference);
      const participant = parseDiningReference(input.participantReference);
      const actor = parseDiningReference(input.actorReference);
      const observedAt = parseDiningInstant(input.observedAt);
      return guard(() =>
        runner.run(async (tx) => {
          await authorized(tx);
          await context(tx);
          const located = await sessionOf(tx, session);
          if (located === null) return fail();
          await lockTable(tx, located.table);
          const prior = rows(
            await tx.query(
              "SELECT participant_id FROM rms_dining.dining_participant_removal WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND session_id=$4 AND participant_id=$5",
              [tenant, brand, store, session, participant],
            ),
          )[0];
          if (prior !== undefined) return { status: "AlreadyRemoved" as const };
          const found = rows(
            await tx.query(
              "SELECT version, status, participant_snapshot AS snapshot FROM rms_dining.dining_participant WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND session_id=$4 AND participant_id=$5 FOR UPDATE",
              [tenant, brand, store, session, participant],
            ),
          )[0];
          if (found === undefined || found.status !== "Active")
            return { status: "NotAtTable" as const };
          const snapshot = found.snapshot as Record<string, unknown>;
          const version = Number(found.version) + 1;
          changed(
            await tx.query(
              "UPDATE rms_dining.dining_participant SET version=$6,status='Left',participant_snapshot=$7::jsonb WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND session_id=$4 AND participant_id=$5 AND version=$8",
              [
                tenant,
                brand,
                store,
                session,
                participant,
                version,
                JSON.stringify({ ...snapshot, status: "Left", version, leftAt: observedAt }),
                Number(found.version),
              ],
            ),
          );
          changed(
            await tx.query(
              "INSERT INTO rms_dining.dining_participant_removal (tenant_id,brand_id,store_id,operation_id,session_id,participant_id,actor_id,occurred_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
              [tenant, brand, store, operation, session, participant, actor, observedAt],
            ),
          );
          await audit(tx, {
            action: "Remove",
            operationReference: operation,
            tableReference: located.table,
            actorReference: actor,
            observedAt,
          });
          await authorized(tx);
          return { status: "Removed" as const };
        }),
      );
    },
  });
}

function refused(reason: DiningQrJoinRefusal): DiningQrJoinIssueResult {
  return Object.freeze({ status: "Refused" as const, reason });
}

/**
 * The phones that joined a table's Session, numbered 1, 2, … in the order they joined (decision
 * 3: no names), read in the caller's transaction.
 */
export async function loadDiningSessionPhones(
  tx: DiningTableTransaction,
  scopeInput: DiningTableStoreScope,
  diningSessionReference: string,
): Promise<readonly DiningQrJoinPhone[]> {
  const tenant = parseDiningReference(scopeInput.tenantReference);
  const brand = parseDiningReference(scopeInput.brandReference);
  const store = parseDiningReference(scopeInput.storeReference);
  const session = parseDiningReference(diningSessionReference);
  await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
    brand,
    store,
  ]);
  const participants = rows(
    await tx.query(
      `SELECT p.participant_id, p.status, p.participant_snapshot->>'joinedAt' AS joined_at,
 EXISTS (SELECT 1 FROM rms_dining.dining_participant_removal r WHERE r.tenant_id=p.tenant_id AND r.brand_id=p.brand_id
  AND r.store_id=p.store_id AND r.session_id=p.session_id AND r.participant_id=p.participant_id) AS removed
 FROM rms_dining.dining_participant p WHERE p.tenant_id=$1 AND p.brand_id=$2 AND p.store_id=$3 AND p.session_id=$4
 ORDER BY p.participant_snapshot->>'joinedAt', p.participant_id LIMIT 201`,
      [tenant, brand, store, session],
    ),
    200,
  );
  return Object.freeze(
    participants.map((row, index) =>
      Object.freeze({
        participantReference: parseDiningReference(row.participant_id),
        phoneNumber: index + 1,
        joinedAt: parseDiningInstant(row.joined_at),
        left: row.status === "Left",
        removed: row.removed === true,
      }),
    ),
  );
}

/** WP-2423 item 8 ⑤ decision 5: the Store's "a new phone's first round waits for staff". */
export interface DiningRoundHoldSetting {
  /** 0: never changed (off). */
  readonly version: number;
  readonly firstRoundNeedsStaff: boolean;
  readonly changedAt: string | null;
}

/** The Store's current setting, in the caller's transaction (off until a manager turns it on). */
export async function loadDiningRoundHoldSetting(
  tx: DiningTableTransaction,
  scopeInput: DiningTableStoreScope,
): Promise<DiningRoundHoldSetting> {
  const brand = parseDiningReference(scopeInput.brandReference);
  const store = parseDiningReference(scopeInput.storeReference);
  await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
    brand,
    store,
  ]);
  const found = rows(
    await tx.query(
      "SELECT version,first_round_needs_staff,to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS occurred_at FROM rms_dining.dining_round_hold_setting WHERE brand_id=$1 AND store_id=$2 ORDER BY version DESC LIMIT 1",
      [brand, store],
    ),
  )[0];
  if (found === undefined)
    return Object.freeze({ version: 0, firstRoundNeedsStaff: false, changedAt: null });
  const version = Number(found.version);
  if (
    !Number.isSafeInteger(version) ||
    version < 1 ||
    typeof found.first_round_needs_staff !== "boolean"
  )
    return fail();
  return Object.freeze({
    version,
    firstRoundNeedsStaff: found.first_round_needs_staff,
    changedAt: parseDiningInstant(found.occurred_at),
  });
}

/**
 * A manager changes the setting: the next version, with who and when. `expectedVersion` is the
 * version they saw (another change in between is a conflict); the same operation again returns.
 */
export async function changeDiningRoundHoldSetting(
  tx: DiningTableTransaction,
  scopeInput: DiningTableStoreScope,
  input: {
    readonly operationReference: string;
    readonly expectedVersion: number;
    readonly firstRoundNeedsStaff: boolean;
    readonly actorReference: string;
    readonly observedAt: string;
  },
): Promise<DiningRoundHoldSetting> {
  const tenant = parseDiningReference(scopeInput.tenantReference);
  const brand = parseDiningReference(scopeInput.brandReference);
  const store = parseDiningReference(scopeInput.storeReference);
  const operation = parseDiningReference(input.operationReference);
  await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
    brand,
    store,
  ]);
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    `DiningRoundHoldSetting:${brand}:${store}`,
  ]);
  const prior = rows(
    await tx.query(
      "SELECT first_round_needs_staff FROM rms_dining.dining_round_hold_setting WHERE brand_id=$1 AND store_id=$2 AND operation_id=$3",
      [brand, store, operation],
    ),
  )[0];
  if (prior !== undefined) {
    if (prior.first_round_needs_staff !== input.firstRoundNeedsStaff)
      throw new DiningSessionError("DINING_SESSION_IDEMPOTENCY_CONFLICT");
    return loadDiningRoundHoldSetting(tx, scopeInput);
  }
  const current = await loadDiningRoundHoldSetting(tx, scopeInput);
  if (current.version !== input.expectedVersion)
    throw new DiningSessionError("DINING_SESSION_IDEMPOTENCY_CONFLICT");
  if (current.firstRoundNeedsStaff === input.firstRoundNeedsStaff) return current;
  changed(
    await tx.query(
      "INSERT INTO rms_dining.dining_round_hold_setting (tenant_id,brand_id,store_id,version,operation_id,first_round_needs_staff,actor_id,occurred_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
      [
        tenant,
        brand,
        store,
        current.version + 1,
        operation,
        input.firstRoundNeedsStaff,
        parseDiningReference(input.actorReference),
        parseDiningInstant(input.observedAt),
      ],
    ),
  );
  return loadDiningRoundHoldSetting(tx, scopeInput);
}

/**
 * WP-2423 item 8 ⑦ DEC-STORE-FEATURES (Owner 2026-10-28 decision 4): the Store's dine-in service
 * switches. Guests call staff from their phone; servers chase a dish with the kitchen. Both are
 * off until the owner turns them on.
 */
export interface DiningServiceSetting {
  /** 0: never changed (both off). */
  readonly version: number;
  readonly staffCall: boolean;
  readonly chaseDish: boolean;
  /** Owner decision 2 (2000_122): staff record how many guests when opening a table. */
  readonly askPartySize: boolean;
  readonly changedAt: string | null;
}

/** The Store's current switches, in the caller's transaction. */
export async function loadDiningServiceSetting(
  tx: DiningTableTransaction,
  scopeInput: DiningTableStoreScope,
): Promise<DiningServiceSetting> {
  const brand = parseDiningReference(scopeInput.brandReference);
  const store = parseDiningReference(scopeInput.storeReference);
  await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
    brand,
    store,
  ]);
  const found = rows(
    await tx.query(
      "SELECT version,staff_call,chase_dish,ask_party_size,to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS occurred_at FROM rms_dining.dining_service_setting WHERE brand_id=$1 AND store_id=$2 ORDER BY version DESC LIMIT 1",
      [brand, store],
    ),
  )[0];
  if (found === undefined)
    return Object.freeze({
      version: 0,
      staffCall: false,
      chaseDish: false,
      askPartySize: false,
      changedAt: null,
    });
  const version = Number(found.version);
  if (
    !Number.isSafeInteger(version) ||
    version < 1 ||
    typeof found.staff_call !== "boolean" ||
    typeof found.chase_dish !== "boolean" ||
    typeof found.ask_party_size !== "boolean"
  )
    return fail();
  return Object.freeze({
    version,
    staffCall: found.staff_call,
    chaseDish: found.chase_dish,
    askPartySize: found.ask_party_size,
    changedAt: parseDiningInstant(found.occurred_at),
  });
}

/**
 * The owner changes the switches: the next version, with who and when. `expectedVersion` is the
 * version they saw (another change in between is a conflict); the same operation again returns.
 */
export async function changeDiningServiceSetting(
  tx: DiningTableTransaction,
  scopeInput: DiningTableStoreScope,
  input: {
    readonly operationReference: string;
    readonly expectedVersion: number;
    readonly staffCall: boolean;
    readonly chaseDish: boolean;
    /** Absent: kept as it is. */
    readonly askPartySize?: boolean;
    readonly actorReference: string;
    readonly observedAt: string;
  },
): Promise<DiningServiceSetting> {
  const tenant = parseDiningReference(scopeInput.tenantReference);
  const brand = parseDiningReference(scopeInput.brandReference);
  const store = parseDiningReference(scopeInput.storeReference);
  const operation = parseDiningReference(input.operationReference);
  await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
    brand,
    store,
  ]);
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    `DiningServiceSetting:${brand}:${store}`,
  ]);
  const prior = rows(
    await tx.query(
      "SELECT staff_call,chase_dish,ask_party_size FROM rms_dining.dining_service_setting WHERE brand_id=$1 AND store_id=$2 AND operation_id=$3",
      [brand, store, operation],
    ),
  )[0];
  if (prior !== undefined) {
    if (
      prior.staff_call !== input.staffCall ||
      prior.chase_dish !== input.chaseDish ||
      (input.askPartySize !== undefined && prior.ask_party_size !== input.askPartySize)
    )
      throw new DiningSessionError("DINING_SESSION_IDEMPOTENCY_CONFLICT");
    return loadDiningServiceSetting(tx, scopeInput);
  }
  const current = await loadDiningServiceSetting(tx, scopeInput);
  if (current.version !== input.expectedVersion)
    throw new DiningSessionError("DINING_SESSION_IDEMPOTENCY_CONFLICT");
  const askPartySize = input.askPartySize ?? current.askPartySize;
  if (
    current.staffCall === input.staffCall &&
    current.chaseDish === input.chaseDish &&
    current.askPartySize === askPartySize
  )
    return current;
  changed(
    await tx.query(
      "INSERT INTO rms_dining.dining_service_setting (tenant_id,brand_id,store_id,version,operation_id,staff_call,chase_dish,actor_id,occurred_at,ask_party_size) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
      [
        tenant,
        brand,
        store,
        current.version + 1,
        operation,
        input.staffCall,
        input.chaseDish,
        parseDiningReference(input.actorReference),
        parseDiningInstant(input.observedAt),
        askPartySize,
      ],
    ),
  );
  return loadDiningServiceSetting(tx, scopeInput);
}

/**
 * WP-2423 item 8 ⑦ (Owner decision 2): how many guests sit at each of these tables now (2000_122).
 * A table never given a party size is absent from the map.
 */
export async function loadDiningPartySizes(
  tx: DiningTableTransaction,
  scopeInput: DiningTableStoreScope,
  diningSessionReferences: readonly string[],
): Promise<ReadonlyMap<string, { readonly partySize: number; readonly version: number }>> {
  const brand = parseDiningReference(scopeInput.brandReference);
  const store = parseDiningReference(scopeInput.storeReference);
  const sessions = diningSessionReferences.map((reference) => parseDiningReference(reference));
  const found = new Map<string, { partySize: number; version: number }>();
  if (sessions.length === 0) return found;
  await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
    brand,
    store,
  ]);
  const result = (await tx.query(
    "SELECT DISTINCT ON (session_id) session_id::text AS session,version,party_size FROM rms_dining.dining_session_party_size WHERE brand_id=$1 AND store_id=$2 AND session_id=ANY($3::uuid[]) ORDER BY session_id,version DESC",
    [brand, store, sessions],
  )) as { rows?: unknown };
  if (!Array.isArray(result.rows)) return fail();
  for (const row of result.rows as Record<string, unknown>[]) {
    const version = Number(row.version),
      partySize = Number(row.party_size);
    if (
      !Number.isSafeInteger(version) ||
      version < 1 ||
      !Number.isSafeInteger(partySize) ||
      partySize < 1 ||
      partySize > 99
    )
      return fail();
    found.set(String(row.session), Object.freeze({ partySize, version }));
  }
  return found;
}

/**
 * Staff record how many guests sit at an open table: the table's next party-size version, with
 * who and when. `expectedVersion` is the version they saw (0: none yet); another change in
 * between is a conflict. The same operation again returns what it recorded.
 */
export async function recordDiningPartySize(
  tx: DiningTableTransaction,
  scopeInput: DiningTableStoreScope,
  input: {
    readonly diningSessionReference: string;
    readonly operationReference: string;
    readonly expectedVersion: number;
    readonly partySize: number;
    readonly actorReference: string;
    readonly observedAt: string;
  },
): Promise<{ readonly partySize: number; readonly version: number }> {
  const tenant = parseDiningReference(scopeInput.tenantReference);
  const brand = parseDiningReference(scopeInput.brandReference);
  const store = parseDiningReference(scopeInput.storeReference);
  const session = parseDiningReference(input.diningSessionReference);
  const operation = parseDiningReference(input.operationReference);
  if (
    !Number.isSafeInteger(input.partySize) ||
    input.partySize < 1 ||
    input.partySize > 99 ||
    !Number.isSafeInteger(input.expectedVersion) ||
    input.expectedVersion < 0
  )
    return fail();
  await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
    brand,
    store,
  ]);
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    `DiningPartySize:${brand}:${store}:${session}`,
  ]);
  const prior = rows(
    await tx.query(
      "SELECT session_id::text AS session,party_size,version FROM rms_dining.dining_session_party_size WHERE brand_id=$1 AND store_id=$2 AND operation_id=$3",
      [brand, store, operation],
    ),
  )[0];
  if (prior !== undefined) {
    if (String(prior.session) !== session || Number(prior.party_size) !== input.partySize)
      throw new DiningSessionError("DINING_SESSION_IDEMPOTENCY_CONFLICT");
    return Object.freeze({ partySize: input.partySize, version: Number(prior.version) });
  }
  const current = (await loadDiningPartySizes(tx, scopeInput, [session])).get(session);
  if ((current?.version ?? 0) !== input.expectedVersion)
    throw new DiningSessionError("DINING_SESSION_IDEMPOTENCY_CONFLICT");
  if (current?.partySize === input.partySize) return current;
  const version = (current?.version ?? 0) + 1;
  changed(
    await tx.query(
      "INSERT INTO rms_dining.dining_session_party_size (tenant_id,brand_id,store_id,session_id,version,operation_id,party_size,actor_id,recorded_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [
        tenant,
        brand,
        store,
        session,
        version,
        operation,
        input.partySize,
        parseDiningReference(input.actorReference),
        parseDiningInstant(input.observedAt),
      ],
    ),
  );
  return Object.freeze({ partySize: input.partySize, version });
}
