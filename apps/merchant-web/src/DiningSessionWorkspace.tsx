import { PaidOrderSwitchLine } from "./PaidOrderSwitchLine.js";
import { wordGap } from "./word-gap.js";
import { elapsedText } from "./elapsed-text.js";
import { openedOnEarlierDay } from "./earlier-day-tables.js";
import { tablesClosingAlert } from "./tables-closing-alert.js";
import { useStoreBusinessDay } from "./StoreBusinessDay.js";
import { countOf, listSeparator, t, saidTable } from "./i18n/i18n.js";
import { createTableCheckoutClient } from "./table-checkout-client.js";
import { clearLastBills, loadLastBills, saveLastBills } from "./table-last-bills.js";
import { UnpaidRoundCancelAction, isPaymentUnconfirmed } from "./UnpaidRoundCancelAction.js";
import { paidRoundWait, tableRoundWaitText, type PaidRoundWaitTier } from "./paid-round-wait.js";
import { DiningHostTransferAction } from "./DiningHostTransferAction.js";
import { useContext, useEffect, useMemo, useRef, useState, type Ref } from "react";
import { StaffCallsWaitingContext } from "./approvals-waiting.js";
import { DiningServeReadyClientError } from "./dining-serve-ready-client.js";
import { serveReadySummary } from "./dining-serve-ready.js";
import {
  listBillsByOrder,
  readListBills,
  unreadBillOrders,
  type ListBill,
} from "./table-list-bills.js";
import {
  loadTableKitchenFacts,
  kitchenReadsDue,
  mergeKitchenFacts,
  loadTableOrderFacts,
  prepareServeAllReady,
  type TableOrderFacts,
} from "./table-order-facts.js";
import { staffRoundOffer, staffRoundRefusedShortText } from "./staff-round-offer.js";
import {
  compareTables,
  staffCallReasonText,
  tableInTab,
  tableNeed,
  tableSettled,
  tablesFreeingSoon,
  tableTabs,
  type TableNeed,
  type TableTab,
} from "./table-needs.js";
import { TablesGuestStarts } from "./TablesGuestStarts.js";
import { useStaffSessionLive } from "./staff-session-reads.js";
import { WorkspacePage } from "./WorkspacePage.js";
import { StaffNavigationContext } from "./NoAccessNotice.js";
import {
  backToKitchenText,
  kitchenOnlyAccessDeniedText,
  kitchenOnlyNavigation,
} from "./access-denied.js";
import { Link, useLocation, useNavigate } from "react-router";
import { readTablesOpenTable } from "./tables-open-table.js";
import {
  createDiningSessionClient,
  DiningSessionClientError,
  longOpenSessionMinutes,
  readAllTables,
  type StaffDiningTable,
  type StaffTableAllergenChoice,
} from "./dining-session-client.js";
import { TableAllergies, tableAllergenText } from "./TableAllergies.js";
import { serviceOperationReference } from "./service-control-client.js";
import { ClockStyleContext, storeTime } from "./StoreTime.js";
import { newOperationReference } from "./operation-reference.js";
import { TableSessionClose } from "./TableSessionClose.js";
import { LastOrdersNotice } from "./LastOrdersNotice.js";
import { TableCheckout } from "./TableCheckout.js";
import { TablePartySize, TableTeaCheck, createTablePartySizeClient } from "./TablePartySize.js";
import { TableMove } from "./TableMove.js";
import { TableMerge } from "./TableMerge.js";
import { TableBillTotal, useBillRoundNumbers } from "./TableBillTotal.js";
import { TableOrderRounds } from "./TableOrderRounds.js";
import {
  CheckoutScopeSettingControl,
  RoundHoldSettingControl,
  TableHeldRounds,
  TablePanelPhones,
} from "./TablePhones.js";
import { TableCartPanel } from "./TableCartPanel.js";
import { TablesOfflineGuide } from "./TablesOfflineGuide.js";
import {
  browserOffline,
  StaleReadNotice,
  useBrowserOffline,
  useStaleRetry,
  type StaleRead,
} from "./stale-read.js";
import {
  floorServerProblemText,
  serverSideProblemText,
  isServerProblem,
  notConfirmedPressAgainText,
  tableChangedText,
} from "./failure-words.js";
type Operation = ReturnType<ReturnType<typeof createDiningSessionClient>["prepareStart"]>;
type AvailabilityOperation = ReturnType<
  ReturnType<typeof createDiningSessionClient>["prepareAvailability"]
>;
/** WP-2423 Q8: staff pick a plain reason; the stored reason stays a stable code. */
const tableBlockReasons = [
  ["CLEANING", t("Being cleaned")],
  ["RESERVED", t("Reserved")],
  ["OUT_OF_SERVICE", t("Out of service")],
  ["AREA_CLOSED", t("Section closed")],
] as const;
/**
 * The facts the Tables list says a table's need from: the order queue's for its Order; for a table
 * checking out that the queue did not bring, its own bill's (v15 batch 8). v15 batch 11: when the
 * table's own bill was read after the queue (a queue read that fails keeps its last answer), what
 * the table paid is the bill's: a guest who paid on the phone is never left on the queue's older
 * "Waiting for payment". What the kitchen still has stays the queue's.
 */
export function listFactsOf(
  table: StaffDiningTable,
  orderFacts: ReadonlyMap<string, TableOrderFacts>,
  billFacts: ReadonlyMap<string, { readonly facts: TableOrderFacts; readonly read: number }>,
  /** The number of the order queue read `orderFacts` came from (0: none yet). */
  queueRead = 0,
  /**
   * b13: what a table checking out has at the pass and in the kitchen, from its own serving
   * progress; it stands over the queue's and the bill's (the bill knows nothing of the kitchen).
   */
  kitchenFacts: ReadonlyMap<
    string,
    Pick<TableOrderFacts, "readyToServe" | "inKitchen" | "allServed">
  > = new Map(),
): TableOrderFacts | null {
  const order = table.session?.orderReference;
  if (!order) return null;
  const queued = orderFacts.get(order) ?? null;
  if (table.session?.phase !== "Closing") return queued;
  const own = billFacts.get(order);
  const said =
    own === undefined
      ? queued
      : queued === null
        ? own.facts
        : // b13: an Order read from its serving progress alone has no bill of the queue's: the
          // table's own bill says it.
          own.read > queueRead || queued.bill === null
          ? { ...queued, bill: own.facts.bill }
          : queued;
  const kitchen = kitchenFacts.get(order);
  if (kitchen === undefined) return said;
  // Dishes waiting at the pass are said even before the bill is read.
  if (said === null) return kitchen.readyToServe > 0 ? { bill: null, ...kitchen } : null;
  return { ...said, ...kitchen };
}
export { elapsedText };
export { longOpenSessionMinutes };
/** What staff see on the floor: free, blocked, seated, or seated so long the guests have likely left. */
export type TableFloorState = "Available" | "Unavailable" | "NeedsCleaning" | "Seated" | "LongOpen";
/**
 * WP-2423 follow-up: the table's real floor state. Its operational state only says whether the
 * table is blocked, so a table with an open session is "Seated", never "Available".
 */
/**
 * Batch 46: after another device closed or changed a table first, when (ms after each previous read)
 * the tables are read again until its visit has left the table: about 6 s in all, then it stops.
 */
export const changedElsewhereRereadsMs = [300, 700, 1500, 3500] as const;

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
  const at = storeTime(first.payBy, timeZone, false, "Guest");
  if (remainingMs <= 0)
    return {
      tier: "urgent",
      // v15 2026-11-12: whole sentences per count ("9 rounds ... weren't paid", never "wasn't").
      text:
        count === 1
          ? t(
              "{rounds} entered by staff wasn't paid by {at} and is being cancelled; it won't go to the kitchen. If the card machine was charged, refund it on the machine.",
              { rounds: rounds, at: at },
            )
          : t(
              "{count} rounds entered by staff weren't paid by {at} and are being cancelled; they won't go to the kitchen. If the card machine was charged, refund it on the machine.",
              { count: String(count), at },
            ),
    };
  const minutes = Math.max(1, Math.ceil(remainingMs / 60_000));
  return minutes <= staffRoundUrgentMinutes
    ? {
        tier: "urgent",
        // v15 batch 8: whole sentences per count, so no English word sits in the Chinese.
        text:
          count === 1
            ? t(
                "{minutes} min left: record the card-machine payment for the round entered by staff by {at}, or it is cancelled.",
                { minutes: String(minutes), at },
              )
            : t(
                "{minutes} min left: record the card-machine payment for the rounds entered by staff by {at}, or they are cancelled.",
                { minutes: String(minutes), at },
              ),
      }
    : {
        tier: "warning",
        text:
          count === 1
            ? t(
                "A round entered by staff is waiting for its card-machine payment. Record it by {at}; the kitchen starts once it is recorded.",
                { at },
              )
            : t(
                "{rounds} entered by staff are waiting for their card-machine payment. Record them by {at}; the kitchen starts once they are recorded.",
                { rounds, at },
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
      : t("Rounds {value}", {
          value: rounds.map((round) => String(round.roundNumber)).join(listSeparator()),
        });
  const remainingMs = Date.parse(first.payBy) - now;
  const at = storeTime(first.payBy, timeZone, false, "Guest");
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
              ? t("Round {roundNumber}", { roundNumber: String(firstUnconfirmed.roundNumber) })
              : t("Rounds {value}", {
                  value: unconfirmed
                    .map((round) => String(round.roundNumber))
                    .join(listSeparator()),
                }),
          payBy: storeTime(firstUnconfirmed.payBy, timeZone, false, "Guest"),
        },
      ),
    };
  if (remainingMs <= 0)
    return {
      tier: "urgent",
      text:
        rounds.length === 1
          ? t(
              "{names} wasn't paid by {at} and is being cancelled; it won't go to the kitchen and nobody is charged.",
              { names: names, at: at },
            )
          : t(
              "{names} weren't paid by {at} and are being cancelled; they won't go to the kitchen and nobody is charged.",
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
          "{names} {verb} paid yet. The guest pays on their phone (their table page has a pay button); unpaid at {at}, it is cancelled and nobody is charged. If their phone can't start the payment, cancel this round, take the order for the table and charge it on the card machine.",
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
 * A newly issued table join code with what to do with it. Hiding the code hides the instruction
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
        {t("Join code:")}
        {wordGap()}
        <strong>{code}</strong>
      </p>
      <button onClick={onHide}>{t("Hide join code")}</button>
    </div>
  );
}

/** WP-2423 item 8 ①: a result said in words, with "Undo" where the step can be taken back. */
interface TableResult {
  readonly text: string;
  readonly undo?: (() => void) | undefined;
  /**
   * Batch 47/48 (v15 b46, b47 live): the table the outcome is about. While that table is selected
   * the outcome is said in its panel, where staff are looking, at every width: on a long floor the
   * line above the list is out of view once staff have scrolled down to the table's row.
   */
  readonly table?: string | undefined;
  /**
   * Batch 48: the step was taken on the table's row in the list. Below the desktop width the panel
   * sits under the whole list, so its outcome stays above the list, as before, instead of pulling
   * staff away from the row they are working on.
   */
  readonly fromRow?: boolean | undefined;
  /**
   * Batch 49 (v15 b48 live): the table is checking out, so no one new can join. Said here, the
   * panel does not say it again further down.
   */
  readonly checkingOut?: true | undefined;
  /**
   * Batch 49 review: the tables read the refusal came after (the list may not show the checkout
   * yet). Only a newer read can show that the table is no longer checking out.
   */
  readonly checkingOutSince?: string | null | undefined;
}

/** Below the desktop width the selected table's panel sits under (or over) the list. */
const panelUnderList = "(max-width: 1023px)";
function usePanelUnderList() {
  const query = () =>
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia(panelUnderList).matches;
  const [under, setUnder] = useState(query);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const media = window.matchMedia(panelUnderList);
    const changed = () => setUnder(media.matches);
    changed();
    media.addEventListener?.("change", changed);
    return () => media.removeEventListener?.("change", changed);
  }, []);
  return under;
}

/**
 * WP-2423 item 8 ① (Owner decision 2, Figma 44-2 approved 2026-10-27): the Tables page is the
 * server's main screen. Tables are listed by what they need, most urgent first, each with its one
 * next step (answer a call, serve what is ready, take the payment, mark it cleaned); free tables are
 * opened in one tap. The selected table's panel serves dishes, starts checkout, takes the payment
 * and closes the table. Everyday steps (serve, open, clean, close) are not confirmed: they say what
 * happened, and cleaning can be undone. Only money and cancelling are confirmed.
 */
/** No answer, or a server failure (a lost COMMIT looks the same): the same request goes again. */
function tableActionOutcomeUnknown(error: unknown): boolean {
  return (
    error instanceof DiningSessionClientError &&
    (error.code === "Unknown" || error.code === "ServerProblem")
  );
}
/**
 * WP-2423 item 10: what a table action that did not go through says. A refused one is the only one
 * that may mention access; the screen has read the table again first, so it is not a stale screen.
 */
function tableActionFailureText(error: unknown): string {
  const code = error instanceof DiningSessionClientError ? error.code : "Unavailable";
  switch (code) {
    case "Unknown":
      return t("The result is unknown. Press it again: the same request is sent, never twice.");
    case "ServerProblem":
      return notConfirmedPressAgainText + wordGap() + serverSideProblemText;
    case "Changed":
      return tableChangedText;
    case "TableCheckingOut":
      return tableCheckingOutText();
    case "NewGuestsPaused":
      return t(
        "New guests are paused for this restaurant by the platform, so no new table can be opened. Tables already seated carry on as usual: serve, take payment and refund. Ask the owner about it.",
      );
    case "Denied":
      return t("Your access doesn't allow this table action. Ask a manager.");
    default:
      return t("This didn't go through. The table has been read again: try again.");
  }
}

/**
 * Batch 48 (v15 b47 live): no one new joins a table paying its bill (dining-qr-join.md). Batch 50
 * (v15 b49 live): nor is the party moved or merged then (the move and merge refuse a table that is
 * not Active), so the one statement says that too, instead of steps that fail on submit.
 */
const tableCheckingOutText = () =>
  t(
    "This table is paying the bill, so it can't be moved or merged, no one new can join and no new join code can be made.",
  );
/** Batch 49 (v15 b48 live): the same, once the bill is paid (or nothing was owed). */
const tableSettledText = () =>
  t(
    "This table's bill is settled, so it can't be moved or merged, no one new can join and no new join code can be made.",
  );

/**
 * Batch 51 (v15 b50 live): the table staff had open when this screen's sign-in ended, kept in this
 * tab for a few minutes, so signing in again (Check again or Sign in again reopens the page) comes
 * back to it with its bill read at once, instead of an empty panel. A per-tab convenience only:
 * nothing breaks without storage, and nothing of the bill is kept.
 */
const REOPEN_TABLE_KEY = "bop.tables.openWhenSignedOut.v1";
const REOPEN_TABLE_MAX_AGE_MS = 15 * 60_000;
interface ReopenTable {
  readonly table: string;
  readonly label: string;
  readonly store: string;
  readonly storeLabel: string;
}
function keepTableForSignIn(open: ReopenTable | null) {
  try {
    if (open === null) globalThis.sessionStorage?.removeItem(REOPEN_TABLE_KEY);
    else
      globalThis.sessionStorage?.setItem(
        REOPEN_TABLE_KEY,
        JSON.stringify({ ...open, at: Date.now() }),
      );
  } catch {
    /* Storage blocked: the page opens with no table chosen, as before. */
  }
}
// Taken from storage once per page load: the workspace may mount more than once while the page
// opens, and the table is chosen again by the first read that succeeds.
let reopenTaken: ReopenTable | null | undefined;
function takeTableForSignIn(): ReopenTable | null {
  if (reopenTaken === undefined) reopenTaken = readTableForSignIn();
  return reopenTaken;
}
function readTableForSignIn(now = Date.now()): ReopenTable | null {
  try {
    const raw = globalThis.sessionStorage?.getItem(REOPEN_TABLE_KEY) ?? null;
    if (raw === null) return null;
    globalThis.sessionStorage?.removeItem(REOPEN_TABLE_KEY);
    const value = JSON.parse(raw) as Partial<Record<keyof ReopenTable | "at", unknown>> | null;
    return typeof value?.table === "string" &&
      typeof value.label === "string" &&
      typeof value.store === "string" &&
      typeof value.storeLabel === "string" &&
      typeof value.at === "number" &&
      now - value.at >= 0 &&
      now - value.at <= REOPEN_TABLE_MAX_AGE_MS
      ? { table: value.table, label: value.label, store: value.store, storeLabel: value.storeLabel }
      : null;
  } catch {
    return null;
  }
}

/** M159: set when the Store has no tables at all (the empty floor says what to do next). */
const noTablesMessage = "no-tables";
/** Batch 38: the floor read was refused; worded at render, by who is signed in. */
const tablesDeniedMessage = "tables-denied";

/**
 * b40 review: Tables writes every time in the guests' house style ("12:30 a.m."), the notices,
 * the rounds, the checkout and the shared order lines alike, so one screen never mixes styles.
 */
export function DiningSessionWorkspace(props: Parameters<typeof DiningSessionWorkspaceBody>[0]) {
  return (
    <ClockStyleContext.Provider value="Guest">
      <DiningSessionWorkspaceBody {...props} />
    </ClockStyleContext.Provider>
  );
}

function DiningSessionWorkspaceBody({
  csrf,
  storeReference,
  storeLabel,
  timeZone,
  canTakeOrders = false,
  tableQrHref,
}: {
  readonly csrf: string;
  /** The selected Store: the bills this device keeps are said only for the Store they came from. */
  readonly storeReference: string;
  readonly storeLabel: string;
  /** The Store's IANA time zone, for the times staff are told (WP-2423 item 5). */
  readonly timeZone?: string | undefined;
  /**
   * WP-2423 Q7 slice 2: the staff member may enter a round for a table (staff ordering) — the
   * fallback when the Tables read doesn't say (an older server); M08: the read decides otherwise.
   */
  readonly canTakeOrders?: boolean;
  /** The Table QR codes page, when this staff member may create codes there. */
  readonly tableQrHref?: string | undefined;
}) {
  const staffNavigation = useContext(StaffNavigationContext);
  const kitchenOnly = staffNavigation !== null && kitchenOnlyNavigation(staffNavigation);
  const [tables, setTables] = useState<StaffDiningTable[]>([]),
    [selectedReference, setSelectedReference] = useState<string | null>(null),
    [code, setCode] = useState<{ table: string; value: string } | null>(null),
    [message, setMessage] = useState(""),
    [result, setResult] = useState<TableResult | null>(null),
    [state, setState] = useState<"Idle" | "Loading" | "Submitting" | "Unknown">("Idle");
  const [orderFacts, setOrderFacts] = useState<ReadonlyMap<string, TableOrderFacts>>(new Map());
  const orderFactsNow = useRef(orderFacts);
  orderFactsNow.current = orderFacts;
  const [tab, setTab] = useState<TableTab>("Needs");
  const detailRef = useRef<HTMLElement | null>(null);
  // Batch 58: a link from order entry ("Open table T7 on Tables") opens that table's panel once.
  const location = useLocation();
  const navigate = useNavigate();
  const linkedTable = useRef(readTablesOpenTable(location.state));
  // Batch 59 (v15 b58 live): at 390 the linked table's panel opened 7880 px down a 156-table list
  // with the page left at the top and focus on BODY. The scroll ran in a frame queued with the
  // first read's state, which on a slow phone came before React drew the list, so it scrolled a
  // short page. Arriving from the link now waits until the table's panel is drawn, then does what
  // Select does (panel under the list: to the top) and moves focus to the panel's heading.
  const [arrival, setArrival] = useState<string | null>(null);
  const panelResultRef = useRef<HTMLParagraphElement | null>(null);
  const underList = usePanelUnderList();
  // Said in the panel: brought into view if the panel has moved (it shrinks when a table closes).
  useEffect(() => {
    panelResultRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [result]);
  const pending = useRef<AbortController | null>(null),
    operation = useRef<{ table: string; prepared: Operation } | null>(null),
    availabilityOperations = useRef(new Map<string, AvailabilityOperation>()),
    serveOperations = useRef(new Map<string, ReturnType<typeof prepareServeAllReady>>());
  const [canCloseSessions, setCanCloseSessions] = useState(false);
  const [canTransferHost, setCanTransferHost] = useState(false);
  const [canCancelUnpaidRounds, setCanCancelUnpaidRounds] = useState(false);
  const [canWriteOff, setCanWriteOff] = useState(false);
  // WP-2423 M08: from the Tables read, never from the "Counter order" sidebar entry.
  const [canTakeTableRounds, setCanTakeTableRounds] = useState<boolean | null>(null);
  // DEC-DINING-GUEST-TABLE-START: guests can start free tables here, and whether this person stops it.
  const [guestStarts, setGuestStarts] = useState<{
    readonly version: number;
    readonly canTurnOff: boolean;
    readonly startsBusy: boolean;
  } | null>(null);
  const guestStartsNow = useRef<typeof guestStarts>(null);
  // WP-2423 (M171): the Brand's allergen list, for marking what a table must avoid.
  const [allergenChoices, setAllergenChoices] = useState<readonly StaffTableAllergenChoice[]>([]);
  const [canOperateTables, setCanOperateTables] = useState(false),
    [blockReasonCode, setBlockReasonCode] = useState(""),
    [checkoutRevision, setCheckoutRevision] = useState(0),
    [unknownAction, setUnknownAction] = useState<"Session" | "Availability" | null>(null);
  const [hostLocked, setHostLocked] = useState(false);
  // IDR-0039: a failed refresh keeps the last loaded tables on screen, read-only, and retries.
  const [stale, setStale] = useState<StaleRead | null>(null);
  // WP-2423 item 10: the server answered 5xx before any table was shown: consecutive failures.
  const [firstReadFailures, setFirstReadFailures] = useState<number | null>(null);
  const loadedAt = useRef<string | null>(null);
  const paused = stale !== null;
  const locked = state !== "Idle" || hostLocked;
  const [now, setNow] = useState(() => Date.now());
  const businessDay = useStoreBusinessDay();
  const selected = tables.find((table) => table.tableReference === selectedReference) ?? null;
  useEffect(() => {
    if (arrival === null) return;
    if (selected?.tableReference !== arrival) {
      // Chosen otherwise before the panel was drawn (a tap, a sign-in): nothing to bring in.
      if (selectedReference !== arrival) setArrival(null);
      return;
    }
    const heading = detailRef.current?.querySelector<HTMLElement>(".table-panel__head h2");
    if (heading === null || heading === undefined) return;
    setArrival(null);
    // Instant, as Select is, so it never animates for staff who turned motion off.
    if (typeof window.matchMedia === "function" && window.matchMedia(panelUnderList).matches)
      detailRef.current?.scrollIntoView?.({ block: "start" });
    else heading.scrollIntoView?.({ block: "nearest" });
    heading.focus({ preventScroll: true });
  }, [arrival, selected, selectedReference]);
  // Batch 51: before the effects below clear it, take the table open when the sign-in ended.
  takeTableForSignIn();
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
      setResult({
        text: t("Table {table}: marked as handled.", { table: saidTable(table.stableLabel) }),
        table: table.tableReference,
        fromRow: true,
      });
    } catch (error) {
      setResult({
        text: isServerProblem(error)
          ? t("Table {table}: not confirmed. Press it again: it is never recorded twice.", {
              table: saidTable(table.stableLabel),
            })
          : t("Table {table}: not confirmed. Check the connection and try again.", {
              table: saidTable(table.stableLabel),
            }),
        table: table.tableReference,
        fromRow: true,
      });
    } finally {
      setAnswering(null);
    }
  };
  /** The open tables' dishes and bills, from the order queue (kept on a failed read). */
  // Owner 2026-11-03 (operating continuity): each open table's bill stays on this device, so staff
  // can still see what a table owes when the connection drops. Read again only when it changed.
  const lastBills = useRef(new Map<string, ListBill>());
  // b13: the bills this device kept from its last reads (by table), said while they are read again,
  // only from this Store (a manager who switched Store never sees the other Store's table "1").
  const deviceBills = useMemo(() => {
    const saved = loadLastBills(Date.now(), storeReference);
    return {
      savedAt: saved === null ? 0 : Date.parse(saved.savedAt),
      byLabel: new Map((saved?.tables ?? []).map((bill) => [bill.label, bill] as const)),
    };
  }, [storeReference]);
  /** Only a bill saved while this party sat at the table (never a party before it). */
  const deviceBillOf = (table: StaffDiningTable) =>
    table.elapsedMinutes !== null &&
    deviceBills.savedAt >= Date.now() - table.elapsedMinutes * 60_000
      ? (deviceBills.byLabel.get(table.stableLabel) ?? null)
      : null;
  const billsInFlight = useRef(new Set<string>());
  // v15 b12: tables whose own bill read failed (by Dining Session), and their Orders as shown.
  const billsFailed = useRef(new Set<string>());
  const [billUnread, setBillUnread] = useState<ReadonlySet<string>>(new Set());
  const billItems = useRef<{ poll: number; items: readonly StaffDiningTable[] }>({
    poll: 0,
    items: [],
  });
  // v15 batch 8: a table checking out that the queue read did not bring is said from its own
  // bill (the panel's), never "Checking the bill" once that bill is read. By Order.
  const [billFacts, setBillFacts] = useState<
    ReadonlyMap<string, { readonly facts: TableOrderFacts; readonly read: number }>
  >(new Map());
  // v15 batch 11: every list read (queue or bill) is numbered when it starts; the newer one wins.
  const reads = useRef(0);
  const nextRead = () => (reads.current += 1);
  const [queueRead, setQueueRead] = useState(0);
  // b13: the tables checking out, from their own serving progress (by Order; the newest read wins).
  const [kitchenFacts, setKitchenFacts] = useState<
    ReadonlyMap<string, Pick<TableOrderFacts, "readyToServe" | "inKitchen" | "allServed">>
  >(new Map());
  const kitchenReadNow = useRef(0);
  // When each table checking out was last read on its own, and what it said (by Order).
  const kitchenOwn = useRef(
    new Map<
      string,
      {
        readonly at: number;
        readonly facts: Pick<TableOrderFacts, "readyToServe" | "inKitchen" | "allServed">;
      }
    >(),
  );
  const queueReadNow = useRef(0);
  // Bill reads stop when this page is left or the sign-in ends.
  const billReads = useRef(new AbortController());
  const polls = useRef(0);
  const keepLastBills = (
    items: readonly StaffDiningTable[],
    facts: ReadonlyMap<string, TableOrderFacts>,
    /** This list read's number: a table checking out is read once in each. */
    poll: number,
    /** Only these tables are read now; the others keep what was read before. */
    only: (table: StaffDiningTable) => boolean,
  ) => {
    const client = createTableCheckoutClient();
    // The newest list read's tables are the ones said: an older read still answering never puts
    // back an older table list (a table seated since then keeps its bill).
    if (poll >= billItems.current.poll) billItems.current = { poll, items };
    const shown = () => {
      setBillFacts(listBillsByOrder(billItems.current.items, lastBills.current));
      setBillUnread(unreadBillOrders(billItems.current.items, billsFailed.current));
      saveLastBills(
        [...lastBills.current.values()].map((entry) => entry.bill),
        new Date(),
        { storeReference, storeLabel },
      );
    };
    return readListBills({
      items,
      queued: facts,
      poll,
      only,
      kept: lastBills.current,
      inFlight: billsInFlight.current,
      failed: billsFailed.current,
      read: (session, signal) => client.bill(csrf, session, signal),
      nextRead,
      signal: billReads.current.signal,
      shown,
    }).then(shown);
  };
  const loadFacts = async (items: readonly StaffDiningTable[], signal: AbortSignal) => {
    const orders = items.flatMap((table) =>
      table.session?.orderReference ? [table.session.orderReference] : [],
    );
    // v15 batch 8: the tables' own bills are read beside the queue (a slow queue read under load
    // left tables paid in full on "Checking the bill"), then again for what the queue changed.
    polls.current += 1;
    const poll = polls.current;
    const closing = (table: StaffDiningTable) => table.session?.phase === "Closing";
    const bills = keepLastBills(items, orderFactsNow.current, poll, closing);
    // b13: a table checking out is read from its own serving progress too, beside the queue and
    // whether or not the queue answers, so dishes at the pass offer Serve all on its row.
    const kitchenRead = nextRead();
    const checkingOut = items.flatMap((table) =>
      closing(table) && table.session?.orderReference ? [table.session.orderReference] : [],
    );
    // A table whose dishes were all served (by its own read and the queue) is read less often.
    const readAt = Date.now();
    const due = kitchenReadsDue(checkingOut, kitchenOwn.current, orderFactsNow.current, readAt);
    void loadTableKitchenFacts(due, csrf, signal).then((found) => {
      for (const [order, facts] of found) kitchenOwn.current.set(order, { at: readAt, facts });
      for (const order of kitchenOwn.current.keys())
        if (!checkingOut.includes(order)) kitchenOwn.current.delete(order);
      if (signal.aborted || kitchenRead < kitchenReadNow.current) return;
      kitchenReadNow.current = kitchenRead;
      // A table whose own read failed now keeps what was read before (merged, never replaced).
      setKitchenFacts((current) => mergeKitchenFacts(current, found, checkingOut));
    });
    const read = nextRead();
    try {
      const facts = await loadTableOrderFacts(orders, signal, undefined, {
        csrf,
        except: new Set(checkingOut),
      });
      // A queue read that started before the one already shown is not shown over it.
      if (!signal.aborted && read > queueReadNow.current) {
        queueReadNow.current = read;
        setOrderFacts(facts);
        setQueueRead(read);
      }
      await bills;
      if (!signal.aborted) void keepLastBills(items, facts, poll, (table) => !closing(table));
    } catch {
      /* The list still shows each table's own state; the dishes are read again with it. */
    }
  };
  /**
   * `background`: an automatic re-read; the selected table and any shown join code stay.
   * v15 b12 (tables-list-paging): every table of the Store is read each time, page after page, so
   * "Needs action" and every count cover the whole floor, never only the first tables listed.
   */
  const load = async (background = false): Promise<readonly StaffDiningTable[] | undefined> => {
    if ((pending.current && !pending.current.signal.aborted) || state === "Unknown" || hostLocked)
      return undefined;
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
      const loaded = await readAllTables(createDiningSessionClient(), csrf, controller.signal);
      if (!controller.signal.aborted) {
        loadedAt.current = new Date().toISOString();
        setStale(null);
        setFirstReadFailures(null);
        setMessage((shown) => (shown === floorServerProblemText ? "" : shown));
        const items = loaded.items;
        setTables(items);
        setCanOperateTables(loaded.canOperateTables);
        setAllergenChoices(loaded.allergenChoices);
        setCanCloseSessions(loaded.canCloseSessions);
        setCanTransferHost(loaded.canTransferHost);
        setCanCancelUnpaidRounds(loaded.canCancelUnpaidRounds);
        setCanWriteOff(loaded.canWriteOff);
        setCanTakeTableRounds(loaded.canTakeTableRounds);
        setGuestStarts(loaded.guestTableStart);
        guestStartsNow.current = loaded.guestTableStart;
        if (loaded.items.length === 0) setMessage(noTablesMessage);
        // Batch 51: the table open before the sign-in ended, chosen again after the first read.
        const reopen = takeTableForSignIn();
        const linked = linkedTable.current;
        if (linked !== null) {
          linkedTable.current = null;
          // Opened once: a reload or Back later finds the page as staff leave it.
          void navigate(".", { replace: true, state: null });
          if (reopen === null && items.some((table) => table.tableReference === linked)) {
            setSelectedReference(linked);
            // Batch 59 (v15 b58 live): brought into view once the list and the panel are drawn.
            setArrival(linked);
          }
        }
        if (reopen !== null) {
          reopenTaken = null;
          // Batch 51 (v15 b50 live): signed in again, the table staff had open is open again
          // (its panel reads the bill at once); one this sign-in doesn't see is said plainly.
          if (reopen.store !== storeReference)
            setResult({
              text: t(
                "You're signed in at {store} now, so table {table} at {previous} isn't shown here.",
                {
                  store: storeLabel,
                  table: saidTable(reopen.label),
                  previous: reopen.storeLabel,
                },
              ),
            });
          else if (items.some((table) => table.tableReference === reopen.table))
            setSelectedReference(reopen.table);
          else
            setResult({
              text: t(
                "Table {table} isn't on the floor for this sign-in (it was removed, or this sign-in can't see it). Choose a table from the list.",
                { table: saidTable(reopen.label) },
              ),
            });
        }
        void loadFacts(items, controller.signal);
        return items;
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        const denied = error instanceof DiningSessionClientError && error.code === "Denied";
        const server = isServerProblem(error);
        const lastLoadedAt = loadedAt.current;
        if (!denied && lastLoadedAt !== null && tables.length > 0) {
          setStale((prior) => ({
            reason: server ? "ServerProblem" : "Unavailable",
            lastLoadedAt,
            attempts: (prior?.attempts ?? 0) + 1,
          }));
        } else {
          loadedAt.current = null;
          setStale(null);
          setTables([]);
          setCanOperateTables(false);
          setFirstReadFailures((prior) => (server ? (prior ?? 0) + 1 : null));
          setMessage(
            denied
              ? tablesDeniedMessage
              : server
                ? floorServerProblemText
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
    return undefined;
  };
  const loadRef = useRef(load);
  loadRef.current = load;
  const reread = () => void loadRef.current(true);
  // Batch 46 (v15 b45 live): two devices pressed Close on one table. The loser's refusal came back
  // 7-66 ms before the winner's close committed, so its one re-read still showed the table open
  // (with an active Close) for as long as staff looked. The tables are read again a few times,
  // further apart, until this visit has left the table; then it says the other device closed it.
  const settling = useRef<AbortController | null>(null);
  useEffect(() => () => settling.current?.abort(), []);
  const settleChangedElsewhere = (table: StaffDiningTable, frees: boolean) => {
    settling.current?.abort();
    const controller = new AbortController();
    settling.current = controller;
    const visit = table.currentDiningSessionReference;
    void (async () => {
      for (const wait of changedElsewhereRereadsMs) {
        await new Promise((resolve) => setTimeout(resolve, wait));
        if (controller.signal.aborted) return;
        const items = await loadRef.current(true);
        if (controller.signal.aborted) return;
        const now = items?.find((entry) => entry.tableReference === table.tableReference);
        if (now === undefined) continue;
        if (now.currentDiningSessionReference !== visit) {
          setResult({
            text: frees
              ? t("Table {table} was closed on another device and is free for the next guest.", {
                  table: saidTable(table.stableLabel),
                })
              : t("Table {table} was closed on another device. Clean it, then mark it cleaned.", {
                  table: saidTable(table.stableLabel),
                }),
            table: table.tableReference,
          });
          return;
        }
      }
    })().finally(() => {
      if (settling.current === controller) settling.current = null;
    });
  };
  useStaleRetry(stale?.attempts ?? firstReadFailures, reread);
  // v15 cbff9d6f: no reads once this screen's sign-in has ended.
  const live = useStaffSessionLive();
  const selectedNow = useRef(selected);
  selectedNow.current = selected;
  useEffect(() => {
    // Batch 51: the table open now is the one to come back to once signed in again.
    const open = selectedNow.current;
    keepTableForSignIn(
      live || open === null
        ? null
        : {
            table: open.tableReference,
            label: open.stableLabel,
            store: storeReference,
            storeLabel,
          },
    );
  }, [live, storeReference, storeLabel]);
  useEffect(() => {
    // Signed out: the bills don't stay on a shared device for the next person, and none is read.
    if (live) return;
    billReads.current.abort();
    billReads.current = new AbortController();
    lastBills.current.clear();
    billsFailed.current.clear();
    clearLastBills();
  }, [live]);
  useEffect(() => {
    if (!anySeated || !live) return;
    setNow(Date.now());
    let ticks = 0;
    const timer = setInterval(() => {
      setNow(Date.now());
      ticks += 1;
      // Every 30 seconds; a failing read goes read-only through the stale retry above.
      if (ticks % 2 === 0 && !paused) void loadRef.current(true);
    }, 15_000);
    return () => clearInterval(timer);
  }, [anySeated, live, paused]);
  // merchant-outage-recovery M174: the frame counts guests waiting for staff every 5 s; when the
  // count moves (a new call, or one answered elsewhere, or both at once) the tables read again, so
  // a new call shows here within seconds instead of at the next 30 s read.
  const staffCallsWaiting = useContext(StaffCallsWaitingContext);
  const seenStaffCalls = useRef<number | null>(null);
  useEffect(() => {
    if (staffCallsWaiting === null) return;
    const previous = seenStaffCalls.current;
    seenStaffCalls.current = staffCallsWaiting;
    if (previous !== null && previous !== staffCallsWaiting && live && !paused) reread();
  });
  // …and back on this tab, the tables read again at once.
  useEffect(() => {
    if (!live || typeof document === "undefined") return;
    const visible = () => {
      if (document.visibilityState === "visible" && !paused) void loadRef.current(true);
    };
    document.addEventListener("visibilitychange", visible);
    return () => document.removeEventListener("visibilitychange", visible);
  }, [live, paused]);
  // IDR-0039: the browser saying the network is gone is enough to go read-only at once.
  useBrowserOffline(() => {
    const lastLoadedAt = loadedAt.current;
    if (lastLoadedAt === null || tables.length === 0) return;
    setStale((prior) => prior ?? { reason: "Offline", lastLoadedAt, attempts: 1 });
  });
  useEffect(() => {
    void loadRef.current();
    return () => {
      billReads.current.abort();
      billReads.current = new AbortController();
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
    if (typeof window.matchMedia === "function" && window.matchMedia(panelUnderList).matches)
      requestAnimationFrame(() => detailRef.current?.scrollIntoView?.({ block: "start" }));
  };
  /** Open a free table (or give a seated one a new join code). Not confirmed: it says the code. */
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
    let readAgain = false;
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
        // Owner decision 1: after opening, guests just scan the table's QR code. A code is only
        // needed while joining by scan is paused, and staff make one then with New join code.
        if (done.joinCredential && !opened)
          setCode({ table: table.tableReference, value: done.joinCredential });
        operation.current = null;
        setUnknownAction(null);
        setState("Idle");
        setResult({
          text: done.joinCredential
            ? opened
              ? t("Table {table} is open. Guests scan the QR code on the table to join.", {
                  table: saidTable(table.stableLabel),
                })
              : t("Table {table} has a new join code; the old one no longer works.", {
                  table: saidTable(table.stableLabel),
                })
            : t(
                "The request already completed. Its code cannot be displayed again. Replace the join code to get a new one.",
              ),
          table: table.tableReference,
        });
        readAgain = true;
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        const unknown = tableActionOutcomeUnknown(error);
        setState(unknown ? "Unknown" : "Idle");
        setUnknownAction(unknown ? "Session" : null);
        if (!unknown) operation.current = null;
        setResult({
          text: tableActionFailureText(error),
          table: table.tableReference,
          ...(error instanceof DiningSessionClientError && error.code === "TableCheckingOut"
            ? { checkingOut: true as const, checkingOutSince: loadedAt.current }
            : {}),
        });
        readAgain = !unknown;
      }
    } finally {
      if (pending.current === controller) pending.current = null;
      // After `pending` is clear, or the read would not run; a stale screen is corrected first.
      if (readAgain) reread();
    }
  };
  /** Mark a table unavailable or available again; cleaning is undone the same way. */
  const setAvailability = async (
    table: StaffDiningTable,
    action: "SetBlock" | "ClearBlock",
    reason: string | null,
    undoable: boolean,
    fromRow = false,
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
    let readAgain = false;
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
                table: saidTable(table.stableLabel),
              })
            : action === "SetBlock"
              ? reason === "CLEANING"
                ? t("Table {table} is back to needing cleaning.", {
                    table: saidTable(table.stableLabel),
                  })
                : t("Table {table} is marked unavailable.", { table: saidTable(table.stableLabel) })
              : t("Table {table} is available.", { table: saidTable(table.stableLabel) }),
          undo:
            undoable && cleaned
              ? () => void setAvailability(updated, "SetBlock", "CLEANING", false, fromRow)
              : undefined,
          table: table.tableReference,
          fromRow,
        });
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        const unknown = tableActionOutcomeUnknown(error);
        setState(unknown ? "Unknown" : "Idle");
        setUnknownAction(unknown ? "Availability" : null);
        if (!unknown) availabilityOperations.current.delete(key);
        setResult({ text: tableActionFailureText(error), table: table.tableReference, fromRow });
        readAgain = !unknown;
      }
    } finally {
      if (pending.current === controller) pending.current = null;
      if (readAgain) reread();
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
            ? t("Table {table}: nothing is ready to serve any more.", {
                table: saidTable(table.stableLabel),
              })
            : t("Table {table}: {summary}", {
                table: saidTable(table.stableLabel),
                summary: serveReadySummary(done),
              }),
        table: table.tableReference,
        fromRow: true,
      });
      setCheckoutRevision((value) => value + 1);
    } catch (error) {
      const lost = error instanceof DiningServeReadyClientError && error.code === "OutcomeUnknown";
      if (!lost) serveOperations.current.delete(order);
      setResult({
        text: lost
          ? t(
              "Table {table}: we could not confirm the dishes were marked served. Press it again: nothing is served twice.",
              { table: saidTable(table.stableLabel) },
            )
          : t("Table {table}: nothing was marked served. Open the table and check its dishes.", {
              table: saidTable(table.stableLabel),
            }),
        table: table.tableReference,
        fromRow: true,
      });
    } finally {
      setServing(null);
      reread();
    }
  };
  const rows = useMemo(
    () =>
      tables
        .map((table) => {
          const facts = listFactsOf(table, orderFacts, billFacts, queueRead, kitchenFacts);
          return {
            table,
            facts,
            need: tableNeed(
              table,
              facts,
              now,
              table.session?.orderReference != null && billUnread.has(table.session.orderReference),
              deviceBillOf(table),
            ),
          };
        })
        .sort(compareTables),
    [tables, orderFacts, billFacts, billUnread, queueRead, kitchenFacts, now],
  );
  // Batch 49 review: a refused step's "paying the bill" line holds only while that is true. Once
  // that table's bill reads settled, or a read newer than the refusal shows the table no longer
  // checking out, the line goes and the panel says what is true now in its usual place.
  const checkoutResultStale = (() => {
    if (result?.checkingOut !== true) return false;
    const row = rows.find((entry) => entry.table.tableReference === result.table);
    const closing = row?.table.session?.phase === "Closing";
    if (closing && tableSettled(row?.facts ?? null)) return true;
    return !closing && loadedAt.current !== result.checkingOutSince;
  })();
  useEffect(() => {
    if (!checkoutResultStale) return;
    const stale = result;
    setResult((current) => (current === stale ? null : current));
  }, [checkoutResultStale, result]);
  const said = checkoutResultStale ? null : result;
  // b39: a table left open from an earlier business day is listed apart, never among today's.
  const readAt = loadedAt.current === null ? now : Date.parse(loadedAt.current);
  const dayStart = businessDay?.startsAt == null ? Number.NaN : Date.parse(businessDay.startsAt);
  const fromEarlierDay = (table: StaffDiningTable) =>
    table.currentDiningSessionReference !== null &&
    openedOnEarlierDay(table.elapsedMinutes, readAt, dayStart);
  const earlierRows = rows.filter((row) => fromEarlierDay(row.table));
  const todayRows = rows.filter((row) => !fromEarlierDay(row.table));
  // b40 (v15 b39 live): every tab counts today's tables only, so "8 seated" never means eight
  // tables left open two weeks ago; those are counted and listed apart, "from earlier days".
  const counts = new Map(
    tableTabs.map((value) => [
      value,
      todayRows.filter((row) => tableInTab(row.table, row.need, value)).length,
    ]),
  );
  const closingAlert = tablesClosingAlert(
    businessDay,
    now,
    todayRows.filter((row) => row.table.currentDiningSessionReference !== null).length,
    timeZone,
  );
  const seatedCount = counts.get("Seated") ?? 0;
  // Batch 40: the server refused this person the Tables read; the page says so and nothing else.
  const refused = message === tablesDeniedMessage && tables.length === 0;
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
            onClick={() => {
              select(table);
              // Owner 2026-11-03 walkthrough: the step goes where the payment is taken.
              window.setTimeout(
                () =>
                  document
                    .querySelector(".table-checkout")
                    ?.scrollIntoView({ block: "start", behavior: "smooth" }),
                400,
              );
            }}
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
            onClick={() => void setAvailability(table, "ClearBlock", null, true, true)}
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
  // DEC-DINING-GUEST-TABLE-START: staff can see that a new phone ended the party before it.
  const endedText = (table: StaffDiningTable) =>
    table.guestStart?.endedLastParty === true ? " · " + t("a new party ended the last visit") : "";
  // Warn before timeouts: on this page, whichever list staff are on.
  const freeingSoon = tablesFreeingSoon(
    rows.map(({ table }) => ({
      table,
      order: table.session?.orderReference
        ? (orderFacts.get(table.session.orderReference) ?? null)
        : null,
    })),
    now,
  );
  const soonest = freeingSoon[0];
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
          <strong>{t("Table {table}", { table: saidTable(table.stableLabel) })}</strong>
          <span className="table-row__meta">
            {table.currentDiningSessionReference === null
              ? t("Seats {capacity}", { capacity: table.capacity })
              : table.elapsedMinutes === null
                ? t("Seats {capacity}", { capacity: table.capacity })
                : t("Seats {capacity} · {open}", {
                    capacity: table.capacity,
                    open: elapsedText(table.elapsedMinutes),
                  }) +
                  guestsText(table) +
                  endedText(table)}
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
  const visible = todayRows.filter((row) => tableInTab(row.table, row.need, tab));
  const seatedOthers = todayRows.filter(
    (row) => row.table.currentDiningSessionReference !== null && row.need.tone !== "action",
  );
  const earlierShown = earlierRows.length > 0 && (tab === "All" || tab === "Seated");
  const earlierGroup =
    earlierRows.length === 0 ? null : (
      <>
        <h2 className="table-list__group">{t("From earlier days")}</h2>
        <p className="table-list__calm">
          {t(
            "These tables were opened on an earlier day and never closed. Open each one: take the payment, or record that the guests left without paying, then close it. Nothing is closed or written off by itself.",
          )}
        </p>
        <ul className="table-rows">{earlierRows.map(tableRow)}</ul>
      </>
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
                {t("Table {table}", { table: saidTable(table.stableLabel) })}
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
                      : t("Open table")}
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
  // Batch 47/48: an outcome about the selected table is said in its panel at every width (the
  // panel is beside the list and stays in view on a wide screen, under it on a phone), except a
  // step taken on the row while the panel sits under the list. Any other outcome is said above
  // the list. Never both.
  const resultInPanel =
    said !== null &&
    said.table !== undefined &&
    !(said.fromRow === true && underList) &&
    selected !== null &&
    said.table === selected.tableReference &&
    !refused;
  const resultLine = (ref?: Ref<HTMLParagraphElement>) =>
    said ? (
      <p ref={ref} className="table-result" role="status">
        {said.text}
        {said.undo ? (
          <button
            type="button"
            className="table-row__text-step"
            disabled={locked || paused}
            onClick={() => {
              const undo = said.undo;
              setResult(null);
              undo?.();
            }}
          >
            {t("Undo")}
          </button>
        ) : null}
      </p>
    ) : null;
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
            {earlierRows.length > 0 ? (
              <span data-attention="true">
                {t("{tables} from earlier days", {
                  tables: countOf(earlierRows.length, "table"),
                })}
              </span>
            ) : null}
            {guestStarts?.startsBusy === true ? (
              <span className="dining-floor-guest-starts-busy" data-attention="true">
                {t(
                  "Many tables started by scanning · new guests are sent to staff for a few minutes",
                )}
              </span>
            ) : null}
            {soonest !== undefined ? (
              <span className="dining-floor-guest-starts-busy" data-attention="true">
                {freeingSoon.length > 1
                  ? t("{count} tables free themselves within 10 min", {
                      count: String(freeingSoon.length),
                    })
                  : soonest.minutes === 0
                    ? t("Table {table} frees itself shortly", {
                        table: saidTable(soonest.table.stableLabel),
                      })
                    : t("Table {table} frees itself in {minutes} min", {
                        table: saidTable(soonest.table.stableLabel),
                        minutes: String(soonest.minutes),
                      })}
              </span>
            ) : null}
            {guestStarts !== null ? (
              <TablesGuestStarts
                starts={guestStarts}
                csrf={csrf}
                locked={locked}
                reread={async () => {
                  // Whatever read is on its way began before this change.
                  pending.current?.abort();
                  await loadRef.current(true);
                  return guestStartsNow.current;
                }}
                onResult={(text) => setResult({ text })}
              />
            ) : null}
          </span>
        ) : null
      }
      actions={
        <button className="tables-v3__quiet" disabled={locked} onClick={() => void load()}>
          {t("Refresh tables")}
        </button>
      }
    >
      {/* DEC-PAID-ORDER-AUTO-ACCEPT: the brake, at a Store sending paid rounds straight through. */}
      {refused ? null : <PaidOrderSwitchLine csrf={csrf} />}
      {/* WP-2423 item 8 ③ follow-up: guests' last orders coming, or passed (staff still can). */}
      {refused ? null : <LastOrdersNotice timeZone={timeZone} />}
      {/* b39: warn before the day ends with tables still open (nothing closes them by itself). */}
      {closingAlert === null || refused ? null : (
        <p className="last-orders-notice" role="status" data-tone={closingAlert.tone}>
          {closingAlert.text}
        </p>
      )}
      {stale ? <StaleReadNotice stale={stale} /> : null}
      {/* Operating continuity: what servers do while the page can't reach the store system. */}
      {stale || firstReadFailures !== null ? (
        <TablesOfflineGuide storeReference={storeReference} />
      ) : null}
      {/* Batch 40: a refused read has no tables to count; zeros would read as "no tables". */}
      {refused ? null : (
        <nav className="table-tabs" aria-label={t("Show tables")}>
          {tableTabs.map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={tab === value}
              onClick={() => setTab(value)}
              onFocus={(event) => keepTabInRow(event.currentTarget)}
            >
              {tabText[value]} <span className="table-tabs__count">{counts.get(value) ?? 0}</span>
            </button>
          ))}
        </nav>
      )}
      {said && !resultInPanel ? resultLine() : null}
      <div className="dining-floor-layout">
        <section className="table-list" aria-label={t("Tables by what they need")}>
          {tables.length === 0 ? (
            <p role="status" className="dining-floor-empty" data-loading={state === "Loading"}>
              {state === "Loading" ? (
                t("Loading tables…")
              ) : message === noTablesMessage ? (
                // M159: an empty floor says what to do next, not only that nothing is here.
                <>
                  {t("No tables yet.")}
                  {wordGap()}
                  {tableQrHref !== undefined ? (
                    <Link to={tableQrHref}>{t("Add your first table")}</Link>
                  ) : (
                    t("Ask the owner to add tables.")
                  )}
                </>
              ) : message === tablesDeniedMessage ? (
                // Batch 38 review: a kitchen display sent here is led back to the kitchen.
                kitchenOnly ? (
                  <>
                    {kitchenOnlyAccessDeniedText}{" "}
                    <Link to="/operations/kitchen">{backToKitchenText}</Link>
                  </>
                ) : (
                  t(
                    "Your role can't use Tables. Ask the owner or a manager to give you access, or sign in as a staff member who has it.",
                  )
                )
              ) : (
                message || t("No tables have been loaded.")
              )}
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
              {earlierGroup}
              {freeLine}
            </>
          ) : tab === "Free" ? (
            (freeLine ?? <p className="table-list__calm">{t("No free tables.")}</p>)
          ) : (
            <>
              {visible.length > 0 ? (
                <ul className="table-rows">{visible.map(tableRow)}</ul>
              ) : earlierShown ? null : (
                <p className="table-list__calm">{t("No tables here.")}</p>
              )}
              {/* b40: All and Seated list earlier days' tables too, apart and under their own count. */}
              {earlierShown ? earlierGroup : null}
            </>
          )}
        </section>
        <aside
          ref={detailRef}
          className="dining-session-detail table-panel"
          aria-label={t("Selected table details")}
          hidden={refused}
        >
          {resultInPanel ? resultLine(panelResultRef) : null}
          {selected ? (
            <TablePanel
              key={selected.tableReference}
              table={selected}
              paidTables={
                new Set(
                  rows
                    .filter((row) => Boolean(row.facts?.bill?.paid))
                    .map((row) => row.table.tableReference),
                )
              }
              csrf={csrf}
              storeLabel={storeLabel}
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
              canTakeOrders={canTakeTableRounds ?? canTakeOrders}
              guestStartsOn={guestStarts !== null}
              tableQrHref={tableQrHref}
              settled={tableSettled(
                rows.find((row) => row.table.tableReference === selected.tableReference)?.facts ??
                  null,
              )}
              checkoutSaid={resultInPanel && said.checkingOut === true}
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
                void loadRef.current(true).then(() => {
                  if (targetReference !== null) setSelectedReference(targetReference);
                  if (text !== "") setResult({ text, table: targetReference ?? undefined });
                });
              }}
              onMoveCheckingOut={() => {
                // Batch 50 (v15 b49 live): as a refused New join code (batch 49), the checkout
                // fact is said once, in the outcome line, and the table is read again.
                setResult({
                  text: tableCheckingOutText(),
                  table: selected.tableReference,
                  checkingOut: true,
                  checkingOutSince: loadedAt.current,
                });
                reread();
              }}
              onMergeCheckingOut={(targetReference) => {
                // Batch 51 (v15 b50 live): a stale Merge refused because one of the tables began
                // checkout elsewhere. The tables are read again at once, and the outcome line,
                // in view, says which one: this table's checkout fact once (as a stale Move), or
                // that the chosen table is paying, which the merge select now says too.
                const source = selected.tableReference;
                const since = loadedAt.current;
                void loadRef.current(true).then((items) => {
                  const own = items?.find((entry) => entry.tableReference === source);
                  const other = items?.find((entry) => entry.tableReference === targetReference);
                  if (own?.session?.phase === "Closing")
                    setResult({
                      text: tableCheckingOutText(),
                      table: source,
                      checkingOut: true,
                      checkingOutSince: since,
                    });
                  else if (other?.session?.phase === "Closing")
                    setResult({
                      text: t(
                        "Table {table} is paying the bill, so this party can't be merged into it.",
                        { table: saidTable(other.stableLabel) },
                      ),
                      table: source,
                    });
                  else
                    setResult({
                      text:
                        items === undefined
                          ? t("One of the tables is checking out. Merge before checking out.")
                          : t(
                              "The tables changed meanwhile. They are read again: check and retry.",
                            ),
                      table: source,
                    });
                });
              }}
              onSettled={(message) => {
                setResult({ text: message, table: selected.tableReference });
                // The table's row says paid right away, not at the next read.
                void loadRef.current(true);
              }}
              onReread={reread}
              onChanged={() => {
                setCheckoutRevision((value) => value + 1);
                reread();
              }}
              onChangedElsewhere={() =>
                settleChangedElsewhere(
                  selected,
                  selected.guestStart != null && guestStarts !== null,
                )
              }
              onClosed={() => {
                const frees = selected.guestStart != null && guestStarts !== null;
                void loadRef.current(true).then(() =>
                  setResult({
                    text: frees
                      ? t("Table {table} is closed and free for the next guest.", {
                          table: saidTable(selected.stableLabel),
                        })
                      : t("Table {table} is closed. Clean it, then mark it cleaned.", {
                          table: saidTable(selected.stableLabel),
                        }),
                    table: selected.tableReference,
                  }),
                );
              }}
            />
          ) : null}
          {selected ? (
            <TableAllergies
              key={`allergies-${selected.tableReference}-${String(selected.currentDiningSessionReference)}-${(selected.tableAllergies ?? []).join(",")}`}
              table={selected}
              choices={allergenChoices}
              csrf={csrf}
              locked={locked || paused}
              onSaved={(codes) => {
                setTables((current) =>
                  current.map((entry) =>
                    entry.tableReference === selected.tableReference
                      ? { ...entry, tableAllergies: codes.length === 0 ? undefined : codes }
                      : entry,
                  ),
                );
                setResult({
                  table: selected.tableReference,
                  text:
                    codes.length === 0
                      ? t("Table {table}: no allergies marked.", {
                          table: saidTable(selected.stableLabel),
                        })
                      : t("Table {table}: kitchen tickets will show {list}.", {
                          table: saidTable(selected.stableLabel),
                          list: codes
                            .map((code) => allergenChoices.find((c) => c.code === code))
                            .filter((c): c is StaffTableAllergenChoice => c !== undefined)
                            .map(tableAllergenText)
                            .join(listSeparator()),
                        }),
                });
              }}
            />
          ) : tables.length === 0 ? null : (
            <div className="dining-session-detail__empty">
              <p>{t("Choose a table to serve it, take its payment or close it.")}</p>
            </div>
          )}
        </aside>
      </div>
      {message && message !== noTablesMessage && tables.length > 0 ? (
        <p role="status" className="dining-floor-message">
          {message}
        </p>
      ) : null}
      {/* WP-2423 item 8 ⑤ decision 5: the Store's "a new phone's first round waits for staff". A
          setting, so it sits below the tables staff work with. */}
      {csrf && !refused ? (
        <details className="table-settings">
          <summary>{t("Table settings")}</summary>
          <RoundHoldSettingControl csrf={csrf} locked={locked} />
          <CheckoutScopeSettingControl csrf={csrf} locked={locked} />
        </details>
      ) : null}
    </WorkspacePage>
  );
}

/** The selected table: its notices, dishes, checkout and close, then the less frequent steps. */
function TablePanel({
  table,
  csrf,
  storeLabel,
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
  guestStartsOn,
  tableQrHref,
  settled,
  checkoutSaid,
  checkoutRevision,
  refreshKey,
  blockReasonCode,
  onBlockReason,
  onHostLocked,
  onStart,
  onAvailability,
  onChanged,
  onClosed,
  onChangedElsewhere,
  onReread,
  onSettled,
  hostTransferDisabled,
  onPartySize,
  tables,
  onMoved,
  onMoveCheckingOut,
  onMergeCheckingOut,
  paidTables,
}: {
  /** b63 (F32): the tables whose bill is paid in full, as their list rows read them. */
  readonly paidTables: ReadonlySet<string>;
  /** DEC-DINING-GUEST-TABLE-START: guests can start free tables at this Store now. */
  readonly guestStartsOn: boolean;
  /** WP-2423 item 8 ⑧: every table on the floor (where the party may move to). */
  readonly tables: readonly StaffDiningTable[];
  /** After a move (target null when only the tables are read again). */
  readonly onMoved: (message: string, targetReference: string | null) => void;
  /** Batch 50: a stale Move was refused because this table checks out now. */
  readonly onMoveCheckingOut: () => void;
  /** Batch 51: a stale Merge was refused because this table or the chosen one checks out now. */
  readonly onMergeCheckingOut: (targetReference: string) => void;
  /** The Order host transfer's own retry stays pressable while it holds the page. */
  readonly hostTransferDisabled: boolean;
  /** v15 2026-10-29: a party size just recorded, for the table list. */
  readonly onPartySize?: (diningSessionReference: string, partySize: number) => void;
  /** Read the tables again, keeping this table's open steps (and their messages) as they are. */
  readonly onReread: () => void;
  readonly onSettled: (message: string) => void;
  readonly table: StaffDiningTable;
  readonly csrf: string;
  /** The Store's name, printed at the top of a paid bill. */
  readonly storeLabel: string;
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
  /** Batch 49: the bill of the table checking out is paid, or nothing is owed. */
  readonly settled: boolean;
  /** Batch 49: the outcome line at the top of the panel already says it is checking out. */
  readonly checkoutSaid: boolean;
  readonly checkoutRevision: number;
  readonly refreshKey: string;
  readonly blockReasonCode: string;
  readonly onBlockReason: (value: string) => void;
  readonly onHostLocked: (locked: boolean) => void;
  readonly onStart: () => void;
  readonly onAvailability: (action: "SetBlock" | "ClearBlock") => void;
  readonly onChanged: () => void;
  readonly onClosed: () => void;
  /** Batch 46: another device closed or changed this table first; read until it settles. */
  readonly onChangedElsewhere: () => void;
}) {
  const seated = table.currentDiningSessionReference !== null;
  const notices = tableAttentionNotices(table, now, timeZone, canCloseSessions);
  const unpaidHint = guestRoundCancelHint(table, now, canCancelUnpaidRounds);
  const eligible = table.lifecycle === "Published" && table.operationalState === "Available";
  const noCode = table.qrCodeValidUntil === null;
  const checkingOut = table.session?.phase === "Closing";
  const hasOrder = Boolean(table.session?.orderReference);
  const roundOffer = staffRoundOffer(table, settled);
  // Batch 49 (v15 b48 live): that no one new can join a table checking out is said once in the
  // panel: in the outcome line when a refused step just said it, else where the phones are, else
  // (no phones block for this role) where New join code was.
  const phonesShown = seated && canOperateTables && table.currentDiningSessionReference !== null;
  const checkoutNote =
    !seated || !checkingOut || checkoutSaid
      ? null
      : settled
        ? tableSettledText()
        : tableCheckingOutText();
  // WP-2423 item 8 ⑤ decision 4: which phone sent each round, from the table's phone list.
  const [roundPhones, setRoundPhones] = useState<ReadonlyMap<string, number | null>>(new Map());
  // The per-head charge is shown in two places on the panel; a change in one reads the other again.
  const [teaRevision, setTeaRevision] = useState(0);
  // b40: with tables merged in, rounds are numbered across the whole bill, as checkout does.
  const billRoundNumbers = useBillRoundNumbers({
    diningSessionReference: table.currentDiningSessionReference,
    merged: (table.session?.mergedTables ?? []).length > 0,
    csrf,
    refreshKey: refreshKey + ":" + String(checkoutRevision),
  });
  return (
    <>
      <header className="table-panel__head">
        {/* Batch 59: focus lands here when a link opens this table (tabIndex -1: never a Tab stop). */}
        <h2 tabIndex={-1}>
          {t("Table {stableLabel}", { stableLabel: saidTable(table.stableLabel) })}
        </h2>
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
            table.guestStart != null ? t("started by a guest") : null,
            table.guestStart?.endedLastParty === true
              ? t("a new party ended the last visit")
              : null,
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
      {table.roundsAwaitingAcceptance.length > 0 && table.session?.orderReference ? (
        // v15 batch 7: straight to the order, where Accept and Can't make it · refund are, on
        // whatever day or page of Orders it was placed.
        <p className="table-panel__notice-action">
          <Link to={`/operations/orders/${table.session.orderReference}`}>
            {t("Open the order to accept it")}
          </Link>
        </p>
      ) : null}
      {canCancelUnpaidRounds && table.guestRoundsAwaitingPayment.length > 0 ? (
        <section aria-label={t("Unpaid rounds")}>
          {unpaidHint ? <p className="table-panel__notice">{unpaidHint}</p> : null}
          {table.guestRoundsAwaitingPayment.map((round) => (
            <UnpaidRoundCancelAction
              key={round.orderBatchReference}
              orderReference={round.orderReference}
              orderBatchReference={round.orderBatchReference}
              roundNumber={round.roundNumber}
              orderLabel={t("table {stableLabel}", { stableLabel: table.stableLabel })}
              csrf={csrf}
              paymentUnconfirmed={isPaymentUnconfirmed(round.payBy, now)}
              onSettled={onChanged}
            />
          ))}
        </section>
      ) : null}
      {code ? <DiningEntryCode code={code} onHide={onHideCode} /> : null}
      {seated && !hasOrder && canOperateTables && table.currentDiningSessionReference !== null ? (
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
      {/* At checkout the waiting rounds are decided in Checkout itself, before the payment. */}
      {seated && !(table.paymentTiming === "PayLater" && table.session?.phase === "Closing") ? (
        <TableHeldRounds
          // b40 review: on a merged table, numbered as on the whole bill (after its rounds).
          rounds={(table.heldRounds ?? []).map((round) => ({
            ...round,
            roundNumber:
              billRoundNumbers instanceof Map
                ? (billRoundNumbers.get(round.orderBatchReference) ?? round.roundNumber)
                : round.roundNumber,
          }))}
          csrf={csrf}
          timeZone={timeZone}
          locked={locked}
          onChanged={onChanged}
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
          billRoundNumbers={billRoundNumbers}
          mergedTableLabels={(table.session.mergedTables ?? []).map(
            (merged) => merged.fromTableLabel,
          )}
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
                aria-label={t("From table {table}", { table: saidTable(merged.fromTableLabel) })}
              >
                <h3>{t("From table {table}", { table: saidTable(merged.fromTableLabel) })}</h3>
                <TableOrderRounds
                  orderReference={merged.orderReference}
                  csrf={csrf}
                  timeZone={timeZone}
                  refreshKey={refreshKey + ":" + String(checkoutRevision)}
                  locked={locked}
                  onChanged={onChanged}
                  roundPhones={roundPhones}
                  billRoundNumbers={billRoundNumbers}
                />
              </section>
            ),
          )
        : null}
      {seated &&
      (table.session?.mergedTables ?? []).length > 0 &&
      table.currentDiningSessionReference !== null ? (
        <TableBillTotal
          diningSessionReference={table.currentDiningSessionReference}
          csrf={csrf}
          refreshKey={refreshKey + ":" + String(checkoutRevision)}
        />
      ) : null}
      {seated &&
      hasOrder &&
      canOperateTables &&
      table.paymentTiming === "PayLater" &&
      table.currentDiningSessionReference !== null ? (
        <TableTeaCheck
          key={"tea:" + table.currentDiningSessionReference}
          diningSessionReference={table.currentDiningSessionReference}
          csrf={csrf}
          locked={locked}
          revision={teaRevision}
          onChanged={() => setTeaRevision((value) => value + 1)}
        />
      ) : null}
      {seated && table.paymentTiming === "PayLater" && table.session ? (
        // DEC-DINE-IN-PAY-LATER: the table pays once at the end, here (servers too, v18).
        <TableCheckout
          key={String(table.currentDiningSessionReference) + ":" + table.session.phase}
          table={table}
          session={table.session}
          csrf={csrf}
          canStart={canCloseSessions}
          canWriteOff={canWriteOff}
          storeLabel={storeLabel}
          timeZone={timeZone}
          locked={locked}
          onChanged={onChanged}
          onSettled={onSettled}
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
          freesStraightAway={table.guestStart != null && guestStartsOn}
          billRoundNumbers={billRoundNumbers}
          onBusy={() => undefined}
          onClosed={onClosed}
          onRefresh={onReread}
          onChangedElsewhere={onChangedElsewhere}
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
                { table: saidTable(table.stableLabel) },
              )}
              {wordGap()}
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
      {canTakeOrders && roundOffer === "Offered" ? (
        // WP-2423 Q7 slice 2: a round for guests who can't or won't order on a phone (or a
        // paper order entered after an outage); it joins the table's order, or opens the table.
        <Link
          className="table-panel__text-step"
          to={`/operations/order-entry?table=${encodeURIComponent(table.tableReference)}`}
        >
          {t("Take order for table {stableLabel}", {
            stableLabel: saidTable(table.stableLabel),
          })}
        </Link>
      ) : canTakeOrders && (roundOffer === "Paid" || roundOffer === "CheckingOut") ? (
        // Batch 55 (v15 b54 live): a table checking out takes no round (the send refuses it);
        // staff read why and what to do instead of a link that fails on Send.
        <p role="note" className="dining-close-who">
          {staffRoundRefusedShortText(roundOffer, table.session?.paymentStarted === true)}
        </p>
      ) : null}
      {/* Owner 2026-11-03 walkthrough: dishes, payment and closing come first; the rest is here. */}
      <details className="table-panel__manage" open={!seated}>
        <summary>{t("Manage this table")}</summary>
        {seated && hasOrder && canOperateTables && table.currentDiningSessionReference !== null ? (
          // WP-2423 item 8 ⑦ (decision 2): how many guests, when the Store asks for it.
          <TablePartySize
            key={"party:" + table.currentDiningSessionReference}
            diningSessionReference={table.currentDiningSessionReference}
            tableLabel={table.stableLabel}
            csrf={csrf}
            locked={locked}
            teaRevision={teaRevision}
            onTeaChanged={() => setTeaRevision((value) => value + 1)}
            onRecorded={(size) => {
              if (table.currentDiningSessionReference !== null)
                onPartySize?.(table.currentDiningSessionReference, size);
            }}
          />
        ) : null}
        {seated &&
        canOperateTables &&
        !checkingOut &&
        table.currentDiningSessionReference !== null ? (
          // WP-2423 item 8 ⑧ (Owner decision 3): move the party to another free table. Batch 50
          // (v15 b49 live): not offered while the table checks out, which the move refuses; the
          // checkout statement says so once. Cancel checkout brings it back.
          <TableMove
            key={"move:" + table.currentDiningSessionReference}
            table={table}
            tables={tables}
            csrf={csrf}
            locked={locked}
            onMoved={onMoved}
            onCheckingOut={onMoveCheckingOut}
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
            onCheckingOut={onMergeCheckingOut}
            paidTables={paidTables}
          />
        ) : null}
        {seated && canOperateTables && table.currentDiningSessionReference !== null ? (
          <TablePanelPhones
            key={table.currentDiningSessionReference}
            diningSessionReference={table.currentDiningSessionReference}
            checkingOut={checkingOut}
            checkoutNote={checkoutNote}
            csrf={csrf}
            timeZone={timeZone}
            now={now}
            locked={locked}
            refreshKey={refreshKey + ":" + String(checkoutRevision)}
            onRounds={setRoundPhones}
          />
        ) : null}
        {seated && canOperateTables && table.currentDiningSessionReference !== null ? (
          <TableCartPanel
            key={"cart:" + table.currentDiningSessionReference}
            diningSessionReference={table.currentDiningSessionReference}
            csrf={csrf}
            locked={locked}
            refreshKey={refreshKey + ":" + String(checkoutRevision)}
            timeZone={timeZone}
            payLater={table.paymentTiming === "PayLater"}
          />
        ) : null}
        <section className="table-panel__more" aria-label={t("More for this table")}>
          {/* Batch 48 (v15 b47 live): a table paying its bill takes no one new, so it is given no
              new join code; the panel says why instead of offering a step that can't work. A code
              whose result was lost is still offered, to settle it. */}
          {seated && checkingOut && !(state === "Unknown" && unknownAction === "Session") ? (
            checkoutNote !== null && !phonesShown ? (
              <p className="table-panel__meta">{checkoutNote}</p>
            ) : null
          ) : seated && !noCode ? (
            <button
              type="button"
              className="table-panel__text-step"
              disabled={busy || (state === "Unknown" && unknownAction !== "Session")}
              onClick={onStart}
            >
              {state === "Unknown" && unknownAction === "Session"
                ? t("Try the new join code again")
                : t("New join code")}
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
      </details>
    </>
  );
}

/**
 * Batch 60: on a phone the tab row scrolls sideways, and the browser leaves a tab that is half in
 * view where it is when Tab reaches it, so the tab and its focus ring are cut off at the row's
 * edge. Scroll the row (only the row, at once) so the focused tab and its ring are whole.
 */
function keepTabInRow(tab: HTMLElement) {
  const row = tab.parentElement;
  if (row === null || row.scrollWidth <= row.clientWidth) return;
  // The ring reaches 6px past the tab (3px + 3px offset); 8px keeps it clear of the edge.
  const room = 8;
  const edge = row.getBoundingClientRect().left + row.clientLeft;
  const box = tab.getBoundingClientRect();
  if (box.left - room < edge) row.scrollLeft -= edge - (box.left - room);
  else if (box.right + room > edge + row.clientWidth)
    row.scrollLeft += box.right + room - (edge + row.clientWidth);
}
