import { t } from "./i18n/i18n.js";
export class DiningSessionClientError extends Error {
  constructor(readonly code: "Denied" | "Unavailable" | "Unknown") {
    super(t("Dining session request unavailable"));
  }
}
const fail = (): never => {
  throw new DiningSessionClientError("Unavailable");
};
const obj = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== "object" || Array.isArray(v)) return fail();
  return v as Record<string, unknown>;
};
const ref = (v: unknown): string => {
  if (
    typeof v !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v)
  )
    return fail();
  return v;
};
const num = (v: unknown): number => {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 1 || v >= 2147483647) return fail();
  return v;
};
const elapsed = (v: unknown): number | null => {
  if (v === null) return null;
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0 || v >= 2147483647) return fail();
  return v;
};
const label = (v: unknown): string => {
  if (
    typeof v !== "string" ||
    !v.trim() ||
    v.length > 120 ||
    Array.from(v).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
  )
    return fail();
  return v;
};
const kind = (v: unknown): "HumanCode" | "Invitation" => {
  if (v !== "HumanCode" && v !== "Invitation") return fail();
  return v;
};
/** A session open longer than this is most likely a table nobody closed. */
export const longOpenSessionMinutes = 12 * 60;
export interface StaffDiningTable {
  tableReference: string;
  stableLabel: string;
  areaCode: string;
  capacity: number;
  lifecycle: "Draft" | "Published";
  operationalState: "Available" | "TemporarilyBlocked";
  /** Why a blocked table is blocked (CLEANING once its guests left); null when available. */
  blockReasonCode?: string | null;
  aggregateVersion: number;
  currentDiningSessionReference: string | null;
  elapsedMinutes: number | null;
  /** WP-2423 Q11: until when the table's printed code works; null when it has none. */
  qrCodeValidUntil: string | null;
  /**
   * DEC-DINE-IN-PAY-LATER: whether rounds at this table are paid as they are sent (PayFirst) or
   * the table pays once at the end (PayLater) — as an open table was opened, as a free one would
   * be opened now. PayFirst from an older server.
   */
  paymentTiming: "PayFirst" | "PayLater";
  /**
   * WP-2423 item 5: rounds staff entered for the party at this table that still wait for their
   * card-machine payment, each with the time it is cancelled if not recorded (oldest first).
   */
  staffRoundsAwaitingPayment: readonly { readonly payBy: string }[];
  /**
   * WP-2423 abandoned payment: guest rounds of the party at this table nobody has paid for yet
   * (for example the guest started paying and left), each cancelled automatically at `payBy`
   * unless paid. Empty from an older server.
   */
  guestRoundsAwaitingPayment: readonly {
    readonly orderReference: string;
    readonly orderBatchReference: string;
    readonly roundNumber: number;
    readonly payBy: string;
  }[];
  /**
   * WP-2423 (v15 2026-10-16): paid rounds of the party at this table staff have not accepted yet,
   * each with when it was paid (never refunded automatically; staff accept it on Orders). Empty
   * from an older server.
   */
  roundsAwaitingAcceptance: readonly { readonly roundNumber: number; readonly paidAt: string }[];
  /**
   * WP-2423 item 8 ⑤ decisions 5–7: guest rounds waiting for staff before the kitchen ("needs
   * action"; never sent or cancelled automatically). Empty from an older server.
   */
  heldRounds?: readonly StaffHeldRound[];
  /** WP-2423 item 8 ⑤ decision 3: phones that joined the table in the last 10 minutes. */
  newPhones?: readonly { readonly phoneNumber: number; readonly joinedAt: string }[];
  /**
   * WP-2423 D4: the open session's phase and version and its Order, for closing the table's
   * session from the Tables page (absent when the staff member may not close sessions).
   */
  session?: StaffDiningTableSession | null;
  /**
   * WP-2423 Q28 DEC-DINING-STAFF-CALL: a guest at the table asked staff to come over and nobody
   * answered yet. Null when nobody is waiting (and from an older server).
   */
  staffCall?: StaffDiningCall | null;
}
export type StaffHeldRoundReason = "FirstOrder" | "PhoneRapid" | "TableRapid";
export interface StaffHeldRound {
  readonly orderReference: string;
  readonly orderBatchReference: string;
  /** Null when the round's number could not be read with it. */
  readonly roundNumber: number | null;
  readonly reason: StaffHeldRoundReason;
  readonly heldAt: string;
}
export type StaffDiningCallReason = "Question" | "TableNeeds" | "OrderProblem";
export interface StaffDiningCall {
  readonly callReference: string;
  readonly reason: StaffDiningCallReason;
  readonly calledAt: string;
}
export interface StaffDiningTableSession {
  readonly phase: "Active" | "Closing";
  readonly version: number;
  /** The session's Order; null while nobody has ordered at the table. */
  readonly orderReference: string | null;
  /** WP-2423 item 8 ⑨: something on the bill was paid, split or written off (not merged). */
  readonly paymentStarted?: boolean;
  /**
   * WP-2423 item 8 ⑨ (DEC-DINING-TABLE-MERGE): the tables merged into this one, oldest first; their
   * Orders are on its bill (staff serve and close their rounds here).
   */
  readonly mergedTables?: readonly {
    readonly fromTableLabel: string;
    readonly orderReference: string | null;
  }[];
}
export interface StaffDiningJoinState {
  diningSessionReference: string;
  tableReference: string;
  sessionVersion: number;
  tableAssignmentVersion: number;
  capabilityVersion: number;
  generation: number;
  joinKind: "HumanCode" | "Invitation";
}
export function createDiningSessionClient(fetcher: typeof fetch = fetch) {
  const send = async (
    path: string,
    body: string,
    csrf: string,
    signal: AbortSignal | undefined,
    mutation = false,
  ) => {
    if (!/^[A-Za-z0-9_-]{43}$/.test(csrf) || signal?.aborted) return fail();
    const controller = new AbortController(),
      abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, 15000);
    try {
      const response = await fetcher(path, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "X-BOP-CSRF": csrf,
        },
        body,
      });
      if (response.status === 401 || response.status === 403 || response.status === 409)
        throw new DiningSessionClientError("Denied");
      if (
        !response.ok ||
        response.headers.get("cache-control") !== "no-store" ||
        !response.headers.get("content-type")?.startsWith("application/json")
      )
        return fail();
      const text = await response.text();
      if (text.length > 100000 || controller.signal.aborted) return fail();
      return obj(JSON.parse(text));
    } catch (error) {
      if (error instanceof DiningSessionClientError && error.code === "Denied") throw error;
      throw new DiningSessionClientError(mutation ? "Unknown" : "Unavailable");
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  };
  const receipt = (r: Record<string, unknown>) => {
    if (r.status !== "Issued" && r.status !== "AlreadyApplied") return fail();
    const joinKind = kind(r.joinKind);
    let joinCredential: string | null = null;
    if (r.status === "Issued") {
      if (
        typeof r.joinCredential !== "string" ||
        !(joinKind === "HumanCode" ? /^[0-9]{6}$/ : /^[A-Za-z0-9_-]{22}$/).test(r.joinCredential)
      )
        return fail();
      joinCredential = r.joinCredential;
    }
    return { status: r.status, joinKind, joinCredential };
  };
  return {
    async tables(csrf: string, after: string | null = null, signal?: AbortSignal) {
      const data = await send(
        "/merchant/dining/tables",
        JSON.stringify({ afterTableReference: after === null ? null : ref(after), limit: 50 }),
        csrf,
        signal,
      );
      if (
        !Array.isArray(data.items) ||
        data.items.length > 50 ||
        typeof data.canOperateTables !== "boolean"
      )
        return fail();
      let previous = after;
      const items = data.items.map((v) => {
        const r = obj(v),
          reference = ref(r.tableReference);
        if (previous !== null && reference <= previous) return fail();
        previous = reference;
        if (
          !["Draft", "Published"].includes(String(r.lifecycle)) ||
          !["Available", "TemporarilyBlocked"].includes(String(r.operationalState))
        )
          return fail();
        const currentDiningSessionReference =
          r.currentDiningSessionReference === null ? null : ref(r.currentDiningSessionReference);
        const elapsedMinutes = elapsed(r.elapsedMinutes);
        if ((currentDiningSessionReference === null) !== (elapsedMinutes === null)) return fail();
        const qrCodeValidUntil =
          r.qrCodeValidUntil === null
            ? null
            : typeof r.qrCodeValidUntil === "string" &&
                /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(r.qrCodeValidUntil)
              ? r.qrCodeValidUntil
              : fail();
        const awaiting =
          r.staffRoundsAwaitingPayment === undefined
            ? []
            : Array.isArray(r.staffRoundsAwaitingPayment) &&
                r.staffRoundsAwaitingPayment.length <= 20 &&
                (currentDiningSessionReference !== null ||
                  r.staffRoundsAwaitingPayment.length === 0)
              ? r.staffRoundsAwaitingPayment.map((entry) => {
                  const round = obj(entry);
                  if (
                    Object.keys(round).length !== 1 ||
                    typeof round.payBy !== "string" ||
                    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(round.payBy)
                  )
                    return fail();
                  return Object.freeze({ payBy: round.payBy });
                })
              : fail();
        const guestAwaiting =
          r.guestRoundsAwaitingPayment === undefined
            ? []
            : Array.isArray(r.guestRoundsAwaitingPayment) &&
                r.guestRoundsAwaitingPayment.length <= 20 &&
                (currentDiningSessionReference !== null ||
                  r.guestRoundsAwaitingPayment.length === 0)
              ? r.guestRoundsAwaitingPayment.map((entry) => {
                  const round = obj(entry);
                  if (
                    Object.keys(round).length !== 4 ||
                    typeof round.payBy !== "string" ||
                    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(round.payBy) ||
                    typeof round.roundNumber !== "number" ||
                    !Number.isSafeInteger(round.roundNumber) ||
                    round.roundNumber < 1
                  )
                    return fail();
                  return Object.freeze({
                    orderReference: ref(round.orderReference),
                    orderBatchReference: ref(round.orderBatchReference),
                    roundNumber: round.roundNumber,
                    payBy: round.payBy,
                  });
                })
              : fail();
        const acceptanceAwaiting =
          r.roundsAwaitingAcceptance === undefined
            ? []
            : Array.isArray(r.roundsAwaitingAcceptance) &&
                r.roundsAwaitingAcceptance.length <= 20 &&
                (currentDiningSessionReference !== null || r.roundsAwaitingAcceptance.length === 0)
              ? r.roundsAwaitingAcceptance.map((entry) => {
                  const round = obj(entry);
                  if (
                    Object.keys(round).length !== 2 ||
                    typeof round.paidAt !== "string" ||
                    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(round.paidAt) ||
                    typeof round.roundNumber !== "number" ||
                    !Number.isSafeInteger(round.roundNumber) ||
                    round.roundNumber < 1
                  )
                    return fail();
                  return Object.freeze({ roundNumber: round.roundNumber, paidAt: round.paidAt });
                })
              : fail();
        // WP-2423 D4: present only for staff who may close sessions (older servers send none).
        const sessionValue: unknown = r.session;
        let session: StaffDiningTableSession | null = null;
        if (sessionValue !== undefined && sessionValue !== null) {
          const facts = obj(sessionValue);
          // WP-2423 item 8 ⑨: paymentStarted and mergedTables (older servers answer without them).
          const merging = "paymentStarted" in facts || "mergedTables" in facts;
          if (
            currentDiningSessionReference === null ||
            Object.keys(facts).length !== (merging ? 5 : 3) ||
            (merging &&
              (typeof facts.paymentStarted !== "boolean" ||
                !Array.isArray(facts.mergedTables) ||
                facts.mergedTables.length > 50)) ||
            (facts.phase !== "Active" && facts.phase !== "Closing") ||
            typeof facts.version !== "number" ||
            !Number.isSafeInteger(facts.version) ||
            facts.version < 1
          )
            return fail();
          session = Object.freeze({
            phase: facts.phase,
            version: facts.version,
            orderReference: facts.orderReference === null ? null : ref(facts.orderReference),
            ...(merging
              ? {
                  paymentStarted: facts.paymentStarted as boolean,
                  mergedTables: Object.freeze(
                    (facts.mergedTables as unknown[]).map((value) => {
                      const merged = obj(value);
                      if (
                        Object.keys(merged).length !== 2 ||
                        typeof merged.fromTableLabel !== "string" ||
                        !/^[^\p{Cc}\p{Cf}<>{}$]{1,40}$/u.test(merged.fromTableLabel)
                      )
                        return fail();
                      return Object.freeze({
                        fromTableLabel: merged.fromTableLabel,
                        orderReference:
                          merged.orderReference === null ? null : ref(merged.orderReference),
                      });
                    }),
                  ),
                }
              : {}),
          });
        }
        // WP-2423 item 8 ⑤: rounds waiting for staff and phones that just joined (open tables).
        const instant = (value: unknown) =>
          typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
            ? value
            : fail();
        const count = (value: unknown) =>
          typeof value === "number" && Number.isSafeInteger(value) && value >= 1 ? value : fail();
        const openOnly = (value: unknown) =>
          value === undefined
            ? []
            : Array.isArray(value) &&
                value.length <= 20 &&
                (currentDiningSessionReference !== null || value.length === 0)
              ? (value as unknown[])
              : fail();
        const heldRounds = openOnly(r.heldRounds).map((entry) => {
          const round = obj(entry);
          if (
            Object.keys(round).length !== 5 ||
            !["FirstOrder", "PhoneRapid", "TableRapid"].includes(String(round.reason))
          )
            return fail();
          return Object.freeze({
            orderReference: ref(round.orderReference),
            orderBatchReference: ref(round.orderBatchReference),
            roundNumber: round.roundNumber === null ? null : count(round.roundNumber),
            reason: round.reason as StaffHeldRoundReason,
            heldAt: instant(round.heldAt),
          });
        });
        const newPhones = openOnly(r.newPhones).map((entry) => {
          const phone = obj(entry);
          if (Object.keys(phone).length !== 2) return fail();
          return Object.freeze({
            phoneNumber: count(phone.phoneNumber),
            joinedAt: instant(phone.joinedAt),
          });
        });
        // WP-2423 Q28: an open call only at a table with an open session.
        const callValue: unknown = r.staffCall;
        let staffCall: StaffDiningCall | null = null;
        if (callValue !== undefined && callValue !== null) {
          const call = obj(callValue);
          if (
            currentDiningSessionReference === null ||
            Object.keys(call).length !== 3 ||
            !["Question", "TableNeeds", "OrderProblem"].includes(String(call.reason)) ||
            typeof call.calledAt !== "string" ||
            !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(call.calledAt)
          )
            return fail();
          staffCall = Object.freeze({
            callReference: ref(call.callReference),
            reason: call.reason as StaffDiningCallReason,
            calledAt: call.calledAt,
          });
        }
        return {
          tableReference: reference,
          stableLabel: label(r.stableLabel),
          areaCode: label(r.areaCode),
          capacity: num(r.capacity),
          lifecycle: r.lifecycle,
          operationalState: r.operationalState,
          blockReasonCode:
            r.blockReasonCode === undefined || r.blockReasonCode === null
              ? null
              : typeof r.blockReasonCode === "string" &&
                  /^[A-Z][A-Z0-9_-]{0,63}$/u.test(r.blockReasonCode)
                ? r.blockReasonCode
                : fail(),
          aggregateVersion: num(r.aggregateVersion),
          currentDiningSessionReference,
          elapsedMinutes,
          qrCodeValidUntil,
          paymentTiming:
            r.paymentTiming === undefined || r.paymentTiming === "PayFirst"
              ? "PayFirst"
              : r.paymentTiming === "PayLater"
                ? "PayLater"
                : fail(),
          staffRoundsAwaitingPayment: Object.freeze(awaiting),
          guestRoundsAwaitingPayment: Object.freeze(guestAwaiting),
          heldRounds: Object.freeze(heldRounds),
          newPhones: Object.freeze(newPhones),
          roundsAwaitingAcceptance: Object.freeze(acceptanceAwaiting),
          session,
          staffCall,
        } as StaffDiningTable;
      });
      const next = data.nextAfterTableReference === null ? null : ref(data.nextAfterTableReference);
      if (next !== null && (items.length !== 50 || next !== previous)) return fail();
      return {
        items,
        next,
        canOperateTables: data.canOperateTables,
        /** WP-2423 D4: the staff member may close a table's session (and its Order) here. */
        canCloseSessions: data.canCloseSessions === true,
        /**
         * WP-2423: the staff member may transfer a table's order host (an older server sends
         * nothing: the section is offered and the server decides, as before).
         */
        canTransferHost: data.canTransferHost !== false,
        /** WP-2423 abandoned payment: the staff member may cancel unpaid rounds here. */
        canCancelUnpaidRounds: data.canCancelUnpaidRounds === true,
        /** WP-2423 item 8 ①: a manager may record that the guests left without paying. */
        canWriteOff: data.canWriteOff === true,
      };
    },
    prepareAvailability(
      table: StaffDiningTable,
      action: "SetBlock" | "ClearBlock",
      reasonCode: string | null,
      operation: string,
    ) {
      const command = {
          action,
          tableReference: ref(table.tableReference),
          expectedAggregateVersion: num(table.aggregateVersion),
          operationReference: ref(operation),
          reasonCode,
        },
        expectedState: "TemporarilyBlocked" | "Available" =
          action === "SetBlock" ? "TemporarilyBlocked" : "Available";
      if (
        (action === "SetBlock" &&
          (table.operationalState !== "Available" ||
            typeof reasonCode !== "string" ||
            !/^[A-Z][A-Z0-9_-]{0,63}$/.test(reasonCode))) ||
        (action === "ClearBlock" &&
          (table.operationalState !== "TemporarilyBlocked" || reasonCode !== null))
      )
        return fail();
      const body = JSON.stringify(command);
      return {
        execute: async (csrf: string, signal?: AbortSignal) => {
          const r = await send("/merchant/dining/tables/availability", body, csrf, signal, true);
          try {
            if (
              !["Applied", "AlreadyApplied"].includes(String(r.status)) ||
              ref(r.tableReference) !== command.tableReference ||
              r.operationalState !== expectedState ||
              num(r.aggregateVersion) !== command.expectedAggregateVersion + 1
            )
              return fail();
            return {
              status: r.status as "Applied" | "AlreadyApplied",
              operationalState: expectedState,
              aggregateVersion: command.expectedAggregateVersion + 1,
            };
          } catch {
            throw new DiningSessionClientError("Unknown");
          }
        },
      };
    },
    async joinState(
      session: string,
      csrf: string,
      signal?: AbortSignal,
    ): Promise<StaffDiningJoinState> {
      const r = await send(
        "/merchant/dining/sessions/join-state",
        JSON.stringify({ diningSessionReference: ref(session) }),
        csrf,
        signal,
      );
      if (ref(r.diningSessionReference) !== session) return fail();
      return {
        diningSessionReference: session,
        tableReference: ref(r.tableReference),
        sessionVersion: num(r.sessionVersion),
        tableAssignmentVersion: num(r.tableAssignmentVersion),
        capabilityVersion: num(r.capabilityVersion),
        generation: num(r.generation),
        joinKind: kind(r.joinKind),
      };
    },
    prepareStart(table: StaffDiningTable, operation: string) {
      const command = {
        tableReference: ref(table.tableReference),
        expectedAssignmentVersion: num(table.aggregateVersion),
        operationReference: ref(operation),
        joinKind: "HumanCode",
      };
      if (
        table.lifecycle !== "Published" ||
        table.operationalState !== "Available" ||
        table.currentDiningSessionReference !== null
      )
        return fail();
      const body = JSON.stringify(command);
      return {
        execute: async (csrf: string, signal?: AbortSignal) => {
          const r = await send("/merchant/dining/sessions/start", body, csrf, signal, true);
          try {
            const parsed = receipt(r);
            if (
              ref(r.tableReference) !== command.tableReference ||
              num(r.tableAssignmentVersion) !== command.expectedAssignmentVersion ||
              parsed.joinKind !== "HumanCode"
            )
              return fail();
            return {
              ...parsed,
              diningSessionReference: ref(r.diningSessionReference),
              sessionVersion: num(r.sessionVersion),
            };
          } catch {
            throw new DiningSessionClientError("Unknown");
          }
        },
      };
    },
    prepareRegenerate(state: StaffDiningJoinState, operation: string) {
      const command = {
          diningSessionReference: ref(state.diningSessionReference),
          tableReference: ref(state.tableReference),
          expectedAssignmentVersion: num(state.tableAssignmentVersion),
          expectedSessionVersion: num(state.sessionVersion),
          expectedCapabilityVersion: num(state.capabilityVersion),
          expectedGeneration: num(state.generation),
          operationReference: ref(operation),
        },
        expectedKind = kind(state.joinKind),
        body = JSON.stringify(command);
      return {
        execute: async (csrf: string, signal?: AbortSignal) => {
          const r = await send("/merchant/dining/sessions/regenerate", body, csrf, signal, true);
          try {
            const parsed = receipt(r);
            if (
              num(r.generation) !== command.expectedGeneration + 1 ||
              parsed.joinKind !== expectedKind
            )
              return fail();
            num(r.capabilityVersion);
            return {
              ...parsed,
              diningSessionReference: command.diningSessionReference,
              sessionVersion: command.expectedSessionVersion,
            };
          } catch {
            throw new DiningSessionClientError("Unknown");
          }
        },
      };
    },
    /** WP-2423 Q28: how many guests at this Store are waiting for staff (navigation count). */
    async staffCallCount(csrf: string, signal?: AbortSignal) {
      const data = await send("/merchant/dining/staff-calls/count", "{}", csrf, signal);
      if (
        Object.keys(data).length !== 1 ||
        typeof data.open !== "number" ||
        !Number.isSafeInteger(data.open) ||
        data.open < 0
      )
        return fail();
      return data.open;
    },
    /** WP-2423 Q28: staff went to the table; repeat the same operation only to recover. */
    async answerStaffCall(csrf: string, operationReference: string, callReference: string) {
      const data = await send(
        "/merchant/dining/staff-calls/answer",
        JSON.stringify({
          operationReference: ref(operationReference),
          callReference: ref(callReference),
        }),
        csrf,
        undefined,
        true,
      );
      if (
        Object.keys(data).length !== 1 ||
        (data.status !== "Answered" &&
          data.status !== "AlreadyClosed" &&
          data.status !== "NotFound")
      )
        throw new DiningSessionClientError("Unknown");
      return data.status;
    },
  };
}
