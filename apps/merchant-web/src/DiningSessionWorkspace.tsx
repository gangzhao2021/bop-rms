import { t } from "./i18n/i18n.js";
import { UnpaidRoundCancelAction, isPaymentUnconfirmed } from "./UnpaidRoundCancelAction.js";
import { paidRoundWait, tableRoundWaitText, type PaidRoundWaitTier } from "./paid-round-wait.js";
import { DiningHostTransferAction } from "./DiningHostTransferAction.js";
import { useEffect, useMemo, useRef, useState } from "react";
import { useStaffSessionLive } from "./staff-session-reads.js";
import { WorkspacePage } from "./WorkspacePage.js";
import { Link } from "react-router";
import {
  createDiningSessionClient,
  DiningSessionClientError,
  longOpenSessionMinutes,
  type StaffDiningTable,
} from "./dining-session-client.js";
import { serviceOperationReference } from "./service-control-client.js";
import { storeTime } from "./StoreTime.js";
import { newOperationReference } from "./operation-reference.js";
import { TableSessionClose } from "./TableSessionClose.js";
import { TableCheckout } from "./TableCheckout.js";
import { TableOrderRounds } from "./TableOrderRounds.js";
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
  ["CLEANING", t("Being cleaned")],
  ["RESERVED", "Reserved"],
  ["OUT_OF_SERVICE", t("Out of service")],
  ["AREA_CLOSED", t("Section closed")],
] as const;
/** WP-2423 follow-up: how long a session has been open, in words staff read at a glance. */
export function elapsedText(minutes: number): string {
  if (minutes < 60) return t("{minutes} min", { minutes: String(minutes) });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return rest === 0
      ? `${String(hours)} h`
      : t("{hours} h {rest} min", { hours: String(hours), rest: String(rest) });
  }
  const days = Math.floor(hours / 24);
  return t("{days} day{value}", { days: String(days), value: days === 1 ? "" : "s" });
}
export { longOpenSessionMinutes };
/** What staff see on the floor: free, blocked, seated, or seated so long the guests have likely left. */
export type TableFloorState = "Available" | "Unavailable" | "NeedsCleaning" | "Seated" | "LongOpen";
/**
 * WP-2423 follow-up: the table's real floor state. Its operational state only says whether the
 * table is blocked, so a table with an open session is "Seated", never "Available".
 */
export function tableFloorStatus(
  table: Pick<
    StaffDiningTable,
    "operationalState" | "currentDiningSessionReference" | "elapsedMinutes"
  > &
    Partial<Pick<StaffDiningTable, "blockReasonCode">>,
): { state: TableFloorState; label: string } {
  const blocked = table.operationalState === "TemporarilyBlocked";
  // Handoff §25.3: a table its guests just left waits for cleaning before it is seated again.
  if (
    table.currentDiningSessionReference === null &&
    blocked &&
    table.blockReasonCode === "CLEANING"
  )
    return { state: "NeedsCleaning", label: t("Needs cleaning") };
  if (table.currentDiningSessionReference === null)
    return blocked
      ? { state: "Unavailable", label: t("Temporarily unavailable") }
      : { state: "Available", label: t("Available") };
  const suffix = blocked ? t(" · Temporarily unavailable") : "";
  if (table.elapsedMinutes === null)
    return { state: "Seated", label: t("Seated{suffix}", { suffix: suffix }) };
  const open = elapsedText(table.elapsedMinutes);
  return table.elapsedMinutes > longOpenSessionMinutes
    ? {
        state: "LongOpen",
        label: t("Guests may have left · open {open}{suffix}", { open: open, suffix: suffix }),
      }
    : { state: "Seated", label: t("Seated · open {open}{suffix}", { open: open, suffix: suffix }) };
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
  if (table.qrCodeValidUntil === null) return t("No table QR code. Ask a manager to print one.");
  const days = Math.ceil((Date.parse(table.qrCodeValidUntil) - now) / 86_400_000);
  return days <= 30
    ? t("Table QR code stops working in {value} day{value2}. Ask a manager to print a new one.", {
        value: String(Math.max(days, 0)),
        value2: days === 1 ? "" : "s",
      })
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
  const rounds = count === 1 ? t("A round") : t("{count} rounds", { count: String(count) });
  const remainingMs = Date.parse(first.payBy) - now;
  const at = storeTime(first.payBy, timeZone);
  if (remainingMs <= 0)
    return {
      tier: "urgent",
      text: t(
        "{rounds} entered by staff wasn't paid by {at} and is being cancelled; it won't go to the kitchen. If the card machine was charged, refund it on the machine.",
        { rounds: rounds, at: at },
      ),
    };
  const minutes = Math.max(1, Math.ceil(remainingMs / 60_000));
  return minutes <= staffRoundUrgentMinutes
    ? {
        tier: "urgent",
        text: t(
          "{minutes} min left: record the card-machine payment for {value} entered by staff by {at}, or {value2} cancelled.",
          {
            minutes: String(minutes),
            value: count === 1 ? "the round" : "the rounds",
            at: at,
            value2: count === 1 ? "it is" : "they are",
          },
        ),
      }
    : {
        tier: "warning",
        text: t(
          "{rounds} entered by staff {value} card-machine payment. Record it by {at}; the kitchen starts once it is recorded.",
          { rounds: rounds, value: count === 1 ? "awaits" : "await", at: at },
        ),
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
      ? t("Round {roundNumber}", { roundNumber: String(first.roundNumber) })
      : t("Rounds {value}", { value: rounds.map((round) => String(round.roundNumber)).join(", ") });
  const remainingMs = Date.parse(first.payBy) - now;
  const at = storeTime(first.payBy, timeZone);
  // WP-2423 abandoned payment: still here well after the deadline, the card provider couldn't
  // confirm the guest's payment, so staff decide with the guest (only those rounds are named).
  const unconfirmed = rounds.filter((round) => isPaymentUnconfirmed(round.payBy, now));
  const firstUnconfirmed = unconfirmed[0];
  if (firstUnconfirmed !== undefined)
    return {
      tier: "urgent",
      text: t(
        "{value}: the card provider couldn't confirm the guest's payment (due by {payBy}), so it wasn't cancelled automatically. Ask the guest whether their card was charged. If it wasn't, cancel the round; a charge that still comes through is refunded automatically.",
        {
          value:
            unconfirmed.length === 1
              ? `Round ${String(firstUnconfirmed.roundNumber)}`
              : `Rounds ${unconfirmed.map((round) => String(round.roundNumber)).join(", ")}`,
          payBy: storeTime(firstUnconfirmed.payBy, timeZone),
        },
      ),
    };
  if (remainingMs <= 0)
    return {
      tier: "urgent",
      text: t(
        "{names} wasn't paid by {at} and is being cancelled; it won't go to the kitchen and nobody is charged.",
        { names: names, at: at },
      ),
    };
  const minutes = Math.max(1, Math.ceil(remainingMs / 60_000));
  const verb = rounds.length === 1 ? "isn't" : "aren't";
  return minutes <= staffRoundUrgentMinutes
    ? {
        tier: "urgent",
        text: t(
          "{minutes} min left: {names} {verb} paid. Ask the guest to finish paying on their phone by {at}, or it is cancelled.",
          { minutes: String(minutes), names: names, verb: verb, at: at },
        ),
      }
    : {
        tier: "warning",
        text: t(
          "{names} {verb} paid yet. The guest pays on their phone (their table page has a pay button); unpaid at {at}, it is cancelled and nobody is charged.",
          { names: names, verb: verb, at: at },
        ),
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
    return canCancel ? null : t("Only a manager can cancel it, here or on the Orders page.");
  if (Date.parse(first.payBy) <= now) return null;
  return canCancel
    ? t("If the guest won't pay for it, cancel it now.")
    : t("If the guest won't pay for it, a manager can cancel it here or on the Orders page.");
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
      (others > 0
        ? t(" (and {others} more paid round{value})", {
            others: String(others),
            value: others === 1 ? "" : "s",
          })
        : ""),
  };
}

/** WP-2423 Q28 DEC-DINING-STAFF-CALL: what the guest asked for, in staff words. */
export function staffCallReasonText(reason: "Question" | "TableNeeds" | "OrderProblem"): string {
  return reason === "TableNeeds"
    ? t("Something for the table")
    : reason === "OrderProblem"
      ? t("A problem with their order")
      : t("A question");
}

/**
 * WP-2423 Q28: a guest at the table asked staff to come over. A warning at first, urgent once
 * they have waited 5 minutes. Null when nobody is waiting.
 */
export function staffCallNotice(
  table: StaffDiningTable,
  now: number,
): { readonly tier: "warning" | "urgent"; readonly text: string } | null {
  const call = table.staffCall;
  if (call === undefined || call === null) return null;
  const minutes = Math.max(0, Math.floor((now - Date.parse(call.calledAt)) / 60_000));
  return {
    tier: minutes >= 5 ? "urgent" : "warning",
    text:
      minutes === 0
        ? t("Guest asked for staff just now · {reason}", {
            reason: staffCallReasonText(call.reason),
          })
        : t("Guest asked for staff {minutes} min ago · {reason}", {
            minutes: String(minutes),
            reason: staffCallReasonText(call.reason),
          }),
  };
}

/**
 * What a table tile flags for staff, in the order they act on it: a paid round waiting for
 * acceptance, a staff round or guest round waiting for payment (warn before timeouts), a table
 * open so long the guests may have left, and a missing or expiring table QR code. `tier` is null
 * for plain guidance.
 */
export function tableAttentionNotices(
  table: StaffDiningTable,
  now: number,
  timeZone: string | undefined,
  canCloseSessions: boolean,
): { readonly tier: PaidRoundWaitTier | "warning" | "urgent" | null; readonly text: string }[] {
  const notices: { tier: PaidRoundWaitTier | "warning" | "urgent" | null; text: string }[] = [];
  // WP-2423 Q28: a guest asked staff to come over (first: someone is waiting at the table).
  const call = staffCallNotice(table, now);
  if (call !== null) notices.push(call);
  for (const notice of [
    paidRoundAcceptanceNotice(table, now),
    staffRoundPaymentNotice(table, now, timeZone),
    guestRoundPaymentNotice(table, now, timeZone),
  ])
    if (notice !== null) notices.push(notice);
  if (tableFloorStatus(table).state === "LongOpen")
    notices.push({
      tier: null,
      text: canCloseSessions
        ? t("Open for a long time — if the guests have left, select the table and close it.")
        : t(
            "Open for a long time — if the guests have left, ask a manager or the owner to close the table.",
          ),
    });
  const code = tableCodeNotice(table, now);
  if (code !== null) notices.push({ tier: null, text: code });
  return notices;
}

/**
 * A newly issued table entry code with what to do with it. Hiding the code hides the instruction
 * too, so no sentence is left pointing at a code that is no longer shown.
 */
export function DiningEntryCode({
  code,
  onHide,
}: {
  readonly code: string;
  readonly onHide: () => void;
}) {
  return (
    <div className="dining-entry-code">
      <p>{t("Share this one-time code with the party at this table.")}</p>
      <p>
        {t("Entry code:")} <strong>{code}</strong>
      </p>
      <button onClick={onHide}>{t("Hide entry code")}</button>
    </div>
  );
}

export function DiningSessionWorkspace({
  csrf,
  storeLabel,
  timeZone,
  canTakeOrders = false,
  tableQrHref,
}: {
  readonly csrf: string;
  readonly storeLabel: string;
  /** The Store's IANA time zone, for the times staff are told (WP-2423 item 5). */
  readonly timeZone?: string | undefined;
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
  const detailRef = useRef<HTMLElement | null>(null);
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
    [checkoutRevision, setCheckoutRevision] = useState(0),
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
  // WP-2423 Q28: any seated table may ask for staff at any moment, so the page keeps reading while
  // a table is open, not only while a round waits.
  const awaitingPayment = tables.some(
    (table) =>
      table.currentDiningSessionReference !== null ||
      table.staffRoundsAwaitingPayment.length > 0 ||
      table.guestRoundsAwaitingPayment.length > 0 ||
      table.roundsAwaitingAcceptance.length > 0,
  );
  // WP-2423 Q28: answering a guest's call for staff ("I'm on my way" / handled).
  const [answering, setAnswering] = useState<string | null>(null);
  const [callMessage, setCallMessage] = useState("");
  const answerOperations = useRef(new Map<string, string>());
  const answerCall = async (table: StaffDiningTable) => {
    const call = table.staffCall;
    if (call === null || call === undefined || answering !== null) return;
    const operation = answerOperations.current.get(call.callReference) ?? newOperationReference();
    answerOperations.current.set(call.callReference, operation);
    setAnswering(call.callReference);
    setCallMessage("");
    try {
      await createDiningSessionClient().answerStaffCall(csrf, operation, call.callReference);
      answerOperations.current.delete(call.callReference);
      setTables((current) =>
        current.map((entry) =>
          entry.tableReference === table.tableReference ? { ...entry, staffCall: null } : entry,
        ),
      );
      setCallMessage(t("Table {table}: marked as handled.", { table: table.stableLabel }));
    } catch {
      setCallMessage(
        t("Table {table}: not confirmed. Check the connection and try again.", {
          table: table.stableLabel,
        }),
      );
    } finally {
      setAnswering(null);
    }
  };
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
          setMessage(t("No tables are available in this Store."));
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
              ? t("Your current permissions do not allow table operations.")
              : t("Tables unavailable. Check your connection and refresh."),
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
        // 2026-10-21 live check: the sharing instruction sits with the code and goes with it.
        setMessage(
          result.joinCredential
            ? ""
            : t(
                "The request already completed. Its code cannot be displayed again. Confirm replacement to generate a new code.",
              ),
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
            ? t("The result is unknown. Retry the same request before starting another operation.")
            : t("The request was not confirmed. Refresh the table and check your permissions."),
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
            ? t("Table marked temporarily unavailable.")
            : t("Table marked available."),
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
            ? t(
                "The result is unknown. Retry the same table request before starting another operation.",
              )
            : t("The table request was not confirmed. Refresh and check current permissions."),
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
  const attention = (table: StaffDiningTable) =>
    tableAttentionNotices(table, now, timeZone, canCloseSessions);
  const seatedCount = tables.filter((table) => table.currentDiningSessionReference !== null).length;
  const freeCount = tables.filter((table) => tableFloorStatus(table).state === "Available").length;
  const attentionCount = tables.filter((table) => attention(table).length > 0).length;
  const select = (table: StaffDiningTable) => {
    setSelected(table);
    setConfirmed(false);
    setCode(null);
    setMessage("");
    operation.current = null;
    availabilityOperation.current = null;
    setBlockReasonCode("");
    // Presentation only: below the desktop width the details sit under the floor, so bring them
    // into view (the way a phone POS opens the table).
    if (typeof window.matchMedia === "function" && window.matchMedia("(max-width: 1023px)").matches)
      requestAnimationFrame(() => detailRef.current?.scrollIntoView?.({ block: "start" }));
  };
  return (
    <WorkspacePage
      className="dining-floor"
      title={t("Tables")}
      meta={storeLabel}
      status={
        tables.length > 0 ? (
          <span className="dining-floor-summary">
            <span>{t("{freeCount} available", { freeCount: String(freeCount) })}</span>
            <span>{t("{seatedCount} seated", { seatedCount: String(seatedCount) })}</span>
            {attentionCount > 0 ? (
              <span data-attention="true">
                {t("{attentionCount} need{value} attention", {
                  attentionCount: String(attentionCount),
                  value: attentionCount === 1 ? "s" : "",
                })}
              </span>
            ) : null}
          </span>
        ) : null
      }
      actions={
        <>
          <button disabled={locked} onClick={() => void load()}>
            {t("Refresh tables")}
          </button>
          {next ? (
            <button disabled={locked || stale !== null} onClick={() => void load(true)}>
              {t("Load more tables")}
            </button>
          ) : null}
        </>
      }
    >
      <section className="dining-table-browser" aria-labelledby="dining-table-browser-title">
        <h2 id="dining-table-browser-title" className="visually-hidden">
          {t("Find a table")}
        </h2>
        <div className="dining-floor-filters" role="search" aria-label={t("Find a table")}>
          <label>
            <span className="visually-hidden">{t("Table")}</span>
            <input
              type="search"
              placeholder={t("Search tables")}
              value={search}
              onChange={(event) => setSearch(event.currentTarget.value)}
            />
          </label>
          <label>
            <span className="visually-hidden">{t("Area")}</span>
            <select
              value={areaFilter}
              onChange={(event) => setAreaFilter(event.currentTarget.value)}
            >
              <option value="All">{t("All areas")}</option>
              {areas.map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
          <label>
            <span className="visually-hidden">{t("Table state")}</span>
            <select
              value={stateFilter}
              onChange={(event) => setStateFilter(event.currentTarget.value)}
            >
              <option value="All">{t("All tables")}</option>
              <option value="Available">{t("Available")}</option>
              <option value="Seated">{t("Seated")}</option>
              <option value="TemporarilyBlocked">{t("Temporarily unavailable")}</option>
            </select>
          </label>
        </div>
      </section>
      {stale ? <StaleReadNotice stale={stale} /> : null}
      {tables.some((table) => table.staffCall) ? (
        // WP-2423 Q28 DEC-DINING-STAFF-CALL: guests waiting for staff, oldest first.
        <section className="dining-staff-calls" role="alert" aria-labelledby="dining-staff-calls">
          <h2 id="dining-staff-calls">{t("Guests asking for staff")}</h2>
          <ul>
            {[...tables]
              .filter((table) => table.staffCall)
              .sort(
                (a, b) =>
                  Date.parse(a.staffCall?.calledAt ?? "") - Date.parse(b.staffCall?.calledAt ?? ""),
              )
              .map((table) => {
                const notice = staffCallNotice(table, now);
                return (
                  <li key={table.tableReference} data-tier={notice?.tier}>
                    <span>
                      <strong>{t("Table {table}", { table: table.stableLabel })}</strong>
                      {" · "}
                      {notice?.text}
                    </span>
                    <button
                      type="button"
                      disabled={answering !== null || stale !== null}
                      onClick={() => void answerCall(table)}
                    >
                      {answering === table.staffCall?.callReference ? t("Saving…") : t("Handled")}
                    </button>
                  </li>
                );
              })}
          </ul>
        </section>
      ) : null}
      {callMessage ? <p role="status">{callMessage}</p> : null}
      <div className="dining-floor-layout">
        <section className="dining-floor-board" aria-label={t("Dining tables by area")}>
          {visibleAreas.length === 0 ? (
            <p role="status" className="dining-floor-empty" data-loading={state === "Loading"}>
              {tables.length === 0
                ? state === "Loading"
                  ? t("Loading tables…")
                  : message || t("No tables have been loaded.")
                : t("No tables match the current filters.")}
            </p>
          ) : (
            visibleAreas.map((area) => {
              const areaTables = visibleTables.filter((table) => table.areaCode === area);
              return (
                <section
                  className="dining-area-lane"
                  key={area}
                  aria-label={t("{area} area", { area: area })}
                >
                  <header>
                    <h2>{area}</h2>
                    <span>
                      {t("{length} table{value}", {
                        length: String(areaTables.length),
                        value: areaTables.length === 1 ? "" : "s",
                      })}
                    </span>
                  </header>
                  <div className="dining-table-grid">
                    {areaTables.map((table) => {
                      const floor = tableFloorStatus(table);
                      const notices = attention(table);
                      return (
                        <article
                          className="dining-table-tile"
                          key={table.tableReference}
                          data-selected={selected?.tableReference === table.tableReference}
                          data-state={table.operationalState}
                          data-session={table.currentDiningSessionReference ? "linked" : "none"}
                          data-floor={floor.state}
                          data-attention={notices.length > 0}
                        >
                          <div className="dining-table-tile__identity">
                            <h3 title={table.stableLabel}>{table.stableLabel}</h3>
                            <span>
                              {floor.label.split(" · ").map((part, index) => (
                                <span key={index}>
                                  {index > 0 ? (
                                    <span className="dining-table-tile__separator"> · </span>
                                  ) : null}
                                  {part}
                                </span>
                              ))}
                            </span>
                          </div>
                          <p className="dining-table-tile__capacity">
                            {t("Seats {capacity}", { capacity: table.capacity })}
                          </p>
                          {notices.map((notice, index) =>
                            notice.tier === null ? (
                              <p key={index} className="dining-table-tile__notice">
                                {notice.text}
                              </p>
                            ) : (
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
                          <button
                            className="dining-table-tile__select"
                            disabled={locked || stale !== null}
                            aria-pressed={selected?.tableReference === table.tableReference}
                            onClick={() => select(table)}
                          >
                            <span className="visually-hidden">
                              {t("Select {stableLabel}", { stableLabel: table.stableLabel })}
                            </span>
                          </button>
                        </article>
                      );
                    })}
                  </div>
                </section>
              );
            })
          )}
        </section>
        <aside
          ref={detailRef}
          className="dining-session-detail"
          aria-label={t("Selected table details")}
          aria-live="polite"
        >
          {selected ? (
            <>
              <p className="bop-eyebrow">
                {selected.areaCode} · {tableFloorStatus(selected).label}
              </p>
              <h2>{t("Table {stableLabel}", { stableLabel: selected.stableLabel })}</h2>
              <dl>
                <div>
                  <dt>{t("Capacity")}</dt>
                  <dd>{selected.capacity}</dd>
                </div>
                <div>
                  <dt>{t("Session")}</dt>
                  <dd>
                    {selected.currentDiningSessionReference
                      ? selected.elapsedMinutes === null
                        ? t("Linked · elapsed time unavailable")
                        : t("Linked · open {elapsedMinutes}", {
                            elapsedMinutes: elapsedText(selected.elapsedMinutes),
                          })
                      : t("None")}
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
                    {t("{text} The table's rounds and payments are on the Orders page.", {
                      text: notice.text,
                    })}
                  </p>
                );
              })()}
              {(() => {
                // WP-2423 abandoned payment: unpaid guest rounds, and cancelling them now.
                const notice = guestRoundPaymentNotice(selected, now, timeZone);
                const hint = guestRoundCancelHint(selected, now, canCancelUnpaidRounds);
                return notice === null ? null : (
                  <section aria-label={t("Unpaid rounds")}>
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
              {selected.session?.orderReference ? (
                // Orders v3 (Owner 2026-10-26): the table's rounds and dishes, served from here.
                <TableOrderRounds
                  key={selected.session.orderReference}
                  orderReference={selected.session.orderReference}
                  csrf={csrf}
                  timeZone={timeZone}
                  refreshKey={String(loadedAt.current)}
                  locked={locked || paused}
                  onChanged={() => void loadRef.current(false, true)}
                />
              ) : null}
              {selected.currentDiningSessionReference !== null &&
              selected.paymentTiming === "PayLater" &&
              selected.session &&
              (canCloseSessions || canOperateTables) ? (
                // DEC-DINE-IN-PAY-LATER: the table pays once at the end, here.
                <TableCheckout
                  key={selected.currentDiningSessionReference + ":" + selected.session.phase}
                  table={selected}
                  session={selected.session}
                  csrf={csrf}
                  canStart={canCloseSessions}
                  timeZone={timeZone}
                  locked={locked || paused}
                  onChanged={() => {
                    // The close check reads the table again once it is paid (or written off).
                    setCheckoutRevision((value) => value + 1);
                    void loadRef.current(false, true);
                  }}
                />
              ) : null}
              {selected.currentDiningSessionReference !== null &&
              canCloseSessions &&
              selected.session ? (
                // WP-2423 D4: close the table's session here, after checking its rounds.
                <TableSessionClose
                  key={selected.currentDiningSessionReference + ":" + String(checkoutRevision)}
                  table={selected}
                  session={selected.session}
                  csrf={csrf}
                  timeZone={timeZone}
                  locked={locked || paused}
                  onBusy={() => undefined}
                  onClosed={() => {
                    void loadRef.current().then(() =>
                      setMessage(
                        t("Table {stableLabel} is closed and free for the next party.", {
                          stableLabel: selected.stableLabel,
                        }),
                      ),
                    );
                  }}
                  onRefresh={() => void loadRef.current(false, true)}
                />
              ) : selected.currentDiningSessionReference !== null && !canCloseSessions ? (
                // WP-2423 (3cd0f8dd M7): closing a table stays with the Owner and Store Manager;
                // say who, so staff know whom to tell when the guests have left.
                <p role="note" className="dining-close-who">
                  {t(
                    "A manager or the owner closes the table. Tell them when the guests have left.",
                  )}
                </p>
              ) : null}
              {canTakeOrders && eligible ? (
                // WP-2423 Q7 slice 2: a round for guests who can't or won't order on a phone.
                <section aria-label={t("Take an order for this table")}>
                  <p>
                    {t(
                      "Order for guests who can't or won't use their phone, or enter a paper order after an outage. It joins this table's order.",
                    )}
                  </p>
                  {selected.qrCodeValidUntil === null ? (
                    // DEC-STAFF-DINE-IN-ROUND (2026-10-15): a staff round joins the table the
                    // way a guest does, through the table's code, so it needs one first.
                    <p role="note">
                      {t("Orders can't be taken for table")} {selected.stableLabel}{" "}
                      {t("yet: it has no table QR code.")}{" "}
                      {tableQrHref !== undefined ? (
                        <>
                          {t("Create one on")} <Link to={tableQrHref}>{t("Table QR codes")}</Link>{" "}
                          {t("(it can be printed later), then take the order.")}
                        </>
                      ) : (
                        t(
                          "Ask a manager to create one on the Table QR codes page, then take the order.",
                        )
                      )}
                    </p>
                  ) : (
                    <Link
                      className="dining-take-order"
                      to={`/operations/order-entry?table=${encodeURIComponent(selected.tableReference)}`}
                    >
                      {t("Take order for table {stableLabel}", {
                        stableLabel: selected.stableLabel,
                      })}
                    </Link>
                  )}
                </section>
              ) : null}
              {selected.currentDiningSessionReference === null &&
              selected.qrCodeValidUntil === null ? (
                // WP-2423 item 7: guests join a session by scanning the table's QR code and
                // then entering its code, so a session for a table without one can't be used.
                <section aria-label={t("Dining session action")}>
                  <p role="note">
                    {t("A dining session can't be started for table")} {selected.stableLabel}{" "}
                    {t("yet: it has no table QR code, so guests can't join.")}{" "}
                    {tableQrHref !== undefined ? (
                      <>
                        {t("Create one on")} <Link to={tableQrHref}>{t("Table QR codes")}</Link>{" "}
                        {t("first.")}
                      </>
                    ) : (
                      t("Ask a manager to create one on the Table QR codes page.")
                    )}
                  </p>
                </section>
              ) : (
                <section aria-label={t("Dining session action")}>
                  <p>
                    {selected.currentDiningSessionReference
                      ? t(
                          "Replacing the entry code invalidates the previous code. Existing participants remain joined.",
                        )
                      : t("Start a new dining session for this party.")}
                  </p>
                  <label>
                    <input
                      type="checkbox"
                      checked={confirmed}
                      disabled={locked || paused}
                      onChange={(event) => setConfirmed(event.target.checked)}
                    />
                    {t("I confirm the selected table and session action")}
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
                      ? t("Retry same session request")
                      : state === "Submitting"
                        ? t("Submitting…")
                        : selected.currentDiningSessionReference
                          ? t("Replace entry code")
                          : t("Start dining session")}
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
                <section aria-label={t("Table availability action")}>
                  <p>{t("Mark a table unavailable while it can't be seated.")}</p>
                  {selected.operationalState === "Available" ? (
                    <>
                      <label className="dining-table-reason">
                        {t("Reason")}
                        <select
                          value={blockReasonCode}
                          aria-describedby="dining-table-reason-help"
                          disabled={locked || paused}
                          onChange={(event) => setBlockReasonCode(event.target.value)}
                        >
                          <option value="">{t("Choose a reason")}</option>
                          {tableBlockReasons.map(([code, label]) => (
                            <option key={code} value={code}>
                              {label}
                            </option>
                          ))}
                        </select>
                        <small id="dining-table-reason-help">
                          {t("Required. Guests can't be seated here until you mark it available.")}
                        </small>
                      </label>
                      <button
                        disabled={
                          paused ||
                          hostLocked ||
                          state === "Loading" ||
                          state === "Submitting" ||
                          (state === "Unknown" && unknownAction !== "Availability") ||
                          (state !== "Unknown" && !/^[A-Z][A-Z0-9_-]{0,63}$/.test(blockReasonCode))
                        }
                        onClick={() => void executeAvailability("SetBlock")}
                      >
                        {state === "Unknown" && unknownAction === "Availability"
                          ? t("Retry same availability request")
                          : state === "Submitting"
                            ? t("Updating availability…")
                            : t("Mark table unavailable")}
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
                        ? t("Retry same availability request")
                        : state === "Submitting"
                          ? t("Updating availability…")
                          : selected.blockReasonCode === "CLEANING"
                            ? t("Cleaned · ready for guests")
                            : t("Mark table available")}
                    </button>
                  )}
                </section>
              ) : null}
              {code ? <DiningEntryCode code={code} onHide={() => setCode(null)} /> : null}
            </>
          ) : (
            <div className="dining-session-detail__empty">
              <p>{t("Select a table to review its current state and available session action.")}</p>
              <p>
                {t(
                  "Start a session when a party sits down and give them the table code. Their orders and payments are on the Orders page.",
                )}
              </p>
            </div>
          )}
        </aside>
      </div>
      <p role="status" className="dining-floor-message">
        {state === "Loading" ? t("Loading tables…") : message}
      </p>
    </WorkspacePage>
  );
}
