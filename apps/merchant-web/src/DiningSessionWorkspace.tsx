import { t } from "./i18n/i18n.js";
import { UnpaidRoundCancelAction, isPaymentUnconfirmed } from "./UnpaidRoundCancelAction.js";
import { paidRoundWait, tableRoundWaitText, type PaidRoundWaitTier } from "./paid-round-wait.js";
import { DiningHostTransferAction } from "./DiningHostTransferAction.js";
import { useEffect, useMemo, useRef, useState } from "react";
import { DiningServeReadyClientError } from "./dining-serve-ready-client.js";
import { serveReadySummary } from "./dining-serve-ready.js";
import {
  loadTableOrderFacts,
  prepareServeAllReady,
  type TableOrderFacts,
} from "./table-order-facts.js";
import {
  compareTables,
  staffCallReasonText,
  tableInTab,
  tableNeed,
  tableTabs,
  type TableNeed,
  type TableTab,
} from "./table-needs.js";
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
import { LastOrdersNotice } from "./LastOrdersNotice.js";
import { TableCheckout } from "./TableCheckout.js";
import { TablePartySize, createTablePartySizeClient } from "./TablePartySize.js";
import { TableMove } from "./TableMove.js";
import { TableMerge } from "./TableMerge.js";
import { TableOrderRounds } from "./TableOrderRounds.js";
import { RoundHoldSettingControl, TableHeldRounds, TablePanelPhones } from "./TablePhones.js";
import { TablesOfflineGuide } from "./TablesOfflineGuide.js";
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

export { staffCallReasonText };

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

/** WP-2423 item 8 ①: a result said in words, with "Undo" where the step can be taken back. */
interface TableResult {
  readonly text: string;
  readonly undo?: (() => void) | undefined;
}

/**
 * WP-2423 item 8 ① (Owner decision 2, Figma 44-2 approved 2026-10-27): the Tables page is the
 * server's main screen. Tables are listed by what they need, most urgent first, each with its one
 * next step (answer a call, serve what is ready, take the payment, mark it cleaned); free tables are
 * opened in one tap. The selected table's panel serves dishes, starts checkout, takes the payment
 * and closes the table. Everyday steps (serve, open, clean, close) are not confirmed: they say what
 * happened, and cleaning can be undone. Only money and cancelling are confirmed.
 */
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
    [selectedReference, setSelectedReference] = useState<string | null>(null),
    [code, setCode] = useState<{ table: string; value: string } | null>(null),
    [message, setMessage] = useState(""),
    [result, setResult] = useState<TableResult | null>(null),
    [state, setState] = useState<"Idle" | "Loading" | "Submitting" | "Unknown">("Idle");
  const [orderFacts, setOrderFacts] = useState<ReadonlyMap<string, TableOrderFacts>>(new Map());
  const [tab, setTab] = useState<TableTab>("Needs");
  const detailRef = useRef<HTMLElement | null>(null);
  const pending = useRef<AbortController | null>(null),
    operation = useRef<{ table: string; prepared: Operation } | null>(null),
    availabilityOperations = useRef(new Map<string, AvailabilityOperation>()),
    serveOperations = useRef(new Map<string, ReturnType<typeof prepareServeAllReady>>());
  const [canCloseSessions, setCanCloseSessions] = useState(false);
  const [canTransferHost, setCanTransferHost] = useState(false);
  const [canCancelUnpaidRounds, setCanCancelUnpaidRounds] = useState(false);
  const [canWriteOff, setCanWriteOff] = useState(false);
  const [canOperateTables, setCanOperateTables] = useState(false),
    [blockReasonCode, setBlockReasonCode] = useState(""),
    [checkoutRevision, setCheckoutRevision] = useState(0),
    [unknownAction, setUnknownAction] = useState<"Session" | "Availability" | null>(null);
  const [hostLocked, setHostLocked] = useState(false);
  // IDR-0039: a failed refresh keeps the last loaded tables on screen, read-only, and retries.
  const [stale, setStale] = useState<StaleRead | null>(null);
  const loadedAt = useRef<string | null>(null);
  const paused = stale !== null;
  const locked = state !== "Idle" || hostLocked;
  const [now, setNow] = useState(() => Date.now());
  const selected = tables.find((table) => table.tableReference === selectedReference) ?? null;
  const anySeated = tables.some(
    (table) =>
      table.currentDiningSessionReference !== null ||
      table.staffRoundsAwaitingPayment.length > 0 ||
      table.guestRoundsAwaitingPayment.length > 0 ||
      table.roundsAwaitingAcceptance.length > 0,
  );
  // WP-2423 Q28: answering a guest's call for staff.
  const [answering, setAnswering] = useState<string | null>(null);
  const answerOperations = useRef(new Map<string, string>());
  const answerCall = async (table: StaffDiningTable) => {
    const call = table.staffCall;
    if (call === null || call === undefined || answering !== null || paused) return;
    const reference = answerOperations.current.get(call.callReference) ?? newOperationReference();
    answerOperations.current.set(call.callReference, reference);
    setAnswering(call.callReference);
    setResult(null);
    try {
      await createDiningSessionClient().answerStaffCall(csrf, reference, call.callReference);
      answerOperations.current.delete(call.callReference);
      setTables((current) =>
        current.map((entry) =>
          entry.tableReference === table.tableReference ? { ...entry, staffCall: null } : entry,
        ),
      );
      setResult({ text: t("Table {table}: marked as handled.", { table: table.stableLabel }) });
    } catch {
      setResult({
        text: t("Table {table}: not confirmed. Check the connection and try again.", {
          table: table.stableLabel,
        }),
      });
    } finally {
      setAnswering(null);
    }
  };
  /** The open tables' dishes and bills, from the order queue (kept on a failed read). */
  const loadFacts = async (items: readonly StaffDiningTable[], signal: AbortSignal) => {
    const orders = items.flatMap((table) =>
      table.session?.orderReference ? [table.session.orderReference] : [],
    );
    try {
      const facts = await loadTableOrderFacts(orders, signal);
      if (!signal.aborted) setOrderFacts(facts);
    } catch {
      /* The list still shows each table's own state; the dishes are read again with it. */
    }
  };
  /** `background`: an automatic re-read; the selected table and any shown entry code stay. */
  const load = async (more = false, background = false) => {
    if ((pending.current && !pending.current.signal.aborted) || state === "Unknown" || hostLocked)
      return;
    const controller = new AbortController();
    pending.current = controller;
    setState("Loading");
    if (!background) {
      setMessage("");
      operation.current = null;
      availabilityOperations.current.clear();
      setUnknownAction(null);
    }
    try {
      const loaded = await createDiningSessionClient().tables(
        csrf,
        more ? next : null,
        controller.signal,
      );
      if (!controller.signal.aborted) {
        loadedAt.current = new Date().toISOString();
        setStale(null);
        const items = more ? [...tables, ...loaded.items] : loaded.items;
        setTables(items);
        setNext(loaded.next);
        setCanOperateTables(loaded.canOperateTables);
        setCanCloseSessions(loaded.canCloseSessions);
        setCanTransferHost(loaded.canTransferHost);
        setCanCancelUnpaidRounds(loaded.canCancelUnpaidRounds);
        setCanWriteOff(loaded.canWriteOff);
        if (loaded.items.length === 0 && !more)
          setMessage(t("No tables are available in this Store."));
        void loadFacts(items, controller.signal);
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
  const reread = () => void loadRef.current(false, true);
  useStaleRetry(stale?.attempts ?? null, reread);
  // v15 cbff9d6f: no reads once this screen's sign-in has ended.
  const live = useStaffSessionLive();
  useEffect(() => {
    if (!anySeated || !live) return;
    setNow(Date.now());
    let ticks = 0;
    const timer = setInterval(() => {
      setNow(Date.now());
      ticks += 1;
      // Every 30 seconds; a failing read goes read-only through the stale retry above.
      if (ticks % 2 === 0 && !paused) void loadRef.current(false, true);
    }, 15_000);
    return () => clearInterval(timer);
  }, [anySeated, live, paused]);
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
  const select = (table: StaffDiningTable) => {
    if (table.tableReference !== selectedReference) {
      setBlockReasonCode("");
      if (code?.table !== table.tableReference) setCode(null);
    }
    setSelectedReference(table.tableReference);
    // Presentation only: below the desktop width the table opens under (or over) the list.
    if (typeof window.matchMedia === "function" && window.matchMedia("(max-width: 1023px)").matches)
      requestAnimationFrame(() => detailRef.current?.scrollIntoView?.({ block: "start" }));
  };
  /** Open a free table (or give a seated one a new entry code). Not confirmed: it says the code. */
  const startSession = async (table: StaffDiningTable) => {
    if (
      paused ||
      browserOffline() ||
      hostLocked ||
      pending.current ||
      (state === "Unknown" && unknownAction !== "Session") ||
      (operation.current !== null && operation.current.table !== table.tableReference)
    )
      return;
    select(table);
    const controller = new AbortController();
    pending.current = controller;
    setState("Submitting");
    setCode(null);
    setResult(null);
    try {
      const client = createDiningSessionClient();
      if (!operation.current) {
        if (table.currentDiningSessionReference === null) {
          operation.current = {
            table: table.tableReference,
            prepared: client.prepareStart(table, serviceOperationReference()),
          };
        } else {
          const current = await client.joinState(
            table.currentDiningSessionReference,
            csrf,
            controller.signal,
          );
          if (current.tableReference !== table.tableReference)
            throw new DiningSessionClientError("Denied");
          operation.current = {
            table: table.tableReference,
            prepared: client.prepareRegenerate(current, serviceOperationReference()),
          };
        }
      }
      const done = await operation.current.prepared.execute(csrf, controller.signal);
      if (!controller.signal.aborted) {
        const opened = table.currentDiningSessionReference === null;
        setTables((rows) =>
          rows.map((row) =>
            row.tableReference === table.tableReference
              ? {
                  ...row,
                  currentDiningSessionReference: done.diningSessionReference,
                  elapsedMinutes: done.status === "Issued" ? 0 : row.elapsedMinutes,
                }
              : row,
          ),
        );
        if (done.joinCredential)
          setCode({ table: table.tableReference, value: done.joinCredential });
        operation.current = null;
        setUnknownAction(null);
        setState("Idle");
        setResult({
          text: done.joinCredential
            ? opened
              ? t("Table {table} is open. Give the guests the entry code below.", {
                  table: table.stableLabel,
                })
              : t("Table {table} has a new entry code; the old one no longer works.", {
                  table: table.stableLabel,
                })
            : t(
                "The request already completed. Its code cannot be displayed again. Replace the entry code to get a new one.",
              ),
        });
        reread();
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        const unknown = error instanceof DiningSessionClientError && error.code === "Unknown";
        setState(unknown ? "Unknown" : "Idle");
        setUnknownAction(unknown ? "Session" : null);
        if (!unknown) operation.current = null;
        setResult({
          text: unknown
            ? t("The result is unknown. Press it again: the same request is sent, never twice.")
            : t("The request was not confirmed. Refresh the table and check your permissions."),
        });
      }
    } finally {
      if (pending.current === controller) pending.current = null;
    }
  };
  /** Mark a table unavailable or available again; cleaning is undone the same way. */
  const setAvailability = async (
    table: StaffDiningTable,
    action: "SetBlock" | "ClearBlock",
    reason: string | null,
    undoable: boolean,
  ) => {
    if (
      paused ||
      browserOffline() ||
      !canOperateTables ||
      hostLocked ||
      pending.current ||
      (state === "Unknown" && unknownAction !== "Availability") ||
      (action === "SetBlock" && !/^[A-Z][A-Z0-9_-]{0,63}$/.test(reason ?? ""))
    )
      return;
    const key = [table.tableReference, action, reason ?? ""].join(":");
    const controller = new AbortController();
    pending.current = controller;
    setState("Submitting");
    setResult(null);
    try {
      const prepared =
        availabilityOperations.current.get(key) ??
        createDiningSessionClient().prepareAvailability(
          table,
          action,
          reason,
          serviceOperationReference(),
        );
      availabilityOperations.current.set(key, prepared);
      const done = await prepared.execute(csrf, controller.signal);
      if (!controller.signal.aborted) {
        const updated: StaffDiningTable = {
          ...table,
          operationalState: done.operationalState,
          aggregateVersion: done.aggregateVersion,
          blockReasonCode: action === "SetBlock" ? reason : null,
        };
        setTables((rows) =>
          rows.map((row) => (row.tableReference === updated.tableReference ? updated : row)),
        );
        availabilityOperations.current.delete(key);
        setUnknownAction(null);
        setBlockReasonCode("");
        setState("Idle");
        const cleaned = action === "ClearBlock" && table.blockReasonCode === "CLEANING";
        setResult({
          text: cleaned
            ? t("Table {table} is clean and free for the next guests.", {
                table: table.stableLabel,
              })
            : action === "SetBlock"
              ? reason === "CLEANING"
                ? t("Table {table} is back to needing cleaning.", { table: table.stableLabel })
                : t("Table {table} is marked unavailable.", { table: table.stableLabel })
              : t("Table {table} is available.", { table: table.stableLabel }),
          undo:
            undoable && cleaned
              ? () => void setAvailability(updated, "SetBlock", "CLEANING", false)
              : undefined,
        });
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        const unknown = error instanceof DiningSessionClientError && error.code === "Unknown";
        setState(unknown ? "Unknown" : "Idle");
        setUnknownAction(unknown ? "Availability" : null);
        if (!unknown) availabilityOperations.current.delete(key);
        setResult({
          text: unknown
            ? t("The result is unknown. Press it again: the same request is sent, never twice.")
            : t("The table request was not confirmed. Refresh and check current permissions."),
        });
        if (!unknown) reread();
      }
    } finally {
      if (pending.current === controller) pending.current = null;
    }
  };
  /** "Serve all" from the list: everything ready at the pass for the table, said in words. */
  const [serving, setServing] = useState<string | null>(null);
  const serveAll = async (table: StaffDiningTable) => {
    const order = table.session?.orderReference ?? null;
    if (order === null || serving !== null || paused || browserOffline()) return;
    const prepared = serveOperations.current.get(order) ?? prepareServeAllReady(order, csrf);
    serveOperations.current.set(order, prepared);
    setServing(table.tableReference);
    setResult(null);
    try {
      const done = await prepared.execute();
      serveOperations.current.delete(order);
      setResult({
        text:
          done === null
            ? t("Table {table}: nothing is ready to serve any more.", { table: table.stableLabel })
            : t("Table {table}: {summary}", {
                table: table.stableLabel,
                summary: serveReadySummary(done),
              }),
      });
      setCheckoutRevision((value) => value + 1);
    } catch (error) {
      const lost = error instanceof DiningServeReadyClientError && error.code === "OutcomeUnknown";
      if (!lost) serveOperations.current.delete(order);
      setResult({
        text: lost
          ? t(
              "Table {table}: we could not confirm the dishes were marked served. Press it again: nothing is served twice.",
              { table: table.stableLabel },
            )
          : t("Table {table}: nothing was marked served. Open the table and check its dishes.", {
              table: table.stableLabel,
            }),
      });
    } finally {
      setServing(null);
      reread();
    }
  };
  const rows = useMemo(
    () =>
      tables
        .map((table) => ({
          table,
          need: tableNeed(
            table,
            table.session?.orderReference
              ? (orderFacts.get(table.session.orderReference) ?? null)
              : null,
            now,
          ),
        }))
        .sort(compareTables),
    [tables, orderFacts, now],
  );
  const counts = new Map(
    tableTabs.map((value) => [
      value,
      rows.filter((row) => tableInTab(row.table, row.need, value)).length,
    ]),
  );
  const seatedCount = counts.get("Seated") ?? 0;
  const needCount = counts.get("Needs") ?? 0;
  const freeRows = rows
    .filter((row) => row.table.currentDiningSessionReference === null && row.need.step === null)
    .sort((a, b) =>
      a.table.stableLabel.localeCompare(b.table.stableLabel, undefined, { numeric: true }),
    );
  // A lost answer leaves only its own step pressable ("try again", the same request).
  const busy = state === "Loading" || state === "Submitting" || hostLocked;
  const busyRow = (table: StaffDiningTable) =>
    busy ||
    paused ||
    serving !== null ||
    answering !== null ||
    (state === "Unknown" && operation.current?.table !== table.tableReference);
  const tabText: Record<TableTab, string> = {
    Needs: t("Needs action"),
    All: t("All"),
    Seated: t("Seated"),
    Free: t("Free"),
    Cleaning: t("Needs cleaning"),
  };
  const stepButton = (table: StaffDiningTable, need: TableNeed) => {
    switch (need.step) {
      case "Handled":
        return (
          <button
            type="button"
            className="table-row__text-step"
            disabled={busyRow(table)}
            onClick={() => void answerCall(table)}
          >
            {answering === table.staffCall?.callReference ? t("Saving…") : t("Handled")}
          </button>
        );
      case "ServeAll":
        return (
          <button
            type="button"
            className="table-row__step"
            disabled={busyRow(table)}
            onClick={() => void serveAll(table)}
          >
            {serving === table.tableReference ? t("Serving…") : t("Serve all")}
          </button>
        );
      case "TakePayment":
        return (
          <button
            type="button"
            className="table-row__step"
            disabled={paused || hostLocked}
            onClick={() => select(table)}
          >
            {t("Take payment")}
          </button>
        );
      case "Cleaned":
        return canOperateTables ? (
          <button
            type="button"
            className="table-row__text-step"
            disabled={busyRow(table)}
            onClick={() => void setAvailability(table, "ClearBlock", null, true)}
          >
            {t("Cleaned")}
          </button>
        ) : null;
      default:
        return null;
    }
  };
  // v15 live check (4a): the list shows how many guests sit at each seated table (when recorded).
  const seatedSessions = tables
    .map((table) => table.currentDiningSessionReference)
    .filter((reference): reference is string => reference !== null)
    .sort()
    .join(",");
  const [partySizes, setPartySizes] = useState<ReadonlyMap<string, number>>(new Map());
  useEffect(() => {
    if (!csrf || seatedSessions === "") return;
    const controller = new AbortController();
    void createTablePartySizeClient()
      .readMany?.(csrf, seatedSessions.split(","), controller.signal)
      .then((found) => {
        if (!controller.signal.aborted) setPartySizes(found);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [csrf, seatedSessions, loadedAt.current]);
  const guestsText = (table: StaffDiningTable) => {
    const count =
      table.currentDiningSessionReference === null
        ? undefined
        : partySizes.get(table.currentDiningSessionReference);
    return count === undefined
      ? ""
      : " · " + (count === 1 ? t("1 guest") : t("{count} guests", { count }));
  };
  const tableRow = ({ table, need }: { table: StaffDiningTable; need: TableNeed }) => (
    <li
      key={table.tableReference}
      className="table-row"
      data-selected={table.tableReference === selectedReference}
      data-tone={need.tone}
      data-urgent={need.urgent === true}
    >
      <button
        type="button"
        className="table-row__open"
        aria-pressed={table.tableReference === selectedReference}
        aria-label={t("Select {stableLabel}", { stableLabel: table.stableLabel })}
        aria-describedby={"table-need-" + table.tableReference}
        disabled={paused || hostLocked}
        onClick={() => select(table)}
      >
        <span className="table-row__name">
          <strong>{t("Table {table}", { table: table.stableLabel })}</strong>
          <span className="table-row__meta">
            {table.currentDiningSessionReference === null
              ? t("Seats {capacity}", { capacity: table.capacity })
              : table.elapsedMinutes === null
                ? t("Seats {capacity}", { capacity: table.capacity })
                : t("Seats {capacity} · {open}", {
                    capacity: table.capacity,
                    open: elapsedText(table.elapsedMinutes),
                  }) + guestsText(table)}
          </span>
        </span>
        <span
          className="table-row__status"
          data-tone={need.tone}
          id={"table-need-" + table.tableReference}
        >
          {need.words}
          {need.detail ? <span className="table-row__detail">{need.detail}</span> : null}
        </span>
      </button>
      <span className="table-row__next">{stepButton(table, need)}</span>
    </li>
  );
  const visible = rows.filter((row) => tableInTab(row.table, row.need, tab));
  const seatedOthers = rows.filter(
    (row) => row.table.currentDiningSessionReference !== null && row.need.tone !== "action",
  );
  const freeLine =
    freeRows.length === 0 ? null : (
      <section className="table-free" aria-label={t("Free tables")}>
        <h3>{t("Free tables")}</h3>
        <ul>
          {freeRows.map(({ table }) => (
            <li key={table.tableReference}>
              <button
                type="button"
                className="table-free__name"
                aria-pressed={table.tableReference === selectedReference}
                aria-label={t("Select {stableLabel}", { stableLabel: table.stableLabel })}
                disabled={paused || hostLocked}
                onClick={() => select(table)}
              >
                {t("Table {table}", { table: table.stableLabel })}
              </button>
              {table.operationalState === "Available" &&
              table.lifecycle === "Published" &&
              table.qrCodeValidUntil !== null ? (
                <button
                  type="button"
                  className="table-row__text-step"
                  disabled={busyRow(table)}
                  onClick={() => void startSession(table)}
                >
                  {state === "Submitting" && operation.current?.table === table.tableReference
                    ? t("Opening…")
                    : state === "Unknown" &&
                        unknownAction === "Session" &&
                        operation.current?.table === table.tableReference
                      ? t("Try opening again")
                      : t("Open")}
                </button>
              ) : (
                <span className="table-free__why">
                  {table.operationalState !== "Available"
                    ? t("Unavailable")
                    : t("No table QR code")}
                </span>
              )}
            </li>
          ))}
        </ul>
      </section>
    );
  return (
    <WorkspacePage
      className="dining-floor tables-v3"
      title={t("Tables")}
      meta={storeLabel}
      status={
        tables.length > 0 ? (
          <span className="dining-floor-summary">
            <span>{t("{seatedCount} seated", { seatedCount: String(seatedCount) })}</span>
            {needCount > 0 ? (
              <span data-attention="true">
                {t("{count} need you", { count: String(needCount) })}
              </span>
            ) : null}
          </span>
        ) : null
      }
      actions={
        <>
          <button className="tables-v3__quiet" disabled={locked} onClick={() => void load()}>
            {t("Refresh tables")}
          </button>
          {next ? (
            <button
              className="tables-v3__quiet"
              disabled={locked || stale !== null}
              onClick={() => void load(true)}
            >
              {t("Load more tables")}
            </button>
          ) : null}
        </>
      }
    >
      {/* WP-2423 item 8 ③ follow-up: guests' last orders coming, or passed (staff still can). */}
      <LastOrdersNotice timeZone={timeZone} />
      {/* WP-2423 item 8 ⑤ decision 5: the Store's "a new phone's first round waits for staff". */}
      {csrf ? <RoundHoldSettingControl csrf={csrf} locked={locked} /> : null}
      {stale ? <StaleReadNotice stale={stale} /> : null}
      {/* Operating continuity: what servers do while the page can't reach the store system. */}
      {stale ? <TablesOfflineGuide /> : null}
      <nav className="table-tabs" aria-label={t("Show tables")}>
        {tableTabs.map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={tab === value}
            onClick={() => setTab(value)}
          >
            {tabText[value]} <span className="table-tabs__count">{counts.get(value) ?? 0}</span>
          </button>
        ))}
      </nav>
      {result ? (
        <p className="table-result" role="status">
          {result.text}
          {result.undo ? (
            <button
              type="button"
              className="table-row__text-step"
              disabled={locked || paused}
              onClick={() => {
                const undo = result.undo;
                setResult(null);
                undo?.();
              }}
            >
              {t("Undo")}
            </button>
          ) : null}
        </p>
      ) : null}
      <div className="dining-floor-layout">
        <section className="table-list" aria-label={t("Tables by what they need")}>
          {tables.length === 0 ? (
            <p role="status" className="dining-floor-empty" data-loading={state === "Loading"}>
              {state === "Loading"
                ? t("Loading tables…")
                : message || t("No tables have been loaded.")}
            </p>
          ) : tab === "Needs" ? (
            <>
              <h2 className="table-list__group">{t("Needs action")}</h2>
              {visible.length === 0 ? (
                <p className="table-list__calm">{t("Nothing needs you right now.")}</p>
              ) : (
                <ul className="table-rows">{visible.map(tableRow)}</ul>
              )}
              {seatedOthers.length > 0 ? (
                <>
                  <h2 className="table-list__group">{t("Seated")}</h2>
                  <ul className="table-rows">{seatedOthers.map(tableRow)}</ul>
                </>
              ) : null}
              {freeLine}
            </>
          ) : tab === "Free" ? (
            (freeLine ?? <p className="table-list__calm">{t("No free tables.")}</p>)
          ) : visible.length === 0 ? (
            <p className="table-list__calm">{t("No tables here.")}</p>
          ) : (
            <ul className="table-rows">{visible.map(tableRow)}</ul>
          )}
        </section>
        <aside
          ref={detailRef}
          className="dining-session-detail table-panel"
          aria-label={t("Selected table details")}
        >
          {selected ? (
            <TablePanel
              key={selected.tableReference}
              table={selected}
              csrf={csrf}
              timeZone={timeZone}
              now={now}
              code={code?.table === selected.tableReference ? code.value : null}
              onHideCode={() => setCode(null)}
              locked={locked || paused}
              busy={busy || paused}
              state={state}
              unknownAction={unknownAction}
              canCloseSessions={canCloseSessions}
              canTransferHost={canTransferHost}
              canCancelUnpaidRounds={canCancelUnpaidRounds}
              canWriteOff={canWriteOff}
              canOperateTables={canOperateTables}
              canTakeOrders={canTakeOrders}
              tableQrHref={tableQrHref}
              checkoutRevision={checkoutRevision}
              refreshKey={String(loadedAt.current)}
              onPartySize={(session, size) =>
                setPartySizes((current) => new Map(current).set(session, size))
              }
              blockReasonCode={blockReasonCode}
              onBlockReason={setBlockReasonCode}
              onHostLocked={setHostLocked}
              onStart={() => void startSession(selected)}
              onAvailability={(action) =>
                void setAvailability(
                  selected,
                  action,
                  action === "SetBlock" ? blockReasonCode : null,
                  true,
                )
              }
              hostTransferDisabled={state !== "Idle" || paused}
              tables={tables}
              onMoved={(text, targetReference) => {
                // WP-2423 item 8 ⑧: the party sits at the other table now; show that table.
                void loadRef.current(false, true).then(() => {
                  if (targetReference !== null) setSelectedReference(targetReference);
                  if (text !== "") setResult({ text });
                });
              }}
              onReread={reread}
              onChanged={() => {
                setCheckoutRevision((value) => value + 1);
                reread();
              }}
              onClosed={() => {
                void loadRef.current(false, true).then(() =>
                  setResult({
                    text: t("Table {table} is closed. Clean it, then mark it cleaned.", {
                      table: selected.stableLabel,
                    }),
                  }),
                );
              }}
            />
          ) : (
            <div className="dining-session-detail__empty">
              <p>{t("Choose a table to serve it, take its payment or close it.")}</p>
            </div>
          )}
        </aside>
      </div>
      {message && tables.length > 0 ? (
        <p role="status" className="dining-floor-message">
          {message}
        </p>
      ) : null}
    </WorkspacePage>
  );
}

/** The selected table: its notices, dishes, checkout and close, then the less frequent steps. */
function TablePanel({
  table,
  csrf,
  timeZone,
  now,
  code,
  onHideCode,
  locked,
  busy,
  state,
  unknownAction,
  canCloseSessions,
  canTransferHost,
  canCancelUnpaidRounds,
  canWriteOff,
  canOperateTables,
  canTakeOrders,
  tableQrHref,
  checkoutRevision,
  refreshKey,
  blockReasonCode,
  onBlockReason,
  onHostLocked,
  onStart,
  onAvailability,
  onChanged,
  onClosed,
  onReread,
  hostTransferDisabled,
  onPartySize,
  tables,
  onMoved,
}: {
  /** WP-2423 item 8 ⑧: every table on the floor (where the party may move to). */
  readonly tables: readonly StaffDiningTable[];
  /** After a move (target null when only the tables are read again). */
  readonly onMoved: (message: string, targetReference: string | null) => void;
  /** The Order host transfer's own retry stays pressable while it holds the page. */
  readonly hostTransferDisabled: boolean;
  /** v15 2026-10-29: a party size just recorded, for the table list. */
  readonly onPartySize?: (diningSessionReference: string, partySize: number) => void;
  /** Read the tables again, keeping this table's open steps (and their messages) as they are. */
  readonly onReread: () => void;
  readonly table: StaffDiningTable;
  readonly csrf: string;
  readonly timeZone: string | undefined;
  readonly now: number;
  readonly code: string | null;
  readonly onHideCode: () => void;
  readonly locked: boolean;
  /** Busy with a step (a lost answer is not busy: its own step is pressed again). */
  readonly busy: boolean;
  readonly state: "Idle" | "Loading" | "Submitting" | "Unknown";
  readonly unknownAction: "Session" | "Availability" | null;
  readonly canCloseSessions: boolean;
  readonly canTransferHost: boolean;
  readonly canCancelUnpaidRounds: boolean;
  readonly canWriteOff: boolean;
  readonly canOperateTables: boolean;
  readonly canTakeOrders: boolean;
  readonly tableQrHref: string | undefined;
  readonly checkoutRevision: number;
  readonly refreshKey: string;
  readonly blockReasonCode: string;
  readonly onBlockReason: (value: string) => void;
  readonly onHostLocked: (locked: boolean) => void;
  readonly onStart: () => void;
  readonly onAvailability: (action: "SetBlock" | "ClearBlock") => void;
  readonly onChanged: () => void;
  readonly onClosed: () => void;
}) {
  const seated = table.currentDiningSessionReference !== null;
  const notices = tableAttentionNotices(table, now, timeZone, canCloseSessions);
  const unpaidHint = guestRoundCancelHint(table, now, canCancelUnpaidRounds);
  const eligible = table.lifecycle === "Published" && table.operationalState === "Available";
  const noCode = table.qrCodeValidUntil === null;
  // WP-2423 item 8 ⑤ decision 4: which phone sent each round, from the table's phone list.
  const [roundPhones, setRoundPhones] = useState<ReadonlyMap<string, number | null>>(new Map());
  return (
    <>
      <header className="table-panel__head">
        <h2>{t("Table {stableLabel}", { stableLabel: table.stableLabel })}</h2>
        <p className="table-panel__meta">
          {[
            t("Seats {capacity}", { capacity: table.capacity }),
            seated && table.elapsedMinutes !== null
              ? t("open {open}", { open: elapsedText(table.elapsedMinutes) })
              : null,
            seated
              ? table.paymentTiming === "PayLater"
                ? t("pays at the end")
                : t("pays each round")
              : tableFloorStatus(table).label,
          ]
            .filter((part) => part !== null)
            .join(" · ")}
        </p>
      </header>
      {notices.map((notice, index) => (
        <p
          key={index}
          className="table-panel__notice order-accept-by"
          data-tier={notice.tier ?? undefined}
          role="note"
        >
          {notice.text}
        </p>
      ))}
      {canCancelUnpaidRounds && table.guestRoundsAwaitingPayment.length > 0 ? (
        <section aria-label={t("Unpaid rounds")}>
          {unpaidHint ? <p className="table-panel__notice">{unpaidHint}</p> : null}
          {table.guestRoundsAwaitingPayment.map((round) => (
            <UnpaidRoundCancelAction
              key={round.orderBatchReference}
              orderReference={round.orderReference}
              orderBatchReference={round.orderBatchReference}
              roundNumber={round.roundNumber}
              orderLabel={"table " + table.stableLabel}
              csrf={csrf}
              paymentUnconfirmed={isPaymentUnconfirmed(round.payBy, now)}
              onSettled={onChanged}
            />
          ))}
        </section>
      ) : null}
      {code ? <DiningEntryCode code={code} onHide={onHideCode} /> : null}
      {seated && canOperateTables && table.currentDiningSessionReference !== null ? (
        // WP-2423 item 8 ⑦ (decision 2): how many guests, when the Store asks for it.
        <TablePartySize
          key={"party:" + table.currentDiningSessionReference}
          diningSessionReference={table.currentDiningSessionReference}
          tableLabel={table.stableLabel}
          csrf={csrf}
          locked={locked}
          onRecorded={(size) => {
            if (table.currentDiningSessionReference !== null)
              onPartySize?.(table.currentDiningSessionReference, size);
          }}
        />
      ) : null}
      {seated && canOperateTables && table.currentDiningSessionReference !== null ? (
        // WP-2423 item 8 ⑧ (Owner decision 3): move the party to another free table.
        <TableMove
          key={"move:" + table.currentDiningSessionReference}
          table={table}
          tables={tables}
          csrf={csrf}
          locked={locked}
          onMoved={onMoved}
        />
      ) : null}
      {seated && canOperateTables && table.currentDiningSessionReference !== null ? (
        // WP-2423 item 8 ⑨ (DEC-DINING-TABLE-MERGE): merge this party into another seated table.
        <TableMerge
          key={"merge:" + table.currentDiningSessionReference}
          table={table}
          tables={tables}
          csrf={csrf}
          locked={locked}
          onMerged={onMoved}
        />
      ) : null}
      {seated ? (
        <TableHeldRounds
          rounds={table.heldRounds ?? []}
          csrf={csrf}
          timeZone={timeZone}
          locked={locked}
          onChanged={onChanged}
        />
      ) : null}
      {seated && canOperateTables && table.currentDiningSessionReference !== null ? (
        <TablePanelPhones
          key={table.currentDiningSessionReference}
          diningSessionReference={table.currentDiningSessionReference}
          csrf={csrf}
          timeZone={timeZone}
          now={now}
          locked={locked}
          refreshKey={refreshKey + ":" + String(checkoutRevision)}
          onRounds={setRoundPhones}
        />
      ) : null}
      {seated && table.session?.orderReference ? (
        // Orders v3 (Owner 2026-10-26): the table's rounds and dishes, served from here.
        <TableOrderRounds
          key={table.session.orderReference}
          orderReference={table.session.orderReference}
          csrf={csrf}
          timeZone={timeZone}
          refreshKey={refreshKey + ":" + String(checkoutRevision)}
          locked={locked}
          onChanged={onChanged}
          roundPhones={roundPhones}
        />
      ) : seated ? (
        <p className="table-panel__notice">{t("Nothing ordered yet.")}</p>
      ) : null}
      {seated
        ? // WP-2423 item 8 ⑨: the rounds of the tables merged into this one (on its bill), served
          // from here too.
          (table.session?.mergedTables ?? []).map((merged) =>
            merged.orderReference === null ? null : (
              <section
                key={merged.orderReference}
                className="table-panel__merged"
                aria-label={t("From table {table}", { table: merged.fromTableLabel })}
              >
                <h3>{t("From table {table}", { table: merged.fromTableLabel })}</h3>
                <TableOrderRounds
                  orderReference={merged.orderReference}
                  csrf={csrf}
                  timeZone={timeZone}
                  refreshKey={refreshKey + ":" + String(checkoutRevision)}
                  locked={locked}
                  onChanged={onChanged}
                  roundPhones={roundPhones}
                />
              </section>
            ),
          )
        : null}
      {seated && table.paymentTiming === "PayLater" && table.session ? (
        // DEC-DINE-IN-PAY-LATER: the table pays once at the end, here (servers too, v18).
        <TableCheckout
          key={String(table.currentDiningSessionReference) + ":" + table.session.phase}
          table={table}
          session={table.session}
          csrf={csrf}
          canStart={canCloseSessions}
          canWriteOff={canWriteOff}
          timeZone={timeZone}
          locked={locked}
          onChanged={onChanged}
        />
      ) : null}
      {seated && canCloseSessions && table.session ? (
        <TableSessionClose
          key={String(table.currentDiningSessionReference) + ":" + String(checkoutRevision)}
          table={table}
          session={table.session}
          csrf={csrf}
          timeZone={timeZone}
          locked={locked}
          canResolveGuestsLeft={canCancelUnpaidRounds}
          onBusy={() => undefined}
          onClosed={onClosed}
          onRefresh={onReread}
        />
      ) : seated && canCloseSessions ? (
        // v15 live check (4a): a table just opened is read again before its checkout and close
        // show; meanwhile it says so (never the note meant for staff who can't close tables).
        <p role="status" className="dining-close-who">
          {t("Reading this table…")}
        </p>
      ) : seated ? (
        <p role="note" className="dining-close-who">
          {t("A manager or the owner closes the table. Tell them when the guests have left.")}
        </p>
      ) : null}
      {!seated && (eligible || noCode) ? (
        <section className="table-panel__open" aria-label={t("Open this table")}>
          {noCode ? (
            // WP-2423 item 7: guests join by scanning the table's QR code, so it needs one first.
            <p role="note">
              {t(
                "Table {table} has no table QR code yet, so guests can't join it and orders can't be taken for it.",
                { table: table.stableLabel },
              )}{" "}
              {tableQrHref !== undefined ? (
                <>
                  {t("Create one on")} <Link to={tableQrHref}>{t("Table QR codes")}</Link>{" "}
                  {t("first.")}
                </>
              ) : (
                t("Ask a manager to create one on the Table QR codes page.")
              )}
            </p>
          ) : (
            <button
              type="button"
              className="table-panel__primary"
              disabled={
                busy ||
                !eligible ||
                state === "Submitting" ||
                (state === "Unknown" && unknownAction !== "Session")
              }
              onClick={onStart}
            >
              {state === "Unknown" && unknownAction === "Session"
                ? t("Try opening again")
                : state === "Submitting"
                  ? t("Opening…")
                  : t("Open table")}
            </button>
          )}
        </section>
      ) : null}
      <section className="table-panel__more" aria-label={t("More for this table")}>
        {canTakeOrders && eligible && !noCode ? (
          // WP-2423 Q7 slice 2: a round for guests who can't or won't order on a phone (or a
          // paper order entered after an outage); it joins the table's order, or opens the table.
          <Link
            className="table-panel__text-step"
            to={`/operations/order-entry?table=${encodeURIComponent(table.tableReference)}`}
          >
            {t("Take order for table {stableLabel}", { stableLabel: table.stableLabel })}
          </Link>
        ) : null}
        {seated && !noCode ? (
          <button
            type="button"
            className="table-panel__text-step"
            disabled={busy || (state === "Unknown" && unknownAction !== "Session")}
            onClick={onStart}
          >
            {state === "Unknown" && unknownAction === "Session"
              ? t("Try the new entry code again")
              : t("New entry code")}
          </button>
        ) : null}
        {seated && canTransferHost && table.currentDiningSessionReference ? (
          <DiningHostTransferAction
            key={table.currentDiningSessionReference}
            diningSessionReference={table.currentDiningSessionReference}
            csrf={csrf}
            disabled={hostTransferDisabled}
            onLocked={onHostLocked}
          />
        ) : null}
        {canOperateTables ? (
          table.operationalState === "Available" ? (
            <div className="table-panel__block">
              <label className="dining-table-reason">
                {t("Mark unavailable")}
                <select
                  value={blockReasonCode}
                  disabled={busy}
                  onChange={(event) => onBlockReason(event.target.value)}
                >
                  <option value="">{t("Choose a reason")}</option>
                  {tableBlockReasons.map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="table-panel__text-step"
                disabled={
                  busy ||
                  (state === "Unknown" && unknownAction !== "Availability") ||
                  !/^[A-Z][A-Z0-9_-]{0,63}$/.test(blockReasonCode)
                }
                onClick={() => onAvailability("SetBlock")}
              >
                {t("Mark unavailable")}
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="table-panel__text-step"
              disabled={busy || (state === "Unknown" && unknownAction !== "Availability")}
              onClick={() => onAvailability("ClearBlock")}
            >
              {table.blockReasonCode === "CLEANING" ? t("Cleaned") : t("Mark available")}
            </button>
          )
        ) : null}
      </section>
    </>
  );
}
