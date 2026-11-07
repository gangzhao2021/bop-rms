import {
  DiningSessionError,
  parseDiningHash,
  parseDiningInstant,
  parseDiningReference,
  parseDiningSession,
  type DiningInstant,
  type DiningReference,
} from "../../domain/dining-session.js";
import {
  diningStaffCallAnswerIntent,
  diningStaffCallAvailableAt,
  diningStaffCallIntent,
  diningStaffCallWindowMs,
  evaluateDiningStaffCallBudget,
  parseDiningStaffCallAnswerCommand,
  parseDiningStaffCallGuestCommand,
  parseDiningStaffCallReason,
  type DiningStaffCall,
  type DiningStaffCallClosureKind,
  type DiningStaffCallGuestCommand,
  type DiningStaffCallRefusal,
} from "../../domain/dining-staff-call.js";
import { captureSessionData } from "../../application/dining-session-snapshot.js";
import {
  createPostgresDiningStaffCallParticipantFence,
  createPostgresDiningStaffCallParticipationStore,
} from "./dining-participation-store.js";
import type {
  DiningTableStoreScope,
  DiningTableTransaction,
  DiningTableTransactionRunner,
} from "./dining-table-store.js";

/** How long a guest is told that staff answered or that their call was withdrawn. */
export const diningStaffCallClosureShownMs = 10 * 60_000;

export interface DiningStaffCallGuestStatus {
  readonly seated: boolean;
  readonly open: DiningStaffCall | null;
  /** The Session's latest closed call, while it is recent and nothing is open. */
  readonly recentlyClosed: {
    readonly kind: DiningStaffCallClosureKind;
    readonly closedAt: DiningInstant;
  } | null;
  /** Set when the window's calls are used up: when the next call is admitted. */
  readonly nextCallAt: DiningInstant | null;
}

export type DiningStaffCallResult =
  | { readonly status: "Called"; readonly call: DiningStaffCall }
  /** A call was already open (this or another guest's): staff have been asked already. */
  | { readonly status: "AlreadyOpen"; readonly call: DiningStaffCall }
  | {
      readonly status: "Refused";
      readonly reason: DiningStaffCallRefusal;
      readonly retryAt: DiningInstant | null;
    };

export type DiningStaffCallCloseResult =
  | { readonly status: "Closed"; readonly kind: DiningStaffCallClosureKind }
  | { readonly status: "AlreadyClosed"; readonly kind: DiningStaffCallClosureKind }
  | { readonly status: "NotFound" }
  | { readonly status: "NotSeated" };

export interface DiningStaffCallStoreOptions {
  readonly scope: DiningTableStoreScope;
  hashIntent(value: string): string;
  equals(a: string, b: string): boolean;
  /**
   * For guest commands: current Guest identity and Dining binding on this same transaction for
   * this command's Session and participant. Called before and after the writes; anything but
   * `true` rolls back. Staff methods are called inside an authorized merchant transaction instead.
   */
  authorize(tx: DiningTableTransaction, command: DiningStaffCallGuestCommand): Promise<boolean>;
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
const instantSql = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const callColumns = `c.call_id AS call,c.session_id AS session,c.participant_id AS participant,c.reason AS reason,${instantSql("c.called_at")} AS at`;

function call(row: Record<string, unknown>): DiningStaffCall {
  return Object.freeze({
    callReference: parseDiningReference(row.call),
    diningSessionReference: parseDiningReference(row.session),
    participantReference: parseDiningReference(row.participant),
    reason: parseDiningStaffCallReason(row.reason),
    calledAt: parseDiningInstant(row.at),
  });
}
const closure = (value: unknown): DiningStaffCallClosureKind =>
  value === "Answered" || value === "Withdrawn" ? value : fail();

/**
 * DEC-DINING-STAFF-CALL: a seated guest's call for staff, and its closure (staff answered, or a
 * guest at the table withdrew it). Lock order for guest writes: Guest identity (in `authorize`)
 * -> Dining Table -> Session -> participant (the participant fence), then the Session's call
 * advisory lock; a closure takes the call's advisory lock.
 */
export function createPostgresDiningStaffCallStore(
  runner: DiningTableTransactionRunner,
  options: DiningStaffCallStoreOptions,
) {
  const tenant = parseDiningReference(options.scope.tenantReference);
  const brand = parseDiningReference(options.scope.brandReference);
  const store = parseDiningReference(options.scope.storeReference);
  const scope = { tenantReference: tenant, brandReference: brand, storeReference: store };
  const guestCommand = (value: unknown) => {
    const parsed = parseDiningStaffCallGuestCommand(value);
    if (
      parsed.tenantReference !== tenant ||
      parsed.brandReference !== brand ||
      parsed.storeReference !== store
    )
      throw new DiningSessionError("DINING_SESSION_PERMISSION_DENIED");
    return parsed;
  };
  const context = (tx: DiningTableTransaction) =>
    tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
      brand,
      store,
    ]);
  const sessionLock = (tx: DiningTableTransaction, session: string) =>
    tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `DiningStaffCallSession:${tenant}:${brand}:${store}:${session}`,
    ]);
  const callLock = (tx: DiningTableTransaction, reference: string) =>
    tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `DiningStaffCall:${tenant}:${brand}:${store}:${reference}`,
    ]);
  const openCall = async (tx: DiningTableTransaction, session: string) => {
    const found = rows(
      await tx.query(
        `SELECT ${callColumns} FROM rms_dining.dining_staff_call c WHERE c.tenant_id=$1 AND c.brand_id=$2 AND c.store_id=$3 AND c.session_id=$4 AND NOT EXISTS (SELECT 1 FROM rms_dining.dining_staff_call_closure x WHERE x.brand_id=c.brand_id AND x.store_id=c.store_id AND x.call_id=c.call_id) ORDER BY c.called_at DESC LIMIT 2`,
        [tenant, brand, store, session],
      ),
      2,
    );
    // The trigger keeps at most one open call per Session.
    if (found.length > 1) return fail();
    return found[0] ? call(found[0]) : null;
  };
  const windowCalls = async (tx: DiningTableTransaction, session: string, at: DiningInstant) =>
    rows(
      await tx.query(
        `SELECT ${instantSql("called_at")} AS at FROM rms_dining.dining_staff_call WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND session_id=$4 AND called_at>$5::timestamptz-($6::text||' milliseconds')::interval AND called_at<=$5::timestamptz ORDER BY called_at LIMIT 100`,
        [tenant, brand, store, session, at, String(diningStaffCallWindowMs)],
      ),
      100,
    ).map((row) => (typeof row.at === "string" ? row.at : fail()));
  const seated = (
    current: Awaited<
      ReturnType<ReturnType<typeof createPostgresDiningStaffCallParticipationStore>["readCurrent"]>
    >,
    command: DiningStaffCallGuestCommand,
  ) => {
    if (current === null) return false;
    const session = parseDiningSession(current.session);
    return (
      session.diningSessionReference === command.diningSessionReference &&
      // DEC-DINING-STAFF-CALL (2026-10-30): a table checking out still calls staff.
      (session.phase === "Active" || session.phase === "Closing") &&
      current.participant.status === "Active"
    );
  };
  const guest = async <T>(
    value: unknown,
    write: boolean,
    work: (tx: DiningTableTransaction, command: DiningStaffCallGuestCommand) => Promise<T>,
  ): Promise<T> => {
    const accepted = guestCommand(value);
    try {
      return await runner.run(async (tx) => {
        if ((await options.authorize(tx, accepted)) !== true)
          throw new DiningSessionError("DINING_SESSION_PERMISSION_DENIED");
        const result = await work(tx, accepted);
        if (write && (await options.authorize(tx, accepted)) !== true)
          throw new DiningSessionError("DINING_SESSION_PERMISSION_DENIED");
        return result;
      });
    } catch (error) {
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
    }
  };
  const fenced = (tx: DiningTableTransaction, command: DiningStaffCallGuestCommand) =>
    createPostgresDiningStaffCallParticipantFence({ run: (work) => work(tx) }, scope).readCurrent({
      brandReference: brand,
      storeReference: store,
      diningSessionReference: command.diningSessionReference,
      participantReference: command.participantReference,
      observedAt: command.observedAt,
    });
  const priorOperation = async (
    tx: DiningTableTransaction,
    table: "dining_staff_call" | "dining_staff_call_closure",
    operation: string,
    intent: string,
  ) => {
    const prior = rows(
      await tx.query(
        table === "dining_staff_call"
          ? `SELECT ${callColumns},c.intent_hash AS intent FROM rms_dining.dining_staff_call c WHERE c.tenant_id=$1 AND c.brand_id=$2 AND c.store_id=$3 AND c.call_id=$4`
          : "SELECT kind,intent_hash AS intent FROM rms_dining.dining_staff_call_closure WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND operation_id=$4",
        [tenant, brand, store, operation],
      ),
    )[0];
    if (!prior) return null;
    if (
      typeof prior.intent !== "string" ||
      options.equals(parseDiningHash(prior.intent), intent) !== true
    )
      throw new DiningSessionError("DINING_SESSION_IDEMPOTENCY_CONFLICT");
    return prior;
  };
  const closeCall = async (
    tx: DiningTableTransaction,
    input: {
      readonly callReference: DiningReference;
      readonly operationReference: DiningReference;
      readonly kind: DiningStaffCallClosureKind;
      readonly actorReference: DiningReference | null;
      readonly participantReference: DiningReference | null;
      readonly intent: string;
      readonly at: DiningInstant;
      /** Withdrawals only: the call must belong to this Session. */
      readonly session: DiningReference | null;
    },
  ): Promise<DiningStaffCallCloseResult> => {
    const prior = await priorOperation(
      tx,
      "dining_staff_call_closure",
      input.operationReference,
      input.intent,
    );
    if (prior) return Object.freeze({ status: "Closed" as const, kind: closure(prior.kind) });
    await callLock(tx, input.callReference);
    const target = rows(
      await tx.query(
        `SELECT ${callColumns},(SELECT x.kind FROM rms_dining.dining_staff_call_closure x WHERE x.brand_id=c.brand_id AND x.store_id=c.store_id AND x.call_id=c.call_id) AS closed FROM rms_dining.dining_staff_call c WHERE c.tenant_id=$1 AND c.brand_id=$2 AND c.store_id=$3 AND c.call_id=$4`,
        [tenant, brand, store, input.callReference],
      ),
    )[0];
    if (!target) return Object.freeze({ status: "NotFound" as const });
    const found = call(target);
    if (input.session !== null && found.diningSessionReference !== input.session)
      return Object.freeze({ status: "NotFound" as const });
    if (target.closed !== null)
      return Object.freeze({ status: "AlreadyClosed" as const, kind: closure(target.closed) });
    if (input.at < found.calledAt) return fail();
    changed(
      await tx.query(
        "INSERT INTO rms_dining.dining_staff_call_closure (tenant_id,brand_id,store_id,call_id,operation_id,kind,actor_id,participant_id,intent_hash,closed_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
        [
          tenant,
          brand,
          store,
          input.callReference,
          input.operationReference,
          input.kind,
          input.actorReference,
          input.participantReference,
          input.intent,
          input.at,
        ],
      ),
    );
    return Object.freeze({ status: "Closed" as const, kind: input.kind });
  };

  return Object.freeze({
    /** What this guest's phone shows: no write, no lock. */
    async status(value: unknown): Promise<DiningStaffCallGuestStatus> {
      return guest(value, false, async (tx, command) => {
        const current = await createPostgresDiningStaffCallParticipationStore(
          { run: (work) => work(tx) },
          scope,
        ).readCurrent({
          brandReference: brand,
          storeReference: store,
          diningSessionReference: command.diningSessionReference,
          participantReference: command.participantReference,
          observedAt: command.observedAt,
        });
        const isSeated = seated(current, command);
        await context(tx);
        const open = isSeated ? await openCall(tx, command.diningSessionReference) : null;
        let recentlyClosed: DiningStaffCallGuestStatus["recentlyClosed"] = null;
        if (isSeated && open === null) {
          const last = rows(
            await tx.query(
              `SELECT x.kind AS kind,${instantSql("x.closed_at")} AS at FROM rms_dining.dining_staff_call_closure x JOIN rms_dining.dining_staff_call c ON c.brand_id=x.brand_id AND c.store_id=x.store_id AND c.call_id=x.call_id WHERE c.tenant_id=$1 AND c.brand_id=$2 AND c.store_id=$3 AND c.session_id=$4 ORDER BY x.closed_at DESC LIMIT 1`,
              [tenant, brand, store, command.diningSessionReference],
            ),
          )[0];
          if (
            last &&
            Date.parse(command.observedAt) - Date.parse(parseDiningInstant(last.at)) <
              diningStaffCallClosureShownMs
          )
            recentlyClosed = Object.freeze({
              kind: closure(last.kind),
              closedAt: parseDiningInstant(last.at),
            });
        }
        let nextCallAt: DiningInstant | null = null;
        if (isSeated && open === null) {
          const calledAt = await windowCalls(
            tx,
            command.diningSessionReference,
            command.observedAt,
          );
          if (
            evaluateDiningStaffCallBudget({ calledAt, observedAt: command.observedAt }) !==
            "Admitted"
          )
            nextCallAt = diningStaffCallAvailableAt({ calledAt, observedAt: command.observedAt });
        }
        return Object.freeze({ seated: isSeated, open, recentlyClosed, nextCallAt });
      });
    },

    /** Ask staff to come to the table: the call reference is this request's operation reference. */
    async call(value: unknown, reasonValue: unknown): Promise<DiningStaffCallResult> {
      const reason = parseDiningStaffCallReason(reasonValue);
      return guest(value, true, async (tx, command) => {
        const intent = parseDiningHash(
          options.hashIntent(diningStaffCallIntent(command, { kind: "Call", reason })),
        );
        await context(tx);
        const prior = await priorOperation(
          tx,
          "dining_staff_call",
          command.operationReference,
          intent,
        );
        if (prior) return Object.freeze({ status: "Called" as const, call: call(prior) });
        const current = await fenced(tx, command);
        if (!seated(current, command)) return refused("NotSeated", null);
        await sessionLock(tx, command.diningSessionReference);
        const open = await openCall(tx, command.diningSessionReference);
        if (open !== null) return Object.freeze({ status: "AlreadyOpen" as const, call: open });
        const calledAt = await windowCalls(tx, command.diningSessionReference, command.observedAt);
        if (
          evaluateDiningStaffCallBudget({ calledAt, observedAt: command.observedAt }) !== "Admitted"
        )
          return refused(
            "TooManyCalls",
            diningStaffCallAvailableAt({ calledAt, observedAt: command.observedAt }),
          );
        changed(
          await tx.query(
            "INSERT INTO rms_dining.dining_staff_call (tenant_id,brand_id,store_id,call_id,session_id,participant_id,reason,intent_hash,called_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
            [
              tenant,
              brand,
              store,
              command.operationReference,
              command.diningSessionReference,
              command.participantReference,
              reason,
              intent,
              command.observedAt,
            ],
          ),
        );
        return Object.freeze({
          status: "Called" as const,
          call: Object.freeze({
            callReference: command.operationReference,
            diningSessionReference: command.diningSessionReference,
            participantReference: command.participantReference,
            reason,
            calledAt: command.observedAt,
          }),
        });
      });
    },

    /** A guest at the table says it is no longer needed. */
    async withdraw(value: unknown, callValue: unknown): Promise<DiningStaffCallCloseResult> {
      const callReference = parseDiningReference(callValue);
      return guest(value, true, async (tx, command) => {
        const intent = parseDiningHash(
          options.hashIntent(diningStaffCallIntent(command, { kind: "Withdraw", callReference })),
        );
        await context(tx);
        const current = await fenced(tx, command);
        if (!seated(current, command)) return Object.freeze({ status: "NotSeated" as const });
        return closeCall(tx, {
          callReference,
          operationReference: command.operationReference,
          kind: "Withdrawn",
          actorReference: null,
          participantReference: command.participantReference,
          intent,
          at: command.observedAt,
          session: command.diningSessionReference,
        });
      });
    },

    /**
     * Staff: the open call of each listed Session (Tables page). Borrow an authorized merchant
     * transaction; `authorize` is the merchant guard, re-checked after the read.
     */
    async listOpen(
      tx: DiningTableTransaction,
      sessions: readonly string[],
      authorize: () => Promise<boolean> | boolean,
    ): Promise<ReadonlyMap<string, DiningStaffCall>> {
      if (sessions.length > 500) return fail();
      const references = sessions.map((session) => parseDiningReference(session));
      await staffAllowed(authorize);
      if (references.length === 0) return new Map();
      await context(tx);
      const found = rows(
        await tx.query(
          `SELECT ${callColumns} FROM rms_dining.dining_staff_call c WHERE c.tenant_id=$1 AND c.brand_id=$2 AND c.store_id=$3 AND c.session_id=ANY($4::uuid[]) AND NOT EXISTS (SELECT 1 FROM rms_dining.dining_staff_call_closure x WHERE x.brand_id=c.brand_id AND x.store_id=c.store_id AND x.call_id=c.call_id) ORDER BY c.called_at LIMIT 501`,
          [tenant, brand, store, references],
        ),
        501,
      ).map(call);
      await staffAllowed(authorize);
      const open = new Map<string, DiningStaffCall>();
      for (const entry of found) {
        if (open.has(entry.diningSessionReference)) return fail();
        open.set(entry.diningSessionReference, entry);
      }
      return open;
    },

    /** Staff: how many open calls at this Store's open tables (navigation count; checking out too). */
    async countOpen(
      tx: DiningTableTransaction,
      authorize: () => Promise<boolean> | boolean,
    ): Promise<number> {
      await staffAllowed(authorize);
      await context(tx);
      const row = rows(
        await tx.query(
          "SELECT count(*)::int AS open FROM rms_dining.dining_staff_call c JOIN rms_dining.dining_session s ON s.tenant_id=c.tenant_id AND s.brand_id=c.brand_id AND s.store_id=c.store_id AND s.session_id=c.session_id WHERE c.tenant_id=$1 AND c.brand_id=$2 AND c.store_id=$3 AND s.phase IN ('Active','Closing') AND NOT EXISTS (SELECT 1 FROM rms_dining.dining_staff_call_closure x WHERE x.brand_id=c.brand_id AND x.store_id=c.store_id AND x.call_id=c.call_id)",
          [tenant, brand, store],
        ),
      )[0];
      await staffAllowed(authorize);
      const open = row?.open;
      return typeof open === "number" && Number.isSafeInteger(open) && open >= 0 ? open : fail();
    },

    /** Staff answered the call (at the table, or saw it was handled). */
    async answer(
      tx: DiningTableTransaction,
      value: unknown,
      authorize: () => Promise<boolean> | boolean,
    ): Promise<DiningStaffCallCloseResult> {
      const command = parseDiningStaffCallAnswerCommand(value);
      const intent = parseDiningHash(options.hashIntent(diningStaffCallAnswerIntent(command)));
      await staffAllowed(authorize);
      await context(tx);
      const result = await closeCall(tx, {
        callReference: command.callReference,
        operationReference: command.operationReference,
        kind: "Answered",
        actorReference: command.actorReference,
        participantReference: null,
        intent,
        at: command.observedAt,
        session: null,
      });
      await staffAllowed(authorize);
      return result;
    },
  });
}

function refused(
  reason: DiningStaffCallRefusal,
  retryAt: DiningInstant | null,
): DiningStaffCallResult {
  return Object.freeze({ status: "Refused" as const, reason, retryAt });
}

/** The merchant guard answers true only while the authorized run is in progress. */
async function staffAllowed(authorize: () => Promise<boolean> | boolean): Promise<void> {
  if ((await authorize()) !== true)
    throw new DiningSessionError("DINING_SESSION_PERMISSION_DENIED");
}
