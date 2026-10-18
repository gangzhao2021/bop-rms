import { UnpaidRoundCancelAction, isPaymentUnconfirmed } from "./UnpaidRoundCancelAction.js";
import { paidRoundWait, tableRoundWaitText, type PaidRoundWaitTier } from "./paid-round-wait.js";
import { DiningHostTransferAction } from "./DiningHostTransferAction.js";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useStaffSessionLive } from "./staff-session-reads.js";
import { AppFrame } from "@bop-rms/ui";
import { Link } from "react-router";
import {
  createDiningSessionClient,
  DiningSessionClientError,
  longOpenSessionMinutes,
  type StaffDiningTable,
} from "./dining-session-client.js";
import { serviceOperationReference } from "./service-control-client.js";
import { storeTime } from "./StoreTime.js";
import { TableSessionClose } from "./TableSessionClose.js";
import {
  browserOffline,
  StaleReadNotice,
  useBrowserOffline,
  useStaleRetry,
  type StaleRead,
} from "./stale-read.js";
type Operation = ReturnType<ReturnType<typeof createDiningSessionClient>["prepareStart"]>;
type AvailabilityOperation = ReturnType<
  ReturnType<typeof createDiningSessionClient>["prepareAvailability"]
>;
/** WP-2423 Q8: staff pick a plain reason; the stored reason stays a stable code. */
const tableBlockReasons = [
  ["CLEANING", "Being cleaned"],
  ["RESERVED", "Reserved"],
  ["OUT_OF_SERVICE", "Out of service"],
  ["AREA_CLOSED", "Section closed"],
] as const;
/** WP-2423 follow-up: how long a session has been open, in words staff read at a glance. */
export function elapsedText(minutes: number): string {
  if (minutes < 60) return `${String(minutes)} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return rest === 0 ? `${String(hours)} h` : `${String(hours)} h ${String(rest)} min`;
  }
  const days = Math.floor(hours / 24);
  return `${String(days)} day${days === 1 ? "" : "s"}`;
}
export { longOpenSessionMinutes };
/** What staff see on the floor: free, blocked, seated, or seated so long the guests have likely left. */
export type TableFloorState = "Available" | "Unavailable" | "Seated" | "LongOpen";
/**
 * WP-2423 follow-up: the table's real floor state. Its operational state only says whether the
 * table is blocked, so a table with an open session is "Seated", never "Available".
 */
export function tableFloorStatus(
  table: Pick<
    StaffDiningTable,
    "operationalState" | "currentDiningSessionReference" | "elapsedMinutes"
  >,
): { state: TableFloorState; label: string } {
  const blocked = table.operationalState === "TemporarilyBlocked";
  if (table.currentDiningSessionReference === null)
    return blocked
      ? { state: "Unavailable", label: "Temporarily unavailable" }
      : { state: "Available", label: "Available" };
  const suffix = blocked ? " · Temporarily unavailable" : "";
  if (table.elapsedMinutes === null) return { state: "Seated", label: `Seated${suffix}` };
  const open = elapsedText(table.elapsedMinutes);
  return table.elapsedMinutes > longOpenSessionMinutes
    ? { state: "LongOpen", label: `Guests may have left · open ${open}${suffix}` }
    : { state: "Seated", label: `Seated · open ${open}${suffix}` };
}
/** The "Table state" filter: free tables, tables with guests, or blocked tables. */
export function tableMatchesStateFilter(table: StaffDiningTable, filter: string): boolean {
  if (filter === "Available") return tableFloorStatus(table).state === "Available";
  if (filter === "Seated") return table.currentDiningSessionReference !== null;
  if (filter === "TemporarilyBlocked") return table.operationalState === "TemporarilyBlocked";
  return true;
}
/** WP-2423 Q11: warn on the floor when guests can't scan in, or soon won't be able to. */
export function tableCodeNotice(table: StaffDiningTable, now = Date.now()): string | null {
  if (table.lifecycle !== "Published") return null;
  if (table.qrCodeValidUntil === null) return "No table QR code. Ask a manager to print one.";
  const days = Math.ceil((Date.parse(table.qrCodeValidUntil) - now) / 86_400_000);
  return days <= 30
    ? `Table QR code stops working in ${String(Math.max(days, 0))} day${days === 1 ? "" : "s"}. Ask a manager to print a new one.`
    : null;
}

/** WP-2423 item 5: minutes before an unpaid staff round's cancellation when the warning turns urgent. */
export const staffRoundUrgentMinutes = 10;
/**
 * WP-2423 item 5 ("warn before timeouts"): a round staff entered at this table still waits for its
 * card-machine payment; it is cancelled automatically (never sent to the kitchen) if nobody records
 * the payment by then. Null when nothing is waiting.
 */
export function staffRoundPaymentNotice(
  table: StaffDiningTable,
  now: number,
  timeZone: string | undefined,
): { readonly tier: "warning" | "urgent"; readonly text: string } | null {
  const first = table.staffRoundsAwaitingPayment[0];
  if (first === undefined) return null;
  const count = table.staffRoundsAwaitingPayment.length;
  const rounds = count === 1 ? "A round" : `${String(count)} rounds`;
  const remainingMs = Date.parse(first.payBy) - now;
  const at = storeTime(first.payBy, timeZone);
  if (remainingMs <= 0)
    return {
      tier: "urgent",
      text: `${rounds} entered by staff wasn't paid by ${at} and is being cancelled; it won't go to the kitchen. If the card machine was charged, refund it on the machine.`,
    };
  const minutes = Math.max(1, Math.ceil(remainingMs / 60_000));
  return minutes <= staffRoundUrgentMinutes
    ? {
        tier: "urgent",
        text: `${String(minutes)} min left: record the card-machine payment for ${count === 1 ? "the round" : "the rounds"} entered by staff by ${at}, or ${count === 1 ? "it is" : "they are"} cancelled.`,
      }
    : {
        tier: "warning",
        text: `${rounds} entered by staff ${count === 1 ? "awaits" : "await"} card-machine payment. Record it by ${at}; the kitchen starts once it is recorded.`,
      };
}

/**
 * WP-2423 abandoned payment ("warn before timeouts"): guest rounds at this table nobody has paid
 * for (often a guest who started paying on their phone and left). Each is cancelled automatically
 * at its time unless paid; staff are told before it happens. Null when nothing is waiting.
 */
export function guestRoundPaymentNotice(
  table: StaffDiningTable,
  now: number,
  timeZone: string | undefined,
): { readonly tier: "warning" | "urgent"; readonly text: string } | null {
  const rounds = table.guestRoundsAwaitingPayment;
  const first = rounds[0];
  if (first === undefined) return null;
  const names =
    rounds.length === 1
      ? `Round ${String(first.roundNumber)}`
      : `Rounds ${rounds.map((round) => String(round.roundNumber)).join(", ")}`;
  const remainingMs = Date.parse(first.payBy) - now;
  const at = storeTime(first.payBy, timeZone);
  // WP-2423 abandoned payment: still here well after the deadline, the card provider couldn't
  // confirm the guest's payment, so staff decide with the guest (only those rounds are named).
  const unconfirmed = rounds.filter((round) => isPaymentUnconfirmed(round.payBy, now));
  const firstUnconfirmed = unconfirmed[0];
  if (firstUnconfirmed !== undefined)
    return {
      tier: "urgent",
      text: `${
        unconfirmed.length === 1
          ? `Round ${String(firstUnconfirmed.roundNumber)}`
          : `Rounds ${unconfirmed.map((round) => String(round.roundNumber)).join(", ")}`
      }: the card provider couldn't confirm the guest's payment (due by ${storeTime(firstUnconfirmed.payBy, timeZone)}), so it wasn't cancelled automatically. Ask the guest whether their card was charged. If it wasn't, cancel the round; a charge that still comes through is refunded automatically.`,
    };
  if (remainingMs <= 0)
    return {
      tier: "urgent",
      text: `${names} wasn't paid by ${at} and is being cancelled; it won't go to the kitchen and nobody is charged.`,
    };
  const minutes = Math.max(1, Math.ceil(remainingMs / 60_000));
  const verb = rounds.length === 1 ? "isn't" : "aren't";
  return minutes <= staffRoundUrgentMinutes
    ? {
        tier: "urgent",
        text: `${String(minutes)} min left: ${names} ${verb} paid. Ask the guest to finish paying on their phone by ${at}, or it is cancelled.`,
      }
    : {
        tier: "warning",
        text: `${names} ${verb} paid yet. The guest pays on their phone (their table page has a pay button); unpaid at ${at}, it is cancelled and nobody is charged.`,
      };
}

/**
 * WP-2423 abandoned payment: what staff can do about the unpaid rounds, beside the table's details
 * (after `guestRoundPaymentNotice`), only where the notice doesn't already say it. Null while the
 * rounds are being cancelled automatically, or when the notice already tells this person what to do
 * (an unconfirmed payment: ask the guest, then cancel).
 */
export function guestRoundCancelHint(
  table: StaffDiningTable,
  now: number,
  canCancel: boolean,
): string | null {
  const first = table.guestRoundsAwaitingPayment[0];
  if (first === undefined) return null;
  if (table.guestRoundsAwaitingPayment.some((round) => isPaymentUnconfirmed(round.payBy, now)))
    return canCancel ? null : "Only a manager can cancel it, here or on the Orders page.";
  if (Date.parse(first.payBy) <= now) return null;
  return canCancel
    ? "If the guest won't pay for it, cancel it now."
    : "If the guest won't pay for it, a manager can cancel it here or on the Orders page.";
}

/**
 * WP-2423 (v15 2026-10-16): paid rounds at this table that staff have not accepted (oldest first).
 * They are never cancelled or refunded automatically, so the table says how long the oldest has
 * waited: plain at first, a warning from 5 minutes, urgent from 10. Null when nothing waits.
 */
export function paidRoundAcceptanceNotice(
  table: StaffDiningTable,
  now: number,
): { readonly tier: PaidRoundWaitTier; readonly text: string } | null {
  const oldest = [...table.roundsAwaitingAcceptance].sort(
    (a, b) => Date.parse(a.paidAt) - Date.parse(b.paidAt),
  )[0];
  if (oldest === undefined) return null;
  const others = table.roundsAwaitingAcceptance.length - 1;
  return {
    tier: paidRoundWait(oldest.paidAt, now).tier,
    text:
      tableRoundWaitText(oldest.roundNumber, oldest.paidAt, now) +
      (others > 0 ? ` (and ${String(others)} more paid round${others === 1 ? "" : "s"})` : ""),
  };
}

export function DiningSessionWorkspace({
  csrf,
  storeLabel,
  timeZone,
  navigation,
  canTakeOrders = false,
  tableQrHref,
}: {
  readonly csrf: string;
  readonly storeLabel: string;
  /** The Store's IANA time zone, for the times staff are told (WP-2423 item 5). */
  readonly timeZone?: string | undefined;
  readonly navigation?: ReactNode;
  /** WP-2423 Q7 slice 2: the staff member may enter a round for a table (staff ordering). */
  readonly canTakeOrders?: boolean;
  /** The Table QR codes page, when this staff member may create codes there. */
  readonly tableQrHref?: string | undefined;
}) {
  const [tables, setTables] = useState<StaffDiningTable[]>([]),
    [next, setNext] = useState<string | null>(null),
    [selected, setSelected] = useState<StaffDiningTable | null>(null),
    [confirmed, setConfirmed] = useState(false),
    [code, setCode] = useState<string | null>(null),
    [message, setMessage] = useState(""),
    [state, setState] = useState<"Idle" | "Loading" | "Submitting" | "Unknown">("Idle");
  const pending = useRef<AbortController | null>(null),
    operation = useRef<Operation | null>(null),
    availabilityOperation = useRef<AvailabilityOperation | null>(null);
  // WP-2423 D4: the staff member may close a table's session here (Owner, Store Manager).
  const [canCloseSessions, setCanCloseSessions] = useState(false);
  // WP-2423: only staff who may transfer the host see "Order host" (no refused reads for others).
  const [canTransferHost, setCanTransferHost] = useState(false);
  // WP-2423 abandoned payment: the staff member may cancel unpaid rounds from this page.
  const [canCancelUnpaidRounds, setCanCancelUnpaidRounds] = useState(false);
  const [canOperateTables, setCanOperateTables] = useState(false),
    [blockReasonCode, setBlockReasonCode] = useState(""),
    [unknownAction, setUnknownAction] = useState<"Session" | "Availability" | null>(null);
  const [hostLocked, setHostLocked] = useState(false);
  const [search, setSearch] = useState("");
  const [areaFilter, setAreaFilter] = useState("All");
  const [stateFilter, setStateFilter] = useState("All");
  // IDR-0039: a failed refresh keeps the last loaded tables on screen, read-only, and retries.
  const [stale, setStale] = useState<StaleRead | null>(null);
  const loadedAt = useRef<string | null>(null);
  const paused = stale !== null;
  const locked = state !== "Idle" || hostLocked;
  // WP-2423 item 5: while any staff round waits for payment, the clock ticks and the tables are
  // re-read in the background, so the warning counts down and clears once the payment is recorded.
  const [now, setNow] = useState(() => Date.now());
  const awaitingPayment = tables.some(
    (table) =>
      table.staffRoundsAwaitingPayment.length > 0 ||
      table.guestRoundsAwaitingPayment.length > 0 ||
      table.roundsAwaitingAcceptance.length > 0,
  );
  /** `background`: an automatic retry; the selected table and any shown entry code stay. */
  const load = async (more = false, background = false) => {
    if ((pending.current && !pending.current.signal.aborted) || state === "Unknown" || hostLocked)
      return;
    const controller = new AbortController();
    pending.current = controller;
    setState("Loading");
    if (!background) {
      setCode(null);
      setSelected(null);
      setConfirmed(false);
      setMessage("");
      operation.current = null;
      availabilityOperation.current = null;
      setUnknownAction(null);
    }
    try {
      const result = await createDiningSessionClient().tables(
        csrf,
        more ? next : null,
        controller.signal,
      );
      if (!controller.signal.aborted) {
        loadedAt.current = new Date().toISOString();
        setStale(null);
        setTables((prior) => (more ? [...prior, ...result.items] : result.items));
        if (background)
          setSelected(
            (prior) =>
              result.items.find((table) => table.tableReference === prior?.tableReference) ?? prior,
          );
        setNext(result.next);
        setCanOperateTables(result.canOperateTables);
        setCanCloseSessions(result.canCloseSessions);
        setCanTransferHost(result.canTransferHost);
        setCanCancelUnpaidRounds(result.canCancelUnpaidRounds);
        if (result.items.length === 0 && !more)
          setMessage("No tables are available in this Store.");
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        const denied = error instanceof DiningSessionClientError && error.code === "Denied";
        const lastLoadedAt = loadedAt.current;
        if (!denied && lastLoadedAt !== null && tables.length > 0) {
          setStale((prior) => ({
            reason: "Unavailable",
            lastLoadedAt,
            attempts: (prior?.attempts ?? 0) + 1,
          }));
        } else {
          loadedAt.current = null;
          setStale(null);
          setTables([]);
          setNext(null);
          setCanOperateTables(false);
          setMessage(
            denied
              ? "Your current permissions do not allow table operations."
              : "Tables unavailable. Check your connection and refresh.",
          );
        }
      }
    } finally {
      if (pending.current === controller) {
        pending.current = null;
        setState("Idle");
      }
    }
  };
  const loadRef = useRef(load);
  loadRef.current = load;
  useStaleRetry(stale?.attempts ?? null, () => void loadRef.current(false, true));
  // v15 cbff9d6f: no reads once this screen's sign-in has ended.
  const live = useStaffSessionLive();
  useEffect(() => {
    if (!awaitingPayment || !live) return;
    setNow(Date.now());
    let ticks = 0;
    const timer = setInterval(() => {
      setNow(Date.now());
      ticks += 1;
      // Every 30 seconds; a failing read goes read-only through the stale retry above.
      if (ticks % 2 === 0 && !paused) void loadRef.current(false, true);
    }, 15_000);
    return () => clearInterval(timer);
  }, [awaitingPayment, live, paused]);
  // IDR-0039: the browser saying the network is gone is enough to go read-only at once.
  useBrowserOffline(() => {
    const lastLoadedAt = loadedAt.current;
    if (lastLoadedAt === null || tables.length === 0) return;
    setStale((prior) => prior ?? { reason: "Offline", lastLoadedAt, attempts: 1 });
  });
  useEffect(() => {
    void loadRef.current();
    return () => {
      const controller = pending.current;
      controller?.abort();
      if (pending.current === controller) pending.current = null;
    };
  }, []);
  const execute = async () => {
    if (
      paused ||
      browserOffline() ||
      hostLocked ||
      (state === "Unknown" && unknownAction !== "Session") ||
      !selected ||
      pending.current ||
      (!operation.current && (!confirmed || locked))
    )
      return;
    const controller = new AbortController();
    pending.current = controller;
    setState("Submitting");
    setCode(null);
    setMessage("");
    try {
      const client = createDiningSessionClient();
      if (!operation.current) {
        if (selected.currentDiningSessionReference === null) {
          operation.current = client.prepareStart(selected, serviceOperationReference());
        } else {
          const current = await client.joinState(
            selected.currentDiningSessionReference,
            csrf,
            controller.signal,
          );
          if (current.tableReference !== selected.tableReference)
            throw new DiningSessionClientError("Denied");
          operation.current = client.prepareRegenerate(current, serviceOperationReference());
        }
      }
      const result = await operation.current.execute(csrf, controller.signal);
      if (!controller.signal.aborted) {
        const elapsedMinutes = result.status === "Issued" ? 0 : null;
        setSelected({
          ...selected,
          currentDiningSessionReference: result.diningSessionReference,
          elapsedMinutes,
        });
        setTables((rows) =>
          rows.map((t) =>
            t.tableReference === selected.tableReference
              ? {
                  ...t,
                  currentDiningSessionReference: result.diningSessionReference,
                  elapsedMinutes,
                }
              : t,
          ),
        );
        setCode(result.joinCredential);
        setConfirmed(false);
        operation.current = null;
        setUnknownAction(null);
        setState("Idle");
        setMessage(
          result.joinCredential
            ? "Share this one-time code with the party at this table."
            : "The request already completed. Its code cannot be displayed again. Confirm replacement to generate a new code.",
        );
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        const unknown = error instanceof DiningSessionClientError && error.code === "Unknown";
        setState(unknown ? "Unknown" : "Idle");
        setUnknownAction(unknown ? "Session" : null);
        if (!unknown) {
          operation.current = null;
          setConfirmed(false);
        }
        setMessage(
          unknown
            ? "The result is unknown. Retry the same request before starting another operation."
            : "The request was not confirmed. Refresh the table and check your permissions.",
        );
      }
    } finally {
      if (pending.current === controller) pending.current = null;
    }
  };
  const executeAvailability = async (action: "SetBlock" | "ClearBlock") => {
    if (
      paused ||
      browserOffline() ||
      !canOperateTables ||
      hostLocked ||
      !selected ||
      pending.current ||
      (state === "Unknown" && unknownAction !== "Availability") ||
      (action === "SetBlock" && !/^[A-Z][A-Z0-9_-]{0,63}$/.test(blockReasonCode))
    )
      return;
    const controller = new AbortController();
    pending.current = controller;
    setState("Submitting");
    setCode(null);
    setMessage("");
    try {
      const client = createDiningSessionClient();
      if (!availabilityOperation.current)
        availabilityOperation.current = client.prepareAvailability(
          selected,
          action,
          action === "SetBlock" ? blockReasonCode : null,
          serviceOperationReference(),
        );
      const result = await availabilityOperation.current.execute(csrf, controller.signal);
      if (!controller.signal.aborted) {
        const updated: StaffDiningTable = {
          ...selected,
          operationalState: result.operationalState,
          aggregateVersion: result.aggregateVersion,
        };
        setSelected(updated);
        setTables((rows) =>
          rows.map((row) => (row.tableReference === updated.tableReference ? updated : row)),
        );
        availabilityOperation.current = null;
        setUnknownAction(null);
        setBlockReasonCode("");
        setState("Idle");
        setMessage(
          action === "SetBlock"
            ? "Table marked temporarily unavailable."
            : "Table marked available.",
        );
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        const unknown = error instanceof DiningSessionClientError && error.code === "Unknown";
        setState(unknown ? "Unknown" : "Idle");
        setUnknownAction(unknown ? "Availability" : null);
        if (!unknown) availabilityOperation.current = null;
        setMessage(
          unknown
            ? "The result is unknown. Retry the same table request before starting another operation."
            : "The table request was not confirmed. Refresh and check current permissions.",
        );
      }
    } finally {
      if (pending.current === controller) pending.current = null;
    }
  };
  const eligible = selected?.lifecycle === "Published" && selected.operationalState === "Available";
  const areas = useMemo(() => [...new Set(tables.map((table) => table.areaCode))].sort(), [tables]);
  const visibleTables = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return tables.filter(
      (table) =>
        (!query || table.stableLabel.toLocaleLowerCase().includes(query)) &&
        (areaFilter === "All" || table.areaCode === areaFilter) &&
        tableMatchesStateFilter(table, stateFilter),
    );
  }, [areaFilter, search, stateFilter, tables]);
  const visibleAreas = useMemo(
    () => [...new Set(visibleTables.map((table) => table.areaCode))],
    [visibleTables],
  );
  return (
    <AppFrame title="OPERATIONS" description="" navigation={navigation}>
      <div className="dining-workspace">
        <header className="screen-heading dining-floor-heading">
          <div>
            <h2>Tables</h2>
            <p className="dining-store-label">{storeLabel}</p>
          </div>
          <div className="dining-floor-toolbar">
            <button disabled={locked} onClick={() => void load()}>
              Refresh tables
            </button>
            {next ? (
              <button disabled={locked || stale !== null} onClick={() => void load(true)}>
                Load more tables
              </button>
            ) : null}
          </div>
        </header>
        <section className="dining-table-browser" aria-labelledby="dining-table-browser-title">
          <h3 id="dining-table-browser-title">Find a table</h3>
          <p>
            Start a session when a party sits down and give them the table code. Their orders and
            payments are on the Orders page.
          </p>
          <div className="dining-floor-filters" role="search">
            <label>
              Table
              <input
                placeholder="Search labels"
                value={search}
                onChange={(event) => setSearch(event.currentTarget.value)}
              />
            </label>
            <label>
              Area
              <select
                value={areaFilter}
                onChange={(event) => setAreaFilter(event.currentTarget.value)}
              >
                <option>All</option>
                {areas.map((value) => (
                  <option key={value}>{value}</option>
                ))}
              </select>
            </label>
            <label>
              Table state
              <select
                value={stateFilter}
                onChange={(event) => setStateFilter(event.currentTarget.value)}
              >
                <option>All</option>
                <option value="Available">Available</option>
                <option value="Seated">Seated</option>
                <option value="TemporarilyBlocked">Temporarily unavailable</option>
              </select>
            </label>
          </div>
        </section>
        {stale ? <StaleReadNotice stale={stale} /> : null}
        <div className="dining-floor-layout">
          <section className="dining-floor-board" aria-label="Dining tables by area">
            {visibleAreas.length === 0 ? (
              <p role="status">
                {tables.length === 0
                  ? state === "Loading"
                    ? "Loading tables…"
                    : message || "No tables have been loaded."
                  : "No tables match the current filters."}
              </p>
            ) : (
              visibleAreas.map((area) => {
                const areaTables = visibleTables.filter((table) => table.areaCode === area);
                return (
                  <section className="dining-area-lane" key={area} aria-label={`${area} area`}>
                    <header>
                      <h3>{area}</h3>
                      <span>{areaTables.length}</span>
                    </header>
                    <div className="dining-table-grid">
                      {areaTables.map((table) => (
                        <article
                          className="dining-table-tile"
                          key={table.tableReference}
                          data-selected={selected?.tableReference === table.tableReference}
                          data-state={table.operationalState}
                          data-session={table.currentDiningSessionReference ? "linked" : "none"}
                          data-floor={tableFloorStatus(table).state}
                        >
                          <div className="dining-table-tile__identity">
                            <h4>{table.stableLabel}</h4>
                            <span>{tableFloorStatus(table).label}</span>
                          </div>
                          <hr className="dining-table-tile__divider" />
                          <p className="dining-table-tile__capacity">Seats {table.capacity}</p>
                          {tableCodeNotice(table) ? (
                            <p className="dining-table-tile__notice">{tableCodeNotice(table)}</p>
                          ) : null}
                          {[
                            paidRoundAcceptanceNotice(table, now),
                            staffRoundPaymentNotice(table, now, timeZone),
                            guestRoundPaymentNotice(table, now, timeZone),
                          ].map((notice, index) =>
                            notice === null ? null : (
                              <p
                                key={index}
                                className="dining-table-tile__notice order-accept-by"
                                data-tier={notice.tier}
                                role={notice.tier === "urgent" ? "alert" : "status"}
                              >
                                {notice.text}
                              </p>
                            ),
                          )}
                          {tableFloorStatus(table).state === "LongOpen" ? (
                            <p className="dining-table-tile__notice">
                              {canCloseSessions
                                ? "Open for a long time — if the guests have left, select the table and close it."
                                : "Open for a long time — if the guests have left, ask a manager or the owner to close the table."}
                            </p>
                          ) : null}
                          <button
                            disabled={locked || stale !== null}
                            aria-pressed={selected?.tableReference === table.tableReference}
                            onClick={() => {
                              setSelected(table);
                              setConfirmed(false);
                              setCode(null);
                              setMessage("");
                              operation.current = null;
                              availabilityOperation.current = null;
                              setBlockReasonCode("");
                            }}
                          >
                            Select {table.stableLabel}
                          </button>
                        </article>
                      ))}
                    </div>
                  </section>
                );
              })
            )}
          </section>
          <aside
            className="dining-session-detail"
            aria-label="Selected table details"
            aria-live="polite"
          >
            {selected ? (
              <>
                <p className="bop-eyebrow">
                  {selected.areaCode} · {tableFloorStatus(selected).label}
                </p>
                <h3>Table {selected.stableLabel}</h3>
                <dl>
                  <div>
                    <dt>Capacity</dt>
                    <dd>{selected.capacity}</dd>
                  </div>
                  <div>
                    <dt>Session</dt>
                    <dd>
                      {selected.currentDiningSessionReference
                        ? selected.elapsedMinutes === null
                          ? "Linked · elapsed time unavailable"
                          : `Linked · open ${elapsedText(selected.elapsedMinutes)}`
                        : "None"}
                    </dd>
                  </div>
                </dl>
                {(() => {
                  // WP-2423: paid rounds waiting for staff to accept them (never refunded by a timer).
                  const notice = paidRoundAcceptanceNotice(selected, now);
                  return notice === null ? null : (
                    <p className="order-accept-by" data-tier={notice.tier} role="note">
                      {notice.text}
                    </p>
                  );
                })()}
                {(() => {
                  // WP-2423 item 5: the same payment warning as the tile, beside the table's actions.
                  const notice = staffRoundPaymentNotice(selected, now, timeZone);
                  return notice === null ? null : (
                    <p className="order-accept-by" data-tier={notice.tier} role="note">
                      {notice.text} The table&apos;s rounds and payments are on the Orders page.
                    </p>
                  );
                })()}
                {(() => {
                  // WP-2423 abandoned payment: unpaid guest rounds, and cancelling them now.
                  const notice = guestRoundPaymentNotice(selected, now, timeZone);
                  const hint = guestRoundCancelHint(selected, now, canCancelUnpaidRounds);
                  return notice === null ? null : (
                    <section aria-label="Unpaid rounds">
                      <p className="order-accept-by" data-tier={notice.tier} role="note">
                        {notice.text}
                        {hint === null ? null : " " + hint}
                      </p>
                      {canCancelUnpaidRounds
                        ? selected.guestRoundsAwaitingPayment.map((round) => (
                            <UnpaidRoundCancelAction
                              key={round.orderBatchReference}
                              orderReference={round.orderReference}
                              orderBatchReference={round.orderBatchReference}
                              roundNumber={round.roundNumber}
                              orderLabel={"table " + selected.stableLabel}
                              csrf={csrf}
                              paymentUnconfirmed={isPaymentUnconfirmed(round.payBy, now)}
                              onSettled={() => void loadRef.current(false, true)}
                            />
                          ))
                        : null}
                    </section>
                  );
                })()}
                {selected.currentDiningSessionReference !== null &&
                canCloseSessions &&
                selected.session ? (
                  // WP-2423 D4: close the table's session here, after checking its rounds.
                  <TableSessionClose
                    key={selected.currentDiningSessionReference}
                    table={selected}
                    session={selected.session}
                    csrf={csrf}
                    timeZone={timeZone}
                    locked={locked || paused}
                    onBusy={() => undefined}
                    onClosed={() => {
                      void loadRef
                        .current()
                        .then(() =>
                          setMessage(
                            `Table ${selected.stableLabel} is closed and free for the next party.`,
                          ),
                        );
                    }}
                    onRefresh={() => void loadRef.current(false, true)}
                  />
                ) : selected.currentDiningSessionReference !== null && !canCloseSessions ? (
                  // WP-2423 (3cd0f8dd M7): closing a table stays with the Owner and Store Manager;
                  // say who, so staff know whom to tell when the guests have left.
                  <p role="note" className="dining-close-who">
                    A manager or the owner closes the table. Tell them when the guests have left.
                  </p>
                ) : null}
                {canTakeOrders && eligible ? (
                  // WP-2423 Q7 slice 2: a round for guests who can't or won't order on a phone.
                  <section aria-label="Take an order for this table">
                    <p>
                      Order for guests who can&apos;t or won&apos;t use their phone, or enter a
                      paper order after an outage. It joins this table&apos;s order.
                    </p>
                    {selected.qrCodeValidUntil === null ? (
                      // DEC-STAFF-DINE-IN-ROUND (2026-10-15): a staff round joins the table the
                      // way a guest does, through the table's code, so it needs one first.
                      <p role="note">
                        Orders can&apos;t be taken for table {selected.stableLabel} yet: it has no
                        table QR code.{" "}
                        {tableQrHref !== undefined ? (
                          <>
                            Create one on <Link to={tableQrHref}>Table QR codes</Link> (it can be
                            printed later), then take the order.
                          </>
                        ) : (
                          "Ask a manager to create one on the Table QR codes page, then take the order."
                        )}
                      </p>
                    ) : (
                      <Link
                        className="dining-take-order"
                        to={`/operations/order-entry?table=${encodeURIComponent(selected.tableReference)}`}
                      >
                        Take order for table {selected.stableLabel}
                      </Link>
                    )}
                  </section>
                ) : null}
                {selected.currentDiningSessionReference === null &&
                selected.qrCodeValidUntil === null ? (
                  // WP-2423 item 7: guests join a session by scanning the table's QR code and
                  // then entering its code, so a session for a table without one can't be used.
                  <section aria-label="Dining session action">
                    <p role="note">
                      A dining session can&apos;t be started for table {selected.stableLabel} yet:
                      it has no table QR code, so guests can&apos;t join.{" "}
                      {tableQrHref !== undefined ? (
                        <>
                          Create one on <Link to={tableQrHref}>Table QR codes</Link> first.
                        </>
                      ) : (
                        "Ask a manager to create one on the Table QR codes page."
                      )}
                    </p>
                  </section>
                ) : (
                  <section aria-label="Dining session action">
                    <p>
                      {selected.currentDiningSessionReference
                        ? "Replacing the entry code invalidates the previous code. Existing participants remain joined."
                        : "Start a new dining session for this party."}
                    </p>
                    <label>
                      <input
                        type="checkbox"
                        checked={confirmed}
                        disabled={locked || paused}
                        onChange={(event) => setConfirmed(event.target.checked)}
                      />
                      I confirm the selected table and session action
                    </label>
                    <button
                      disabled={
                        paused ||
                        hostLocked ||
                        state === "Loading" ||
                        state === "Submitting" ||
                        (state === "Unknown" && unknownAction !== "Session") ||
                        (state !== "Unknown" && (!confirmed || !eligible))
                      }
                      onClick={() => void execute()}
                    >
                      {state === "Unknown" && unknownAction === "Session"
                        ? "Retry same session request"
                        : state === "Submitting"
                          ? "Submitting…"
                          : selected.currentDiningSessionReference
                            ? "Replace entry code"
                            : "Start dining session"}
                    </button>
                    {selected.currentDiningSessionReference && canTransferHost ? (
                      <DiningHostTransferAction
                        key={selected.currentDiningSessionReference}
                        diningSessionReference={selected.currentDiningSessionReference}
                        csrf={csrf}
                        disabled={state !== "Idle" || paused}
                        onLocked={setHostLocked}
                      />
                    ) : null}
                  </section>
                )}
                {canOperateTables ? (
                  <section aria-label="Table availability action">
                    <p>Mark a table unavailable while it can&apos;t be seated.</p>
                    {selected.operationalState === "Available" ? (
                      <>
                        <label className="dining-table-reason">
                          Reason
                          <select
                            value={blockReasonCode}
                            aria-describedby="dining-table-reason-help"
                            disabled={locked || paused}
                            onChange={(event) => setBlockReasonCode(event.target.value)}
                          >
                            <option value="">Choose a reason</option>
                            {tableBlockReasons.map(([code, label]) => (
                              <option key={code} value={code}>
                                {label}
                              </option>
                            ))}
                          </select>
                          <small id="dining-table-reason-help">
                            Required. Guests can&apos;t be seated here until you mark it available.
                          </small>
                        </label>
                        <button
                          disabled={
                            paused ||
                            hostLocked ||
                            state === "Loading" ||
                            state === "Submitting" ||
                            (state === "Unknown" && unknownAction !== "Availability") ||
                            (state !== "Unknown" &&
                              !/^[A-Z][A-Z0-9_-]{0,63}$/.test(blockReasonCode))
                          }
                          onClick={() => void executeAvailability("SetBlock")}
                        >
                          {state === "Unknown" && unknownAction === "Availability"
                            ? "Retry same availability request"
                            : state === "Submitting"
                              ? "Updating availability…"
                              : "Mark table unavailable"}
                        </button>
                      </>
                    ) : (
                      <button
                        disabled={
                          paused ||
                          hostLocked ||
                          state === "Loading" ||
                          state === "Submitting" ||
                          (state === "Unknown" && unknownAction !== "Availability")
                        }
                        onClick={() => void executeAvailability("ClearBlock")}
                      >
                        {state === "Unknown" && unknownAction === "Availability"
                          ? "Retry same availability request"
                          : state === "Submitting"
                            ? "Updating availability…"
                            : "Mark table available"}
                      </button>
                    )}
                  </section>
                ) : null}
                {code ? (
                  <div className="dining-entry-code">
                    <p>
                      Entry code: <strong>{code}</strong>
                    </p>
                    <button onClick={() => setCode(null)}>Hide entry code</button>
                  </div>
                ) : null}
              </>
            ) : (
              <p>Select a table to review its current state and available session action.</p>
            )}
          </aside>
        </div>
        <p role="status">{state === "Loading" ? "Loading tables…" : message}</p>
      </div>
    </AppFrame>
  );
}
