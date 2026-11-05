import { appendAuditRecordInTransaction, validateAuditRecord } from "@bop/audit";
import type { AppendAuditRecordInput } from "@bop/audit";
import { parseDiningInstant, parseDiningReference } from "../../contracts/dining-session.js";
import { createDiningTable, transitionDiningTable } from "../../domain/dining-table.js";
import {
  decideGuestTableStart,
  guestTableCleaningExpiredAuditReason,
  guestTableStartAuditReason,
  guestTableStartBudget,
  type GuestTableStartDecision,
} from "../../domain/dining-guest-table-start.js";
import {
  buildDiningSessionStartRecord,
  type DiningSessionStartCredentials,
} from "../../application/dining-session-service.js";
import { parseDiningPaymentTiming } from "../../domain/dining-payment-timing.js";
import { captureSessionData } from "../../application/dining-session-snapshot.js";
import { createPostgresDiningSessionStartStore } from "./dining-session-start-store.js";
import type {
  DiningTableStoreScope,
  DiningTableTransaction,
  DiningTableTransactionRunner,
} from "./dining-table-store.js";
import { DiningSessionError } from "../../domain/dining-session.js";

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
const instantSql = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const contextOf = (tx: DiningTableTransaction, brand: string, store: string) =>
  tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
    brand,
    store,
  ]);
function scoped(scope: Pick<DiningTableStoreScope, "brandReference" | "storeReference">) {
  return {
    brand: String(parseDiningReference(scope.brandReference)),
    store: String(parseDiningReference(scope.storeReference)),
  };
}

/** The switch and the Store's timing, as a start or a scan needs them. */
async function storeRule(tx: DiningTableTransaction, brand: string, store: string) {
  const setting = rows(
    await tx.query(
      "SELECT version,guest_table_start FROM rms_dining.dining_service_setting WHERE brand_id=$1 AND store_id=$2 ORDER BY version DESC LIMIT 1",
      [brand, store],
    ),
  )[0];
  const timing = rows(
    await tx.query(
      "SELECT payment_timing FROM rms_dining.store_dining_payment_timing WHERE brand_id=$1 AND store_id=$2 ORDER BY version DESC LIMIT 1",
      [brand, store],
    ),
  )[0];
  return Object.freeze({
    switchOn: setting?.guest_table_start === true,
    settingVersion: setting === undefined ? 0 : Number(setting.version),
    storeTiming:
      timing === undefined
        ? ("PayFirst" as const)
        : parseDiningPaymentTiming(timing.payment_timing),
  });
}

/**
 * What a scan of this free table offers, read only: MayStart, BeingCleaned or No. Nothing is written
 * and no row is locked, so a Store with the switch off pays one read at most.
 */
export async function loadDiningGuestTableStart(
  tx: DiningTableTransaction,
  scope: Pick<DiningTableStoreScope, "brandReference" | "storeReference">,
  tableReference: string,
  now: string,
): Promise<GuestTableStartDecision> {
  const { brand, store } = scoped(scope);
  const table = String(parseDiningReference(tableReference));
  await contextOf(tx, brand, store);
  const rule = await storeRule(tx, brand, store);
  if (!rule.switchOn) return Object.freeze({ kind: "No" });
  const found = rows(
    await tx.query(
      "SELECT table_snapshot AS snapshot FROM rms_dining.dining_table WHERE brand_id=$1 AND store_id=$2 AND table_id=$3",
      [brand, store, table],
    ),
  )[0];
  if (found === undefined) return Object.freeze({ kind: "No" });
  const current = createDiningTable(found.snapshot);
  return decideGuestTableStart(
    {
      switchOn: rule.switchOn,
      storeTiming: rule.storeTiming,
      lifecycle: current.lifecycle,
      qrStatus: current.qrStatus,
      operationalState: current.operationalState,
      blockReasonCode: current.blockReasonCode,
      tableObservedAt: current.observedAt,
      occupied: current.activeDiningSessionReference !== null,
    },
    now,
  );
}

/**
 * What a scan of this free table offers a guest: a start only while there is one left to give. With
 * the table's or the Store's starts spent ("Spent") the guest is told what any guest at a table
 * nobody opened is told, so they aren't offered a start that would then refuse them.
 */
export async function loadDiningGuestTableOffer(
  tx: DiningTableTransaction,
  scope: Pick<DiningTableStoreScope, "brandReference" | "storeReference">,
  tableReference: string,
  now: string,
): Promise<GuestTableStartDecision | { readonly kind: "Spent" }> {
  const decision = await loadDiningGuestTableStart(tx, scope, tableReference, now);
  if (decision.kind !== "MayStart") return decision;
  const spent = await countDiningGuestTableStarts(tx, scope, tableReference, now);
  return spent.table >= guestTableStartBudget.perTable ||
    spent.store >= guestTableStartBudget.perStore
    ? Object.freeze({ kind: "Spent" })
    : decision;
}

/** How many tables guests started in the budget window (the database enforces the same). */
export async function countDiningGuestTableStarts(
  tx: DiningTableTransaction,
  scope: Pick<DiningTableStoreScope, "brandReference" | "storeReference">,
  tableReference: string,
  now: string,
): Promise<{ readonly table: number; readonly store: number }> {
  const { brand, store } = scoped(scope);
  await contextOf(tx, brand, store);
  const counted = rows(
    await tx.query(
      `SELECT count(*) FILTER (WHERE table_id=$3)::int AS at_table,count(*)::int AS at_store FROM rms_dining.dining_session_guest_start WHERE brand_id=$1 AND store_id=$2 AND started_at>$4::timestamptz - make_interval(mins => ${guestTableStartBudget.windowMinutes})`,
      [brand, store, String(parseDiningReference(tableReference)), String(parseDiningInstant(now))],
    ),
  )[0];
  return Object.freeze({
    table: Number(counted?.at_table ?? 0),
    store: Number(counted?.at_store ?? 0),
  });
}

/** Which of these sessions a guest started, and when (one read for a page of open tables). */
export async function listDiningGuestStartedSessions(
  tx: DiningTableTransaction,
  scope: Pick<DiningTableStoreScope, "brandReference" | "storeReference">,
  sessionReferences: readonly string[],
): Promise<ReadonlyMap<string, { readonly startedAt: string }>> {
  const { brand, store } = scoped(scope);
  const sessions = sessionReferences.map((value) => String(parseDiningReference(value)));
  const found = new Map<string, { readonly startedAt: string }>();
  if (sessions.length === 0) return found;
  await contextOf(tx, brand, store);
  const listed = rows(
    await tx.query(
      `SELECT session_id::text AS session,${instantSql("started_at")} AS started_at FROM rms_dining.dining_session_guest_start WHERE brand_id=$1 AND store_id=$2 AND session_id=ANY($3::uuid[])`,
      [brand, store, sessions],
    ),
    sessions.length,
  );
  for (const row of listed)
    found.set(
      String(parseDiningReference(row.session)),
      Object.freeze({ startedAt: String(parseDiningInstant(row.started_at)) }),
    );
  return found;
}

/**
 * For a page of tables polled every few seconds: whether guests can start tables here now, and which
 * of these open tables a guest started. One statement, however many tables are open.
 */
export async function loadDiningGuestTableStartPage(
  tx: DiningTableTransaction,
  scope: Pick<DiningTableStoreScope, "brandReference" | "storeReference">,
  sessionReferences: readonly string[],
  observedAt: string,
): Promise<{
  readonly guestTableStart: boolean;
  readonly version: number;
  readonly started: ReadonlyMap<
    string,
    {
      readonly startedAt: string;
      /** Started right after this guest said the table's last party wasn't theirs, ending it. */
      readonly endedLastParty: boolean;
    }
  >;
  /** The Store's budget is spent: a guest at a free table is being asked to see staff right now. */
  readonly storeBudgetSpent: boolean;
}> {
  const { brand, store } = scoped(scope);
  const sessions = sessionReferences.map((value) => String(parseDiningReference(value)));
  await contextOf(tx, brand, store);
  const page = rows(
    await tx.query(
      `SELECT (SELECT jsonb_build_object('version',v.version,'on',v.guest_table_start) FROM rms_dining.dining_service_setting v WHERE v.brand_id=$1 AND v.store_id=$2 ORDER BY v.version DESC LIMIT 1) AS setting,
 (SELECT coalesce(jsonb_agg(jsonb_build_object('session',g.session_id,'at',${instantSql("g.started_at")},'ended',g.ended_session_id IS NOT NULL)),'[]'::jsonb) FROM rms_dining.dining_session_guest_start g WHERE g.brand_id=$1 AND g.store_id=$2 AND g.session_id=ANY($3::uuid[])) AS started,
 (SELECT count(*)::int FROM rms_dining.dining_session_guest_start g WHERE g.brand_id=$1 AND g.store_id=$2 AND g.started_at>$4::timestamptz - make_interval(mins => ${guestTableStartBudget.windowMinutes})) AS store_starts`,
      [brand, store, sessions, String(parseDiningInstant(observedAt))],
    ),
  )[0];
  const setting = page?.setting as { version?: unknown; on?: unknown } | null | undefined;
  const listed = page?.started;
  if (!Array.isArray(listed) || listed.length > sessions.length) return fail();
  const started = new Map<string, { readonly startedAt: string; readonly endedLastParty: boolean }>();
  for (const row of listed as readonly { session?: unknown; at?: unknown; ended?: unknown }[])
    started.set(
      String(parseDiningReference(row.session)),
      Object.freeze({
        startedAt: String(parseDiningInstant(row.at)),
        endedLastParty: row.ended === true,
      }),
    );
  return Object.freeze({
    guestTableStart: setting?.on === true,
    version: setting === null || setting === undefined ? 0 : Number(setting.version),
    started,
    storeBudgetSpent: Number(page?.store_starts ?? 0) >= guestTableStartBudget.perStore,
  });
}

/**
 * The next guest-started tables still open, oldest reference first after `after`, for the System's
 * closing cycle. A cursor walks past tables held by something else, so one stuck table never keeps
 * another from being reached.
 */
export async function listOpenDiningGuestStartedSessions(
  tx: DiningTableTransaction,
  scope: Pick<DiningTableStoreScope, "brandReference" | "storeReference">,
  input: { readonly after: string | null; readonly limit: number },
): Promise<readonly string[]> {
  const { brand, store } = scoped(scope);
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) return fail();
  await contextOf(tx, brand, store);
  const listed = rows(
    await tx.query(
      "SELECT g.session_id::text AS session FROM rms_dining.dining_session_guest_start g JOIN rms_dining.dining_session s ON s.tenant_id=g.tenant_id AND s.brand_id=g.brand_id AND s.store_id=g.store_id AND s.session_id=g.session_id WHERE g.brand_id=$1 AND g.store_id=$2 AND s.phase='Active' AND ($3::uuid IS NULL OR g.session_id>$3::uuid) ORDER BY g.session_id LIMIT $4",
      [brand, store, input.after === null ? null : parseDiningReference(input.after), input.limit],
    ),
    input.limit,
  );
  return Object.freeze(listed.map((row) => String(parseDiningReference(row.session))));
}

/** The open Session a guest started at this table, while the Store's switch is on; else null. */
export async function loadDiningGuestStartedSessionAtTable(
  tx: DiningTableTransaction,
  scope: Pick<DiningTableStoreScope, "brandReference" | "storeReference">,
  tableReference: string,
): Promise<string | null> {
  const { brand, store } = scoped(scope);
  await contextOf(tx, brand, store);
  if (!(await storeRule(tx, brand, store)).switchOn) return null;
  const found = rows(
    await tx.query(
      "SELECT g.session_id::text AS session FROM rms_dining.dining_session_guest_start g JOIN rms_dining.dining_session s ON s.tenant_id=g.tenant_id AND s.brand_id=g.brand_id AND s.store_id=g.store_id AND s.session_id=g.session_id WHERE g.brand_id=$1 AND g.store_id=$2 AND s.table_id=$3 AND s.phase='Active' LIMIT 1",
      [brand, store, String(parseDiningReference(tableReference))],
    ),
  )[0];
  return found === undefined ? null : String(parseDiningReference(found.session));
}

/** The Dining facts of a table's activity and hold: phones, served dishes, an open call. */
export async function loadDiningGuestTableActivity(
  tx: DiningTableTransaction,
  scope: Pick<DiningTableStoreScope, "brandReference" | "storeReference">,
  sessionReferences: readonly string[],
): Promise<
  ReadonlyMap<
    string,
    {
      readonly lastPhoneJoinedAt: string | null;
      readonly lastServedAt: string | null;
      readonly openStaffCall: boolean;
      readonly scanPaused: boolean;
      readonly phase: string;
    }
  >
> {
  const { brand, store } = scoped(scope);
  const sessions = sessionReferences.map((value) => String(parseDiningReference(value)));
  const found = new Map<
    string,
    {
      readonly lastPhoneJoinedAt: string | null;
      readonly lastServedAt: string | null;
      readonly openStaffCall: boolean;
      readonly scanPaused: boolean;
      readonly phase: string;
    }
  >();
  if (sessions.length === 0) return found;
  await contextOf(tx, brand, store);
  const listed = rows(
    await tx.query(
      `SELECT s.session_id::text AS session,s.phase,
 (SELECT max(p.participant_snapshot->>'joinedAt') FROM rms_dining.dining_participant p WHERE p.tenant_id=s.tenant_id AND p.brand_id=s.brand_id AND p.store_id=s.store_id AND p.session_id=s.session_id) AS joined_at,
 (SELECT ${instantSql("max(r.recorded_at)")} FROM rms_dining.dining_item_service_record r WHERE r.tenant_id=s.tenant_id AND r.brand_id=s.brand_id AND r.store_id=s.store_id AND r.session_id=s.session_id) AS served_at,
 EXISTS (SELECT 1 FROM rms_dining.dining_staff_call c WHERE c.tenant_id=s.tenant_id AND c.brand_id=s.brand_id AND c.store_id=s.store_id AND c.session_id=s.session_id AND NOT EXISTS (SELECT 1 FROM rms_dining.dining_staff_call_closure x WHERE x.tenant_id=c.tenant_id AND x.brand_id=c.brand_id AND x.store_id=c.store_id AND x.call_id=c.call_id)) AS open_call,
 (SELECT j.state FROM rms_dining.dining_qr_join_control j WHERE j.tenant_id=s.tenant_id AND j.brand_id=s.brand_id AND j.store_id=s.store_id AND j.session_id=s.session_id ORDER BY j.occurred_at DESC,j.operation_id DESC LIMIT 1) AS scan_state
 FROM rms_dining.dining_session s WHERE s.brand_id=$1 AND s.store_id=$2 AND s.session_id=ANY($3::uuid[])`,
      [brand, store, sessions],
    ),
    sessions.length,
  );
  for (const row of listed)
    found.set(
      String(parseDiningReference(row.session)),
      Object.freeze({
        lastPhoneJoinedAt:
          row.joined_at === null ? null : String(parseDiningInstant(row.joined_at)),
        lastServedAt: row.served_at === null ? null : String(parseDiningInstant(row.served_at)),
        openStaffCall: row.open_call === true,
        scanPaused: row.scan_state === "Paused",
        phase: String(row.phase),
      }),
    );
  return found;
}

export type DiningGuestTableStartResult =
  /** The switch is off, the table isn't one a guest can start: the caller answers as before. */
  | { readonly status: "NotApplicable" }
  | { readonly status: "AlreadyOpen" }
  | { readonly status: "Started"; readonly diningSessionReference: string }
  /** The per-table or per-Store budget is spent. */
  | { readonly status: "Busy" }
  | { readonly status: "BeingCleaned" };

export interface DiningGuestTableStartStoreOptions {
  readonly scope: DiningTableStoreScope;
  readonly credentials: DiningSessionStartCredentials;
  readonly pepperVersion: number;
  now(): string;
  newReference(): string;
  /** The Store's own answer that it takes dine-in orders now (paused or closed: no start). */
  takingDineIn(tx: DiningTableTransaction, at: string): Promise<boolean>;
  readonly retentionPolicyCode: string;
  readonly retentionPolicyVersion: number;
}

/**
 * A guest starts the free table they scanned, in a transaction of its own: it must commit before the
 * join issues the guest's code, because that issue re-reads this table on another connection. The
 * first read locks nothing, so a table already open or a Store with the switch off costs no lock on
 * a row guests and round commits share.
 */
export function createPostgresDiningGuestTableStartStore(
  runner: DiningTableTransactionRunner,
  options: DiningGuestTableStartStoreOptions,
) {
  const tenant = String(parseDiningReference(options.scope.tenantReference));
  const { brand, store } = scoped(options.scope);
  return Object.freeze({
    async startIfFree(input: {
      readonly tableReference: string;
      readonly guestSessionReference: string;
      /** The Session this guest just ended by saying they weren't with the people there. */
      readonly endedSessionReference?: string;
    }): Promise<DiningGuestTableStartResult> {
      const table = String(parseDiningReference(input.tableReference));
      const guest = String(parseDiningReference(input.guestSessionReference));
      const first = await runner.run(async (tx) =>
        loadDiningGuestTableStart(
          tx,
          { brandReference: brand, storeReference: store },
          table,
          options.now(),
        ),
      );
      if (first.kind === "BeingCleaned") return Object.freeze({ status: "BeingCleaned" });
      if (first.kind === "No") {
        const open = await runner.run(async (tx) => {
          await contextOf(tx, brand, store);
          return (
            rows(
              await tx.query(
                "SELECT EXISTS (SELECT 1 FROM rms_dining.dining_session WHERE brand_id=$1 AND store_id=$2 AND table_id=$3 AND phase IN ('Active','Closing')) AS open",
                [brand, store, table],
              ),
            )[0]?.open === true
          );
        });
        return Object.freeze({ status: open ? "AlreadyOpen" : "NotApplicable" });
      }
      return runner.run(async (tx) => {
        await contextOf(tx, brand, store);
        // Before any row lock: the operating read takes Store share locks (identity, then table).
        await tx.query("SAVEPOINT dining_guest_table_operating", []);
        const taking = await options
          .takingDineIn(tx, options.now())
          .catch(() => false)
          .finally(async () => {
            await tx.query("ROLLBACK TO SAVEPOINT dining_guest_table_operating", []);
            await tx.query("RELEASE SAVEPOINT dining_guest_table_operating", []);
          });
        await contextOf(tx, brand, store);
        if (!taking) return Object.freeze({ status: "NotApplicable" as const });
        await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          `DiningTable:${tenant}:${brand}:${store}:${table}`,
        ]);
        const locked = rows(
          await tx.query(
            'SELECT table_snapshot AS "table" FROM rms_dining.dining_table WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND table_id=$4 FOR UPDATE',
            [tenant, brand, store, table],
          ),
        )[0];
        if (locked === undefined) return Object.freeze({ status: "NotApplicable" as const });
        // The instant is taken here, under the lock, so a later phone's clock can't overtake it.
        const startedAt = String(parseDiningInstant(options.now()));
        const before = createDiningTable(locked.table);
        const rule = await storeRule(tx, brand, store);
        const decision = decideGuestTableStart(
          {
            switchOn: rule.switchOn,
            storeTiming: rule.storeTiming,
            lifecycle: before.lifecycle,
            qrStatus: before.qrStatus,
            operationalState: before.operationalState,
            blockReasonCode: before.blockReasonCode,
            tableObservedAt: before.observedAt,
            occupied: before.activeDiningSessionReference !== null,
          },
          startedAt,
        );
        if (before.activeDiningSessionReference !== null)
          return Object.freeze({ status: "AlreadyOpen" as const });
        if (decision.kind === "BeingCleaned")
          return Object.freeze({ status: "BeingCleaned" as const });
        if (decision.kind === "No") return Object.freeze({ status: "NotApplicable" as const });
        const spent = await countDiningGuestTableStarts(
          tx,
          { brandReference: brand, storeReference: store },
          table,
          startedAt,
        );
        if (
          spent.table >= guestTableStartBudget.perTable ||
          spent.store >= guestTableStartBudget.perStore
        )
          return Object.freeze({ status: "Busy" as const });
        // Cleaning not marked within the grace time: cleared on this start, by the System.
        let free = before;
        const instant = startedAt < before.observedAt ? before.observedAt : startedAt;
        if (decision.clearsCleaning) {
          free = await clearCleaningBlock(tx, {
            tenant,
            brand,
            store,
            before,
            instant,
            options,
          });
        }
        const operationReference = options.newReference();
        const started = buildDiningSessionStartRecord({
          credentials: options.credentials,
          pepperVersion: options.pepperVersion,
          brandReference: brand,
          storeReference: store,
          tableReference: table,
          assignmentVersion: free.aggregateVersion,
          actorReference: guest,
          operationReference,
          joinKind: "HumanCode",
          requestedAt: instant,
        });
        await createPostgresDiningSessionStartStore(
          { run: (work) => work(tx) },
          { tenantReference: tenant, brandReference: brand, storeReference: store },
          options.credentials,
        ).start({
          record: started.record,
          expectedAssignmentVersion: free.aggregateVersion,
          audit: {
            auditId: options.newReference(),
            brandId: brand,
            storeId: store,
            actor: { type: "System" },
            actionCode: "DINING_SESSION_START",
            targetType: "DiningTable",
            targetId: table,
            reasonCode: guestTableStartAuditReason,
            correlationId: operationReference,
            occurredAt: instant,
            sourceChannel: "CUSTOMER_PWA",
            dataClassification: "Restricted",
            retentionPolicyCode: options.retentionPolicyCode,
            retentionPolicyVersion: options.retentionPolicyVersion,
          },
        });
        const inserted = (await tx.query(
          "INSERT INTO rms_dining.dining_session_guest_start (tenant_id,brand_id,store_id,session_id,table_id,guest_session_id,operation_id,service_setting_version,started_at,ended_session_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
          [
            tenant,
            brand,
            store,
            started.record.session.diningSessionReference,
            table,
            guest,
            operationReference,
            rule.settingVersion,
            instant,
            input.endedSessionReference === undefined
              ? null
              : String(parseDiningReference(input.endedSessionReference)),
          ],
        )) as { rowCount?: unknown };
        if (inserted.rowCount !== 1) return fail();
        return Object.freeze({
          status: "Started" as const,
          diningSessionReference: String(started.record.session.diningSessionReference),
        });
      });
    },
  });
}

/** The table's expired cleaning block is cleared, with its own operation and a System audit row. */
async function clearCleaningBlock(
  tx: DiningTableTransaction,
  input: {
    tenant: string;
    brand: string;
    store: string;
    before: ReturnType<typeof createDiningTable>;
    instant: string;
    options: DiningGuestTableStartStoreOptions;
  },
) {
  const { tenant, brand, store, before, instant, options } = input;
  const next = transitionDiningTable(before, "ClearBlock", parseDiningInstant(instant));
  const operation = options.newReference();
  const audit: AppendAuditRecordInput = {
    auditId: options.newReference(),
    brandId: brand,
    storeId: store,
    actor: { type: "System" },
    actionCode: "DINING_TABLE_CLEARBLOCK",
    targetType: "DiningTable",
    targetId: before.tableReference,
    reasonCode: guestTableCleaningExpiredAuditReason,
    correlationId: operation,
    occurredAt: instant,
    sourceChannel: "CUSTOMER_PWA",
    dataClassification: "Restricted",
    retentionPolicyCode: options.retentionPolicyCode,
    retentionPolicyVersion: options.retentionPolicyVersion,
  };
  const updated = (await tx.query(
    "UPDATE rms_dining.dining_table SET version=$5,table_snapshot=$6::jsonb,observed_at=$7 WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND table_id=$4 AND version=$8",
    [
      tenant,
      brand,
      store,
      before.tableReference,
      next.aggregateVersion,
      JSON.stringify(next),
      next.observedAt,
      before.aggregateVersion,
    ],
  )) as { rowCount?: unknown };
  if (updated.rowCount !== 1) return fail();
  await appendAuditRecordInTransaction(tx, validateAuditRecord(audit, Date.parse(instant)));
  return next;
}
