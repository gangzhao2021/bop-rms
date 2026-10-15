export class DiningSessionClientError extends Error {
  constructor(readonly code: "Denied" | "Unavailable" | "Unknown") {
    super("Dining session request unavailable");
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
export interface StaffDiningTable {
  tableReference: string;
  stableLabel: string;
  areaCode: string;
  capacity: number;
  lifecycle: "Draft" | "Published";
  operationalState: "Available" | "TemporarilyBlocked";
  aggregateVersion: number;
  currentDiningSessionReference: string | null;
  elapsedMinutes: number | null;
  /** WP-2423 Q11: until when the table's printed code works; null when it has none. */
  qrCodeValidUntil: string | null;
  /**
   * WP-2423 item 5: rounds staff entered for the party at this table that still wait for their
   * card-machine payment, each with the time it is cancelled if not recorded (oldest first).
   */
  staffRoundsAwaitingPayment: readonly { readonly payBy: string }[];
  /**
   * WP-2423 D4: the open session's phase and version and its Order, for closing the table's
   * session from the Tables page (absent when the staff member may not close sessions).
   */
  session?: StaffDiningTableSession | null;
}
export interface StaffDiningTableSession {
  readonly phase: "Active" | "Closing";
  readonly version: number;
  /** The session's Order; null while nobody has ordered at the table. */
  readonly orderReference: string | null;
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
        // WP-2423 D4: present only for staff who may close sessions (older servers send none).
        const sessionValue: unknown = r.session;
        let session: StaffDiningTableSession | null = null;
        if (sessionValue !== undefined && sessionValue !== null) {
          const facts = obj(sessionValue);
          if (
            currentDiningSessionReference === null ||
            Object.keys(facts).length !== 3 ||
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
          });
        }
        return {
          tableReference: reference,
          stableLabel: label(r.stableLabel),
          areaCode: label(r.areaCode),
          capacity: num(r.capacity),
          lifecycle: r.lifecycle,
          operationalState: r.operationalState,
          aggregateVersion: num(r.aggregateVersion),
          currentDiningSessionReference,
          elapsedMinutes,
          qrCodeValidUntil,
          staffRoundsAwaitingPayment: Object.freeze(awaiting),
          session,
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
  };
}
