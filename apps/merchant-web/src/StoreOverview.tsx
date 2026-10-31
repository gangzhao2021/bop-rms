import { systemText, countOf, t } from "./i18n/i18n.js";
import { useApprovalsWaiting, type ApprovalsWaiting } from "./approvals-waiting.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStaffSessionLive } from "./staff-session-reads.js";
import { Link } from "react-router";
import {
  createCurrentOrderQueueClient,
  ordersAwaitingAcceptance,
  roundsAwaitingAcceptance,
  type CurrentOrderQueue,
} from "./current-order-queue-client.js";
import { awaitingAcceptanceText, paidRoundUrgentMinutes } from "./paid-round-wait.js";
import { createOrderExceptionClient } from "./order-exception-client.js";
import {
  isExceptionOverdue,
  parseOrderExceptionView,
  type OrderExceptionView,
} from "./order-exception-view.js";
import { createPickupClient } from "./pickup-client.js";
import { parsePickupQueueView } from "./pickup.js";
import { storeTime } from "./StoreTime.js";
import { ClosingReminder } from "./ClosingReminder.js";
import { OperationsAlerts } from "./OperationsAlerts.js";
import {
  createDiningSessionClient,
  longOpenSessionMinutes,
  type StaffDiningTable,
} from "./dining-session-client.js";
import {
  createSettlementClient,
  SettlementClientError,
  unfinishedGuestPayment,
  type SettlementView,
} from "./settlement-client.js";
import { businessDateText, useStoreBusinessDay } from "./StoreBusinessDay.js";

/** WP-2423 P2: what the Store is dealing with right now, from the pilot projections. */
export interface OrdersSummary {
  readonly open: number;
  readonly awaitingAcceptance: number;
  /** WP-2423: rounds awaiting acceptance (a table may have several) and paid ones waiting long. */
  readonly awaitingRounds: number;
  readonly urgentRounds: number;
  /**
   * Open dine-in orders (tables) with food the kitchen marked ready that nobody served yet, in any
   * round — the Tables page's rule, so a ready round counts even while another round waits for
   * payment. Pickup readiness is a Fulfillment fact (the pickup queue), so pickups are not counted.
   */
  readonly readyToServe: number;
  /** Whether any open order is dine-in; a pickup-only Store has nothing to serve at tables. */
  readonly dineIn: boolean;
  /** The first page was full; there are more open orders than counted here. */
  readonly more: boolean;
  /**
   * WP-2423 (3cd0f8dd M7): dine-in Orders every item of which was served (on this page), so a
   * table still open for one of them is waiting to be closed once the guests leave.
   */
  readonly servedDineIn: ReadonlySet<string>;
}
export interface PickupsSummary {
  /** Waiting pickups of today's business day (all of them while the day is not known). */
  readonly waiting: number;
  /**
   * WP-2423 (3cd0f8dd L7): waiting pickups from an earlier business day — check whether they were
   * collected, then hand them over or close them as not collected on the Pickup page.
   */
  readonly earlierDays: number;
  /** Waiting pickups with a dish the kitchen is remaking; staff wait before handing them over. */
  readonly remaking: number;
  readonly more: boolean;
}
/** WP-2423 (3cd0f8dd M7): the Store's tables as the Tables page reads them (first page). */
export interface TablesRead {
  readonly tables: readonly StaffDiningTable[];
  /** The staff member may close tables (Owner, Store Manager). */
  readonly canClose: boolean;
  readonly more: boolean;
  /** When the tables were read (each table's elapsed minutes count up to this instant). */
  readonly readAt?: string;
}
export interface TablesSummary {
  /** Tables with a party (an open session). */
  readonly open: number;
  /**
   * Open tables to close once the guests have left: everything served and nothing waiting for
   * payment or acceptance, or open so long the guests most likely left. Null for staff who don't
   * close tables (the Tables page tells them who does).
   */
  readonly toClose: number | null;
  /**
   * WP-2423 (46940b76 L1): open tables whose party was seated before the Store's current business
   * day began (left open overnight). Null until the business day and the read time are known.
   */
  readonly earlierDays: number | null;
  readonly more: boolean;
}
export function summarizeTables(
  read: TablesRead,
  servedDineIn: ReadonlySet<string> | null,
  /** Start of the Store's current business day (Store time zone and day start, from the shell). */
  dayStartsAt: string | null = null,
) {
  const open = read.tables.filter((table) => table.currentDiningSessionReference !== null);
  const readAt = read.readAt === undefined ? Number.NaN : Date.parse(read.readAt);
  const dayStart = dayStartsAt === null ? Number.NaN : Date.parse(dayStartsAt);
  const earlierDays =
    Number.isFinite(readAt) && Number.isFinite(dayStart)
      ? open.filter(
          (table) =>
            table.elapsedMinutes !== null && readAt - table.elapsedMinutes * 60_000 < dayStart,
        ).length
      : null;
  const toClose = open.filter(
    (table) =>
      (table.elapsedMinutes ?? 0) > longOpenSessionMinutes ||
      (table.session?.orderReference != null &&
        servedDineIn?.has(table.session.orderReference) === true &&
        table.staffRoundsAwaitingPayment.length === 0 &&
        table.guestRoundsAwaitingPayment.length === 0 &&
        table.roundsAwaitingAcceptance.length === 0),
  ).length;
  return {
    open: open.length,
    toClose: read.canClose ? toClose : null,
    earlierDays,
    more: read.more,
  } satisfies TablesSummary;
}
export interface ExceptionsSummary {
  readonly open: number;
  readonly overdue: number;
}
/** WP-2423 Q1: the home page re-reads its summaries this often. */
export const OVERVIEW_REFRESH_MS = 30_000;
const openPhases = new Set(["Submitted", "Accepted", "InProgress", "Ready"]);
export function summarizeOrders(queue: CurrentOrderQueue, now = Date.now()): OrdersSummary {
  const open = queue.items.filter((order) => openPhases.has(order.currentPhase ?? ""));
  const dineIn = open.filter((order) => order.orderType === "DineIn");
  const rounds = roundsAwaitingAcceptance(queue, now, paidRoundUrgentMinutes);
  return {
    open: open.length,
    awaitingAcceptance: ordersAwaitingAcceptance(queue),
    awaitingRounds: rounds.rounds,
    urgentRounds: rounds.urgentRounds,
    readyToServe: dineIn.filter((order) =>
      // An older server sends no count: then only an Order that is Ready as a whole.
      order.readyToServeItemCount === null
        ? order.currentPhase === "Ready"
        : order.readyToServeItemCount > 0,
    ).length,
    dineIn: dineIn.length > 0,
    more: queue.nextAfterOrderReference !== null,
    servedDineIn: new Set(
      queue.items
        .filter((order) => order.orderType === "DineIn" && order.currentPhase === "Fulfilled")
        .map((order) => order.orderReference),
    ),
  };
}
export function summarizePickups(
  view: {
    readonly items: readonly {
      readonly phase: string;
      readonly remakeQuantity?: number;
      readonly businessDate?: string;
    }[];
    readonly nextAfterFulfillmentReference?: string | null | undefined;
  },
  /** The Store's current business date (Pickup's rule: an earlier date is an earlier day). */
  today: string | null = null,
): PickupsSummary {
  const all = view.items.filter((item) => item.phase !== "Completed");
  const earlier = (item: (typeof all)[number]) =>
    Boolean(item.businessDate && today && item.businessDate < today);
  const waiting = all.filter((item) => !earlier(item));
  return {
    waiting: waiting.length,
    earlierDays: all.length - waiting.length,
    remaking: waiting.filter((item) => (item.remakeQuantity ?? 0) > 0).length,
    more: (view.nextAfterFulfillmentReference ?? null) !== null,
  };
}
export function summarizeExceptions(view: OrderExceptionView): ExceptionsSummary {
  const open = view.items.filter((item) => item.status !== "Resolved");
  return {
    open: open.length,
    overdue: open.filter((item) => isExceptionOverdue(item, view.projectedAt)).length,
  };
}

export type OverviewRead<T> =
  /** WP-2423 Q11 follow-up: the staff member's role has no screen for this; it is not read. */
  | { readonly kind: "Hidden" }
  | { readonly kind: "Loading" }
  | { readonly kind: "Ready"; readonly value: T }
  | { readonly kind: "Unavailable" };
export interface OverviewTodayState {
  readonly orders: OverviewRead<OrdersSummary>;
  readonly pickups: OverviewRead<PickupsSummary>;
  readonly exceptions: OverviewRead<ExceptionsSummary>;
  /** WP-2423 (3cd0f8dd M7): open tables and those waiting to be closed. */
  readonly tables: OverviewRead<TablesRead>;
  readonly updatedAt: string | null;
}
const loading = { kind: "Loading" } as const;
export const initialOverviewState: OverviewTodayState = {
  orders: loading,
  pickups: loading,
  exceptions: loading,
  tables: loading,
  updatedAt: null,
};
/** WP-2423 (3cd0f8dd M7): the tables summary once both the tables and the orders are read. */
export function tablesSummary(
  state: OverviewTodayState,
  dayStartsAt: string | null = null,
): OverviewRead<TablesSummary> {
  if (state.tables.kind !== "Ready") return state.tables;
  return {
    kind: "Ready",
    value: summarizeTables(
      state.tables.value,
      state.orders.kind === "Ready" ? state.orders.value.servedDineIn : null,
      dayStartsAt,
    ),
  };
}

/**
 * 2026-10-21 live check ("Open orders 3+" was unclear): the Home page reads the first page of each
 * list only. When more follows, the number is a lower bound and says so in words ("At least 3")
 * with what was counted; otherwise it is the exact count.
 */
export interface CountShown {
  /** Words before the number ("At least"), or null for an exact count. */
  readonly qualifier: string | null;
  readonly number: string;
  /** What was counted, when the number is only a lower bound. */
  readonly note: string | null;
}
export function countShown(n: number, more: boolean, partOfList: string): CountShown {
  return more
    ? {
        qualifier: n > 0 ? t("At least") : null,
        number: String(n),
        note: t("Counted from {partOfList} only", { partOfList: partOfList }),
      }
    : { qualifier: null, number: String(n), note: null };
}
function Count<T>({
  label,
  read,
  value,
  detail,
  href,
  linkLabel,
  attention,
}: {
  readonly label: string;
  readonly read: OverviewRead<T>;
  readonly value: (summary: T) => CountShown | string;
  readonly detail: (summary: T) => string;
  readonly href: string;
  readonly linkLabel: string;
  /** Figma v1: the detail words are the ones to act on (shown in the warning colour too). */
  readonly attention?: ((summary: T) => boolean) | undefined;
}) {
  if (read.kind === "Hidden") return null;
  const shown = read.kind === "Ready" ? value(read.value) : null;
  const count: CountShown | null =
    typeof shown === "string" ? { qualifier: null, number: shown, note: null } : shown;
  const needsAction = read.kind === "Ready" && attention?.(read.value) === true;
  return (
    <li
      aria-busy={read.kind === "Loading"}
      className={needsAction ? "overview-count--attention" : undefined}
    >
      <span className="overview-count__label">{label}</span>
      {read.kind === "Ready" && count !== null ? (
        <>
          <strong className="overview-count__value">
            {count.qualifier === null ? null : (
              <span className="overview-count__qualifier">{count.qualifier} </span>
            )}
            {count.number}
          </strong>
          <span className="overview-count__detail">
            {detail(read.value)}
            {count.note === null ? null : (
              <span className="overview-count__note">{count.note}</span>
            )}
          </span>
        </>
      ) : (
        <span className="overview-count__detail" role="status">
          {read.kind === "Loading" ? t("Reading…") : t("Could not be read")}
        </span>
      )}
      <Link to={href}>{linkLabel}</Link>
    </li>
  );
}

/** The "right now" card; pure so the states can be rendered and checked without a network. */
export function OverviewToday({
  state,
  timeZone,
  busy = false,
  onRefresh,
  approvals = null,
}: {
  readonly state: OverviewTodayState;
  /** WP-2423 Q35: refunds waiting for an approver; null when not permitted or not read. */
  readonly approvals?: ApprovalsWaiting | null;
  readonly timeZone?: string | undefined;
  readonly busy?: boolean;
  readonly onRefresh?: (() => void) | undefined;
}) {
  if (
    [state.orders, state.pickups, state.exceptions, state.tables].every(
      (read) => read.kind === "Hidden",
    )
  )
    return null;
  const tables = tablesSummary(state);
  const pickups = state.pickups;
  return (
    <section className="overview-card overview-card--today" aria-labelledby="today-summary-heading">
      <header>
        <h3 id="today-summary-heading">{t("Right now")}</h3>
        <div className="overview-card__tools">
          <p className="overview-updated">
            {state.updatedAt === null
              ? t("Reading current work…")
              : t("Last checked {updatedAt}", { updatedAt: storeTime(state.updatedAt, timeZone) })}
          </p>
          {onRefresh ? (
            <button type="button" onClick={onRefresh} disabled={busy}>
              {t("Refresh")}
            </button>
          ) : null}
        </div>
      </header>
      <ul className="overview-counts">
        <Count
          label={t("Open orders")}
          read={state.orders}
          value={(o) => countShown(o.open, o.more, t("the most recent orders"))}
          detail={(o) =>
            awaitingAcceptanceText({
              orders: o.awaitingAcceptance,
              rounds: o.awaitingRounds,
              urgentRounds: o.urgentRounds,
            }) +
            (o.dineIn
              ? t(" · {readyToServe} ready to serve", { readyToServe: o.readyToServe })
              : "")
          }
          href="/operations/orders"
          linkLabel={t("View orders")}
          attention={(o) => o.awaitingAcceptance + o.awaitingRounds > 0}
        />
        <Count
          label={t("Pickups waiting")}
          read={state.pickups}
          value={(p) => countShown(p.waiting, p.more, t("the first pickups listed"))}
          detail={(p) =>
            p.waiting === 0
              ? t("Nothing waiting for collection")
              : p.remaking === 0
                ? t("Ready for collection")
                : t("{remaking} waiting on a remake", { remaking: countOf(p.remaking, "order") })
          }
          href="/operations/pickup"
          linkLabel={t("View pickups")}
        />
        {pickups.kind === "Ready" && pickups.value.earlierDays > 0 ? (
          // WP-2423 (3cd0f8dd L7): earlier days' uncollected orders apart from today's, with the
          // Pickup page's "check and close" section.
          <Count
            label={t("Pickups from earlier days")}
            read={pickups}
            value={(p) => String(p.earlierDays)}
            detail={() =>
              t("Check whether they were collected; if not, a manager marks them not collected")
            }
            href="/operations/pickup"
            linkLabel={t("Check and close")}
            attention={() => true}
          />
        ) : null}
        <Count
          label={t("Open tables")}
          read={tables}
          value={(read) => countShown(read.open, read.more, t("the first tables listed"))}
          detail={(read) =>
            read.open === 0
              ? t("No tables open")
              : read.toClose === null
                ? t("A manager or the owner closes tables when the guests have left")
                : read.toClose === 0
                  ? t("None waiting to be closed")
                  : t("{toClose} served — close when the guests have left", {
                      toClose: countOf(read.toClose, "table"),
                    })
          }
          href="/operations/dining"
          linkLabel={t("View tables")}
          attention={(read) => (read.toClose ?? 0) > 0}
        />
        <Count
          label={t("Open exceptions")}
          read={state.exceptions}
          value={(e) => String(e.open)}
          detail={(e) =>
            e.overdue === 0 ? t("None overdue") : t("{overdue} overdue", { overdue: e.overdue })
          }
          href="/operations/order-exceptions"
          linkLabel={t("View exceptions")}
          attention={(e) => e.overdue > 0}
        />
        {approvals === null ? null : (
          <Count
            label={t("Refunds waiting for approval")}
            read={{ kind: "Ready", value: approvals }}
            value={(a) => String(a.awaiting + a.approvedNotSent)}
            detail={(a) =>
              a.awaiting === 0 && a.approvedNotSent === 0
                ? t("Nothing waiting")
                : [
                    a.awaiting === 0 ? null : t("{count} to approve", { count: a.awaiting }),
                    a.approvedNotSent === 0
                      ? null
                      : t("{count} approved, not sent yet", { count: a.approvedNotSent }),
                  ]
                    .filter((part) => part !== null)
                    .join(" · ")
            }
            href="/app/approvals"
            linkLabel={t("Review approvals")}
            attention={(a) => a.awaiting > 0}
          />
        )}
      </ul>
    </section>
  );
}

/** One row of "Needs attention now": what, the detail, its state in words, and where to act. */
export interface AttentionItem {
  readonly key: string;
  readonly title: string;
  readonly detail: string;
  readonly state: string;
  readonly tone: "warning" | "danger";
  readonly href: string;
  readonly action: string;
}
/**
 * Figma v1 (2026-10-25): the work on Home that someone has to act on now, most urgent first, each
 * with the page that settles it. Built only from the summaries Home already reads.
 */
export function attentionItems(
  state: OverviewTodayState,
  approvals: ApprovalsWaiting | null,
  dayStartsAt: string | null = null,
): readonly AttentionItem[] {
  const items: AttentionItem[] = [];
  const tables = state.tables.kind === "Ready" ? state.tables.value.tables : [];
  const calls = tables.filter((table) => table.staffCall != null).length;
  if (calls > 0)
    items.push({
      key: "staff-calls",
      title: t("{tables} asking for staff", { tables: countOf(calls, "table") }),
      detail: t("A guest asked a staff member to come to the table."),
      state: t("Waiting"),
      tone: "danger",
      href: "/operations/dining",
      action: t("Go to Tables"),
    });
  if (state.orders.kind === "Ready") {
    const o = state.orders.value;
    if (o.awaitingAcceptance + o.awaitingRounds > 0)
      items.push({
        key: "orders",
        title: t("Orders waiting to be accepted"),
        detail: awaitingAcceptanceText({
          orders: o.awaitingAcceptance,
          rounds: o.awaitingRounds,
          urgentRounds: o.urgentRounds,
        }),
        state: t("To accept"),
        tone: o.urgentRounds > 0 ? "danger" : "warning",
        href: "/operations/orders",
        action: t("Open orders"),
      });
  }
  if (state.exceptions.kind === "Ready" && state.exceptions.value.overdue > 0)
    items.push({
      key: "exceptions",
      title: t("Exceptions overdue"),
      detail: t("{overdue} overdue", { overdue: state.exceptions.value.overdue }),
      state: t("Overdue"),
      tone: "danger",
      href: "/operations/order-exceptions",
      action: t("View exceptions"),
    });
  if (approvals !== null && approvals.awaiting > 0)
    items.push({
      key: "approvals",
      title: t("Refunds waiting for approval"),
      detail: t("{count} to approve", { count: approvals.awaiting }),
      state: t("To approve"),
      tone: "warning",
      href: "/app/approvals",
      action: t("Review approvals"),
    });
  if (state.pickups.kind === "Ready" && state.pickups.value.earlierDays > 0)
    items.push({
      key: "pickups",
      title: t("Pickups from earlier days"),
      detail: t("Check whether they were collected; if not, a manager marks them not collected"),
      state: t("To check"),
      tone: "warning",
      href: "/operations/pickup",
      action: t("Check and close"),
    });
  const summary = tablesSummary(state, dayStartsAt);
  if (summary.kind === "Ready" && (summary.value.toClose ?? 0) > 0)
    items.push({
      key: "tables",
      title: t("Tables to close"),
      detail: t("{toClose} served — close when the guests have left", {
        toClose: countOf(summary.value.toClose ?? 0, "table"),
      }),
      state: t("To close"),
      tone: "warning",
      href: "/operations/dining",
      action: t("View tables"),
    });
  return items;
}
export function NeedsAttention({
  state,
  approvals = null,
}: {
  readonly state: OverviewTodayState;
  readonly approvals?: ApprovalsWaiting | null;
}) {
  const reads = [state.orders, state.pickups, state.exceptions, state.tables];
  if (reads.every((read) => read.kind === "Hidden")) return null;
  const items = attentionItems(state, approvals);
  const reading = reads.some((read) => read.kind === "Loading");
  return (
    <section
      className="overview-card overview-card--attention"
      aria-labelledby="needs-attention-heading"
    >
      <header>
        <h3 id="needs-attention-heading">{t("Needs attention now")}</h3>
      </header>
      {items.length === 0 ? (
        <p className="overview-attention__empty" role="status">
          {reading ? t("Reading current work…") : t("Nothing needs attention right now.")}
        </p>
      ) : (
        <ul className="overview-attention">
          {items.map((item) => (
            <li key={item.key}>
              <span className="overview-attention__text">
                <strong>{item.title}</strong>
                <span>{item.detail}</span>
              </span>
              <span className={`overview-attention__state overview-attention__state--${item.tone}`}>
                {item.state}
              </span>
              <Link className="overview-attention__action" to={item.href}>
                {item.action}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * WP-2423 (3cd0f8dd M6): the last closed business day's settlement in staff words, for the opening
 * checklist. Unfinished guest payments (nothing charged) are not something to look at.
 */
export function settlementStatusText(view: SettlementView): string {
  const reconciliation = view.reconciliation;
  if (reconciliation === null) return t("Not checked yet");
  const attention = reconciliation.differences.filter((check) => !unfinishedGuestPayment(check));
  if (attention.length > 0)
    return t("{length} payment{value} to look at", {
      length: attention.length,
      value: attention.length === 1 ? "" : "s",
    });
  const settlement = reconciliation.settlement;
  if (settlement === null) return t("Not checked against the payment provider yet");
  const checks = settlement.recheck === null ? settlement.checks : [settlement.recheck.check];
  return checks.every((check) => check.outcome === "Matched" || check.outcome === "Healed")
    ? t("Matches the payment provider")
    : t("Differs from the payment provider — look at it");
}
export type SettlementStatusRead = OverviewRead<{
  readonly businessDate: string;
  readonly text: string;
}>;
interface ChecklistItem {
  readonly key: string;
  readonly text: string;
  /** What the Store's records say now ("3 open", "Done"); null for an instruction. */
  readonly status: string | null;
  readonly done: boolean;
  readonly href?: string;
  readonly linkLabel?: string;
}
function readStatus<T>(
  read: OverviewRead<T>,
  value: (v: T) => { readonly status: string; readonly done: boolean },
): { readonly status: string; readonly done: boolean } | null {
  if (read.kind === "Hidden") return null;
  if (read.kind === "Loading") return { status: t("Reading…"), done: false };
  if (read.kind === "Unavailable") return { status: t("Could not be read"), done: false };
  return value(read.value);
}
// A lower bound says so in words ("At least 3 left"), never as "3+".
const left = (n: number, more = false) =>
  n === 0
    ? { status: t("Done"), done: true }
    : { status: more ? t("At least {n} left", { n }) : t("{n} left", { n }), done: false };
/**
 * WP-2423 (3cd0f8dd M6): what staff check when they open and close the Store, each line from the
 * same reads as "Right now" (and the last closed day's settlement). Lines whose screen the staff
 * member does not have are left out. Pure so every state renders without a network.
 */
export function dayChecklist(
  state: OverviewTodayState,
  settlement: SettlementStatusRead,
  serviceHref: string | null,
  /** Start of the Store's current business day; tables seated before it were left open. */
  dayStartsAt: string | null = null,
): { readonly opening: readonly ChecklistItem[]; readonly closing: readonly ChecklistItem[] } {
  const tables = tablesSummary(state, dayStartsAt);
  const item = (
    key: string,
    text: string,
    status: { readonly status: string; readonly done: boolean } | null,
    href?: string,
    linkLabel?: string,
  ): ChecklistItem[] =>
    status === null
      ? []
      : [
          {
            key,
            text,
            status: status.status,
            done: status.done,
            ...(href === undefined ? {} : { href }),
            ...(linkLabel === undefined ? {} : { linkLabel }),
          },
        ];
  const instruction = (key: string, text: string, href: string, linkLabel: string) => ({
    key,
    text,
    status: null,
    done: false,
    href,
    linkLabel,
  });
  const opening: ChecklistItem[] = [
    ...(serviceHref === null
      ? []
      : [
          instruction(
            "ordering-on",
            t("If online ordering was paused at closing, turn it back on."),
            serviceHref,
            t("Hours & ordering"),
          ),
        ]),
    ...item(
      "settlement",
      settlement.kind === "Ready"
        ? t("Settlement for {businessDate}", {
            businessDate: businessDateText(settlement.value.businessDate),
          })
        : t("Settlement for the last closed day"),
      readStatus(settlement, (v) => ({
        status: v.text,
        done: v.text === "Matches the payment provider",
      })),
      "/app/operations/payment-reconciliation",
      t("Settlement"),
    ),
    ...item(
      "earlier-pickups",
      t("Pickups from earlier days: check whether they were collected, then close them"),
      readStatus(state.pickups, (p) => left(p.earlierDays)),
      "/operations/pickup",
      t("Pickup"),
    ),
    ...item(
      "tables-left-open",
      t("Tables still open from before"),
      readStatus(tables, (summary) =>
        summary.earlierDays === null
          ? { status: t("Reading…"), done: false }
          : left(summary.earlierDays, summary.more),
      ),
      "/operations/dining",
      t("Tables"),
    ),
  ];
  const closing: ChecklistItem[] = [
    ...item(
      "orders",
      t("Every order made and served or handed over"),
      readStatus(state.orders, (o) => left(o.open, o.more)),
      "/operations/orders",
      t("Orders"),
    ),
    ...item(
      "pickups",
      t("Pickups not collected: a manager marks them not collected"),
      readStatus(state.pickups, (p) => left(p.waiting + p.earlierDays, p.more)),
      "/operations/pickup",
      t("Pickup"),
    ),
    ...item(
      "tables",
      t("Tables closed once the guests have left"),
      readStatus(tables, (t) => left(t.open, t.more)),
      "/operations/dining",
      t("Tables"),
    ),
    ...item(
      "exceptions",
      t("Exceptions handled or noted for tomorrow"),
      readStatus(state.exceptions, (e) => left(e.open)),
      "/operations/order-exceptions",
      t("Exceptions"),
    ),
    ...(serviceHref === null
      ? []
      : [
          instruction(
            "ordering-off",
            t(
              "When you stop taking orders, pause online ordering so guests can't order after close.",
            ),
            serviceHref,
            t("Hours & ordering"),
          ),
        ]),
    ...(settlement.kind === "Hidden"
      ? []
      : [
          {
            key: "settlement-later",
            text: t(
              "Today's payments are checked against the payment provider after the business day ends. Look at the result when you open.",
            ),
            status: null,
            done: false,
          },
        ]),
  ];
  return { opening, closing };
}
function ChecklistList({
  label,
  items,
}: {
  readonly label: string;
  readonly items: readonly ChecklistItem[];
}) {
  if (items.length === 0) return null;
  return (
    <div className="overview-checklist__group">
      <h4>{label}</h4>
      <ul>
        {items.map((entry) => (
          <li key={entry.key} data-done={entry.done ? "true" : undefined}>
            <span className="overview-checklist__text">{entry.text}</span>
            {entry.status === null ? null : (
              <strong className="overview-checklist__status">{systemText(entry.status)}</strong>
            )}
            {entry.href === undefined ? null : (
              <Link to={entry.href}>
                {t("Go to {value}", { value: entry.linkLabel ?? t("the page") })}
              </Link>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
/** WP-2423 (3cd0f8dd M6): the day-start and day-end checklist card on Home. */
export function DayChecklist({
  state,
  settlement,
  serviceHref,
}: {
  readonly state: OverviewTodayState;
  readonly settlement: SettlementStatusRead;
  readonly serviceHref: string | null;
}) {
  const dayStartsAt = useStoreBusinessDay()?.startsAt ?? null;
  const { opening, closing } = dayChecklist(state, settlement, serviceHref, dayStartsAt);
  if (opening.length === 0 && closing.length === 0) return null;
  return (
    <section
      className="overview-card overview-card--checklist"
      aria-labelledby="day-checklist-heading"
    >
      <header>
        <h3 id="day-checklist-heading">{t("Opening and closing")}</h3>
      </header>
      <ChecklistList label={t("When you open")} items={opening} />
      <ChecklistList label={t("Before you close")} items={closing} />
    </section>
  );
}

/** Reads the three pilot projections for the selected Store and keeps them current on demand. */
/** Home summary screens, each read only when the role's workspace includes its screen. */
export const overviewScreens = Object.freeze({
  orders: "OPS-ORDER-QUEUE",
  pickups: "FUL-PICKUP-QUEUE",
  exceptions: "OPS-ORDER-EXCEPTION",
  tables: "DIN-FLOOR-BOARD",
  settlement: "PAY-RECONCILIATION",
  service: "ORG-STORE-LIST",
} as const);
export function StoreOverview({
  csrf,
  storeReference,
  storeLabel,
  timeZone,
  screens,
  fetcher,
}: {
  /** Screen IDs the workspace permits this staff member (the navigation list). */
  readonly screens: readonly string[];
  readonly csrf: string;
  readonly storeReference: string;
  readonly storeLabel: string;
  readonly timeZone?: string | undefined;
  readonly fetcher?: typeof fetch | undefined;
}) {
  const clients = useMemo(
    () => ({
      orders: createCurrentOrderQueueClient(fetcher),
      exceptions: createOrderExceptionClient(fetcher),
      tables: createDiningSessionClient(fetcher),
      settlement: createSettlementClient(fetcher),
      pickups: createPickupClient({
        csrf,
        storeReference,
        storeLabel,
        ...(fetcher === undefined ? {} : { fetcher }),
      }),
    }),
    [csrf, storeReference, storeLabel, fetcher],
  );
  // A new array each render must not restart reading: depend on its content only.
  const screenKey = screens.join("|");
  const permitted = useMemo(() => {
    const ids = screenKey.split("|");
    return {
      orders: ids.includes(overviewScreens.orders),
      pickups: ids.includes(overviewScreens.pickups),
      exceptions: ids.includes(overviewScreens.exceptions),
      tables: ids.includes(overviewScreens.tables),
      settlement: ids.includes(overviewScreens.settlement),
      service: ids.includes(overviewScreens.service),
    };
  }, [screenKey]);
  const hidden = { kind: "Hidden" } as const;
  const [state, setState] = useState<OverviewTodayState>(() => ({
    ...initialOverviewState,
    orders: permitted.orders ? initialOverviewState.orders : hidden,
    pickups: permitted.pickups ? initialOverviewState.pickups : hidden,
    exceptions: permitted.exceptions ? initialOverviewState.exceptions : hidden,
    tables: permitted.tables ? initialOverviewState.tables : hidden,
  }));
  const [settlement, setSettlement] = useState<SettlementStatusRead>(() =>
    permitted.settlement ? { kind: "Loading" } : hidden,
  );
  // Pickup's rule for an earlier day needs the Store's business date (read by the shell).
  const today = useStoreBusinessDay()?.businessDate ?? null;
  const todayRef = useRef(today);
  todayRef.current = today;
  const pickupView = useRef<Parameters<typeof summarizePickups>[0] | null>(null);
  useEffect(() => {
    const view = pickupView.current;
    if (view !== null)
      setState((s) =>
        s.pickups.kind === "Ready"
          ? { ...s, pickups: { kind: "Ready", value: summarizePickups(view, today) } }
          : s,
      );
  }, [today]);
  const [busy, setBusy] = useState(false);
  const active = useRef<AbortController | null>(null);
  const load = useCallback(
    async (withSettlement = false) => {
      active.current?.abort();
      const controller = new AbortController();
      active.current = controller;
      setBusy(true);
      const read = async <T,>(
        run: () => Promise<T>,
        apply: (read: OverviewRead<T>) => void,
      ): Promise<void> => {
        try {
          const value = await run();
          if (!controller.signal.aborted) apply({ kind: "Ready", value });
        } catch {
          if (!controller.signal.aborted) apply({ kind: "Unavailable" });
        }
      };
      await Promise.all([
        permitted.orders
          ? read(
              async () => summarizeOrders(await clients.orders.load(null, controller.signal)),
              (orders) => setState((s) => ({ ...s, orders })),
            )
          : null,
        permitted.pickups
          ? read(
              async () => {
                const view = parsePickupQueueView(await clients.pickups.loadQueue());
                pickupView.current = view;
                return summarizePickups(view, todayRef.current);
              },
              (pickups) => setState((s) => ({ ...s, pickups })),
            )
          : null,
        permitted.tables
          ? read(
              async (): Promise<TablesRead> => {
                const page = await clients.tables.tables(csrf, null, controller.signal);
                return {
                  tables: page.items,
                  canClose: page.canCloseSessions,
                  more: page.next !== null,
                  readAt: new Date().toISOString(),
                };
              },
              (tables) => setState((s) => ({ ...s, tables })),
            )
          : null,
        // The last closed day's settlement does not change while the day runs: read on opening the
        // page and on Refresh, not on every poll.
        permitted.settlement && withSettlement
          ? clients.settlement
              .load(null, controller.signal)
              .then((view) => {
                if (!controller.signal.aborted)
                  setSettlement({
                    kind: "Ready",
                    value: { businessDate: view.businessDate, text: settlementStatusText(view) },
                  });
              })
              .catch((error: unknown) => {
                if (controller.signal.aborted) return;
                setSettlement(
                  error instanceof SettlementClientError && error.code === "NotCovered"
                    ? { kind: "Hidden" }
                    : { kind: "Unavailable" },
                );
              })
          : null,
        permitted.exceptions
          ? read(
              async () =>
                summarizeExceptions(
                  parseOrderExceptionView(await clients.exceptions.load(controller.signal)),
                ),
              (exceptions) => setState((s) => ({ ...s, exceptions })),
            )
          : null,
      ]);
      if (!controller.signal.aborted) {
        setState((s) => ({ ...s, updatedAt: new Date().toISOString() }));
        setBusy(false);
      }
    },
    [clients, permitted, csrf],
  );
  // v15 cbff9d6f: no reads once this screen's sign-in has ended; again at once if it is live.
  const live = useStaffSessionLive();
  const approvals = useApprovalsWaiting(screenKey.split("|").includes("APPROVAL-INBOX"), fetcher);
  useEffect(() => {
    if (!live) return;
    if (!permitted.orders && !permitted.pickups && !permitted.exceptions && !permitted.tables)
      return;
    void load(true);
    // WP-2423 Q1: keep "Right now" current while the home page is open and visible.
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, OVERVIEW_REFRESH_MS);
    return () => {
      clearInterval(timer);
      active.current?.abort();
    };
  }, [live, load, permitted]);
  return (
    <>
      {/* WP-2423 Q13: store system alerts. The server decides who may read them (Owner, Store
          Manager); for other roles it answers "not permitted" and the card renders nothing. */}
      <OperationsAlerts timeZone={timeZone} fetcher={fetcher} />
      {/* WP-2423 item 8 ②: in the evening, what is still open before closing. */}
      <ClosingReminder screens={screens} fetcher={fetcher} />
      <OverviewToday
        state={state}
        timeZone={timeZone}
        busy={busy}
        onRefresh={() => void load(true)}
        approvals={approvals}
      />
      <NeedsAttention state={state} approvals={approvals} />
      <DayChecklist
        state={state}
        settlement={settlement}
        serviceHref={
          permitted.service ? `/app/organization/stores/${storeReference}/service` : null
        }
      />
    </>
  );
}
