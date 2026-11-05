import { t } from "./i18n/i18n.js";
import { orderMoney } from "./order-money.js";
import { isPaymentUnconfirmed } from "./UnpaidRoundCancelAction.js";
import { longOpenSessionMinutes, type StaffDiningTable } from "./dining-session-client.js";
import type { TableOrderFacts } from "./table-order-facts.js";

/**
 * WP-2423 item 8 ① (Owner decision 2, Figma 44-2): the Tables page lists each table by what it
 * needs from a server, most urgent first. Three meanings, as everywhere in v3: needs a person
 * (red dot), in progress (blue), done (green). Each row has at most one next step.
 */
export type TableNeedTone = "action" | "progress" | "done" | "idle";
export type TableNeedStep = "Handled" | "ServeAll" | "TakePayment" | "Cleaned" | null;
export interface TableNeed {
  readonly tone: TableNeedTone;
  /** Waited long enough to say so in red (a guest calling for 5 minutes or more). */
  readonly urgent?: boolean;
  /** When the need began (oldest first within the same urgency); null when not known. */
  readonly since?: string | null;
  /** Lower comes first in "Needs action". */
  readonly rank: number;
  readonly words: string;
  readonly detail: string | null;
  readonly step: TableNeedStep;
}

/** WP-2423 Q28 DEC-DINING-STAFF-CALL: what the guest asked for, in staff words. */
export function staffCallReasonText(
  reason: "Question" | "TableNeeds" | "OrderProblem" | "ReadyToPay",
): string {
  return reason === "TableNeeds"
    ? t("Something for the table")
    : reason === "OrderProblem"
      ? t("A problem with their order")
      : reason === "ReadyToPay"
        ? t("Ready to pay")
        : t("A question");
}

/** WP-2423 item 8 ⑤: why a guest's round waits for staff, in staff words. */
export function heldRoundReasonText(reason: "FirstOrder" | "PhoneRapid" | "TableRapid"): string {
  return reason === "FirstOrder"
    ? t("first round from a new phone")
    : reason === "PhoneRapid"
      ? t("many rounds from one phone just now")
      : t("many rounds from this table just now");
}

/** DEC-DINING-GUEST-TABLE-START: how long staff have to clean before the next guest may start. */
const cleaningGraceMinutes = 5;
/** The warning before a guest-started table frees itself: a timer they can't act on otherwise. */
const freesItselfWarningMinutes = 10;

/** "frees itself in N min", only in the last minutes before the System closes the table. */
function freesItself(table: StaffDiningTable, now: number): string | null {
  const at = table.guestStart?.closesByItselfAt;
  if (at === null || at === undefined) return null;
  const left = Math.ceil((Date.parse(at) - now) / 60_000);
  if (left > freesItselfWarningMinutes) return null;
  // The System reaches every table within a few minutes of it being due.
  return left <= 0
    ? t("frees itself shortly")
    : t("frees itself in {minutes} min", { minutes: String(left) });
}

const cad = (minor: string) => orderMoney({ amountMinor: minor, currencyCode: "CAD" });
const minutesAgo = (since: string, now: number) =>
  Math.max(0, Math.floor((now - Date.parse(since)) / 60_000));

export function tableNeed(
  table: StaffDiningTable,
  order: TableOrderFacts | null,
  now: number,
): TableNeed {
  const seated = table.currentDiningSessionReference !== null;
  if (!seated) {
    if (table.operationalState === "TemporarilyBlocked" && table.blockReasonCode === "CLEANING")
      return {
        tone: "action",
        rank: 6,
        words: t("Needs cleaning"),
        // Where guests start tables: past this time the next guest may start it anyway.
        detail:
          table.blockedSince != null &&
          now - Date.parse(table.blockedSince) >= cleaningGraceMinutes * 60_000
            ? t("guests can start it now")
            : null,
        step: "Cleaned",
      };
    if (table.operationalState === "TemporarilyBlocked")
      return {
        tone: "idle",
        rank: 99,
        words: t("Temporarily unavailable"),
        detail: null,
        step: null,
      };
    return { tone: "idle", rank: 99, words: t("Free"), detail: null, step: null };
  }
  const call = table.staffCall;
  if (call !== null && call !== undefined) {
    const minutes = minutesAgo(call.calledAt, now);
    return {
      tone: "action",
      rank: 0,
      urgent: minutes >= 5,
      since: call.calledAt,
      words: t("Asked for staff"),
      detail:
        (minutes === 0 ? t("just now") : t("{minutes} min ago", { minutes: String(minutes) })) +
        " · " +
        staffCallReasonText(call.reason),
      step: "Handled",
    };
  }
  // WP-2423 item 8 ⑤ decisions 6–7: a guest's round waits for staff before the kitchen; it is
  // never sent or cancelled on its own, so it stays here until someone decides.
  const held = [...(table.heldRounds ?? [])].sort((a, b) => a.heldAt.localeCompare(b.heldAt))[0];
  if (held !== undefined) {
    const waited = minutesAgo(held.heldAt, now);
    return {
      tone: "action",
      rank: 1,
      urgent: waited >= 5,
      since: held.heldAt,
      words: t("Round waiting for your OK"),
      detail:
        heldRoundReasonText(held.reason) +
        " · " +
        (waited === 0 ? t("just now") : t("{minutes} min ago", { minutes: String(waited) })),
      step: null,
    };
  }
  // Warn before timeouts: the list says how long a paid round has waited, and how long is left
  // before an unpaid round is cancelled on its own (the panel says what to do).
  const oldestPaid = [...table.roundsAwaitingAcceptance].sort((a, b) =>
    a.paidAt.localeCompare(b.paidAt),
  )[0];
  if (oldestPaid !== undefined) {
    const waited = minutesAgo(oldestPaid.paidAt, now);
    return {
      tone: "action",
      rank: 1,
      urgent: waited >= 10,
      since: oldestPaid.paidAt,
      words: t("Paid round to accept"),
      detail: t("paid {minutes} min ago", { minutes: String(waited) }),
      step: null,
    };
  }
  const payBy = [
    ...table.staffRoundsAwaitingPayment.map((round) => round.payBy),
    ...table.guestRoundsAwaitingPayment.map((round) => round.payBy),
  ].sort()[0];
  if (payBy !== undefined) {
    const unconfirmed = table.guestRoundsAwaitingPayment.some((round) =>
      isPaymentUnconfirmed(round.payBy, now),
    );
    const left = Math.ceil((Date.parse(payBy) - now) / 60_000);
    // A guest's own table: an unpaid round cancels itself, and nobody can pay it for them.
    const selfServed = table.guestStart != null && !unconfirmed;
    return {
      tone: selfServed ? "progress" : "action",
      rank: selfServed ? 52 : 1,
      urgent: !selfServed && (unconfirmed || left <= 10),
      since: payBy,
      words: unconfirmed ? t("Payment not confirmed") : t("Round not paid yet"),
      detail: unconfirmed
        ? t("ask the guest")
        : left > 0
          ? t("{minutes} min left", { minutes: String(left) })
          : t("being cancelled"),
      step: null,
    };
  }
  if (order !== null && order.readyToServe > 0)
    return {
      // A guest's own table: the kitchen finishing it is the last step anyone has to take.
      tone: table.guestStart != null ? "progress" : "action",
      rank: table.guestStart != null ? 51 : 2,
      words:
        order.readyToServe === 1
          ? t("1 dish ready to serve")
          : t("{count} dishes ready to serve", { count: String(order.readyToServe) }),
      detail: null,
      step: "ServeAll",
    };
  if (table.session?.phase === "Closing") {
    // Owner 2026-11-03 walkthrough: the bill is not read yet. A paid table never flashes "to pay".
    if (order === null)
      return {
        tone: "progress",
        rank: 55,
        words: t("Checking the bill"),
        detail: null,
        step: null,
      };
    if (order?.bill?.paid)
      return {
        tone: "done",
        rank: 4,
        words: t("Paid · close when the guests leave"),
        detail: cad(order.bill.paid.amountMinor),
        step: null,
      };
    // Points or comps took off the whole bill, or a manager wrote it off.
    if (order?.bill?.totalMinor === "0")
      return {
        tone: "done",
        rank: 4,
        words: t("Nothing to pay · close when the guests leave"),
        detail: null,
        step: null,
      };
    return {
      tone: "action",
      rank: 3,
      words: t("Waiting for payment"),
      // Owner 2026-11-03 walkthrough: part by part, what is still to collect.
      detail: order?.bill?.partlyPaid
        ? t("{amount} to go · {paid} of {count} parts paid", {
            amount: cad(order.bill.partlyPaid.remainingMinor),
            paid: String(order.bill.partlyPaid.paidParts),
            count: String(order.bill.partlyPaid.partCount),
          })
        : order?.bill
          ? cad(order.bill.totalMinor)
          : null,
      step: "TakePayment",
    };
  }
  // Owner 2026-11-03 walkthrough: never over a dish to serve or a table to take payment from. A
  // phone joining is what every normal guest does.
  // WP-2423 item 8 ⑤ decision 3: a phone joined the table in the last 3 minutes.
  const joined = [...(table.newPhones ?? [])].sort((a, b) =>
    b.joinedAt.localeCompare(a.joinedAt),
  )[0];
  if (joined !== undefined)
    return {
      tone: "action",
      rank: 4,
      since: joined.joinedAt,
      words: t("Phone {number} just joined", { number: String(joined.phoneNumber) }),
      detail: t("check it belongs to this table"),
      step: null,
    };
  if (table.elapsedMinutes !== null && table.elapsedMinutes > longOpenSessionMinutes)
    return { tone: "action", rank: 5, words: t("Open a long time"), detail: null, step: null };
  if (order?.inKitchen)
    return {
      tone: "progress",
      rank: 50,
      words: t("Kitchen is making it"),
      detail: null,
      step: null,
    };
  if (order?.allServed)
    return {
      tone: "done",
      rank: 60,
      words: t("Everything served"),
      detail: freesItself(table, now),
      step: null,
    };
  if (table.guestStart != null)
    return {
      tone: "progress",
      rank: 55,
      words: t("Started by a guest"),
      detail:
        table.session?.orderReference === null
          ? [t("no order yet"), freesItself(table, now)].filter(Boolean).join(" · ")
          : freesItself(table, now),
      step: null,
    };
  return { tone: "progress", rank: 55, words: t("Seated"), detail: null, step: null };
}

export type TableTab = "Needs" | "All" | "Seated" | "Free" | "Cleaning";
export const tableTabs: readonly TableTab[] = ["Needs", "All", "Seated", "Free", "Cleaning"];

export function tableInTab(table: StaffDiningTable, need: TableNeed, tab: TableTab): boolean {
  const seated = table.currentDiningSessionReference !== null;
  switch (tab) {
    case "Needs":
      return need.tone === "action";
    case "Seated":
      return seated;
    case "Free":
      return !seated && table.operationalState === "Available";
    case "Cleaning":
      return need.step === "Cleaned";
    default:
      return true;
  }
}

/** Most urgent first; the same urgency by how long the table has been open, then by name. */
export function compareTables(
  a: { readonly table: StaffDiningTable; readonly need: TableNeed },
  b: { readonly table: StaffDiningTable; readonly need: TableNeed },
): number {
  if (a.need.rank !== b.need.rank) return a.need.rank - b.need.rank;
  const since = (a.need.since ?? "").localeCompare(b.need.since ?? "");
  if (a.need.since && b.need.since && since !== 0) return since;
  const open = (b.table.elapsedMinutes ?? -1) - (a.table.elapsedMinutes ?? -1);
  if (open !== 0) return open;
  return a.table.stableLabel.localeCompare(b.table.stableLabel, undefined, { numeric: true });
}
