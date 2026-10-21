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
        qualifier: n > 0 ? "At least" : null,
        number: String(n),
        note: `Counted from ${partOfList} only`,
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
}: {
  readonly label: string;
  readonly read: OverviewRead<T>;
  readonly value: (summary: T) => CountShown | string;
  readonly detail: (summary: T) => string;
  readonly href: string;
  readonly linkLabel: string;
}) {
  if (read.kind === "Hidden") return null;
  const shown = read.kind === "Ready" ? value(read.value) : null;
  const count: CountShown | null =
    typeof shown === "string" ? { qualifier: null, number: shown, note: null } : shown;
  return (
    <li aria-busy={read.kind === "Loading"}>
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
          {read.kind === "Loading" ? "Reading…" : "Could not be read"}
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
}: {
  readonly state: OverviewTodayState;
  readonly timeZone?: string | undefined;
  readonly busy?: boolean;
  readonly onRefresh?: (() => void) | undefined;
}) {
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
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
        <h3 id="today-summary-heading">Right now</h3>
        <div className="overview-card__tools">
          <p className="overview-updated">
            {state.updatedAt === null
              ? "Reading current work…"
              : `Last checked ${storeTime(state.updatedAt, timeZone)}`}
          </p>
          {onRefresh ? (
            <button type="button" onClick={onRefresh} disabled={busy}>
              Refresh
            </button>
          ) : null}
        </div>
      </header>
      <ul className="overview-counts">
        <Count
          label="Open orders"
          read={state.orders}
          value={(o) => countShown(o.open, o.more, "the most recent orders")}
          detail={(o) =>
            awaitingAcceptanceText({
              orders: o.awaitingAcceptance,
              rounds: o.awaitingRounds,
              urgentRounds: o.urgentRounds,
            }) + (o.dineIn ? ` · ${o.readyToServe} ready to serve` : "")
          }
          href="/operations/orders"
          linkLabel="View orders"
        />
        <Count
          label="Pickups waiting"
          read={state.pickups}
          value={(p) => countShown(p.waiting, p.more, "the first pickups listed")}
          detail={(p) =>
            p.waiting === 0
              ? "Nothing waiting for collection"
              : p.remaking === 0
                ? "Ready for collection"
                : `${plural(p.remaking, "order")} waiting on a remake`
          }
          href="/operations/pickup"
          linkLabel="View pickups"
        />
        {pickups.kind === "Ready" && pickups.value.earlierDays > 0 ? (
          // WP-2423 (3cd0f8dd L7): earlier days' uncollected orders apart from today's, with the
          // Pickup page's "check and close" section.
          <Count
            label="Pickups from earlier days"
            read={pickups}
            value={(p) => String(p.earlierDays)}
            detail={() =>
              "Check whether they were collected; if not, a manager marks them not collected"
            }
            href="/operations/pickup"
            linkLabel="Check and close"
          />
        ) : null}
        <Count
          label="Open tables"
          read={tables}
          value={(t) => countShown(t.open, t.more, "the first tables listed")}
          detail={(t) =>
            t.open === 0
              ? "No tables open"
              : t.toClose === null
                ? "A manager or the owner closes tables when the guests have left"
                : t.toClose === 0
                  ? "None waiting to be closed"
                  : `${plural(t.toClose, "table")} served — close when the guests have left`
          }
          href="/operations/dining"
          linkLabel="View tables"
        />
        <Count
          label="Open exceptions"
          read={state.exceptions}
          value={(e) => String(e.open)}
          detail={(e) => (e.overdue === 0 ? "None overdue" : `${e.overdue} overdue`)}
          href="/operations/order-exceptions"
          linkLabel="View exceptions"
        />
      </ul>
    </section>
  );
}

/**
 * WP-2423 (3cd0f8dd M6): the last closed business day's settlement in staff words, for the opening
 * checklist. Unfinished guest payments (nothing charged) are not something to look at.
 */
export function settlementStatusText(view: SettlementView): string {
  const reconciliation = view.reconciliation;
  if (reconciliation === null) return "Not checked yet";
  const attention = reconciliation.differences.filter((check) => !unfinishedGuestPayment(check));
  if (attention.length > 0)
    return `${attention.length} payment${attention.length === 1 ? "" : "s"} to look at`;
  const settlement = reconciliation.settlement;
  if (settlement === null) return "Not checked against the payment provider yet";
  const checks = settlement.recheck === null ? settlement.checks : [settlement.recheck.check];
  return checks.every((check) => check.outcome === "Matched" || check.outcome === "Healed")
    ? "Matches the payment provider"
    : "Differs from the payment provider — look at it";
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
  if (read.kind === "Loading") return { status: "Reading…", done: false };
  if (read.kind === "Unavailable") return { status: "Could not be read", done: false };
  return value(read.value);
}
// A lower bound says so in words ("At least 3 left"), never as "3+".
const left = (n: number, more = false) =>
  n === 0
    ? { status: "Done", done: true }
    : { status: `${more ? "At least " : ""}${n} left`, done: false };
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
            "If online ordering was paused at closing, turn it back on.",
            serviceHref,
            "Hours & ordering",
          ),
        ]),
    ...item(
      "settlement",
      settlement.kind === "Ready"
        ? `Settlement for ${businessDateText(settlement.value.businessDate)}`
        : "Settlement for the last closed day",
      readStatus(settlement, (v) => ({
        status: v.text,
        done: v.text === "Matches the payment provider",
      })),
      "/app/operations/payment-reconciliation",
      "Settlement",
    ),
    ...item(
      "earlier-pickups",
      "Pickups from earlier days: check whether they were collected, then close them",
      readStatus(state.pickups, (p) => left(p.earlierDays)),
      "/operations/pickup",
      "Pickup",
    ),
    ...item(
      "tables-left-open",
      "Tables still open from before",
      readStatus(tables, (t) =>
        t.earlierDays === null ? { status: "Reading…", done: false } : left(t.earlierDays, t.more),
      ),
      "/operations/dining",
      "Tables",
    ),
  ];
  const closing: ChecklistItem[] = [
    ...item(
      "orders",
      "Every order made and served or handed over",
      readStatus(state.orders, (o) => left(o.open, o.more)),
      "/operations/orders",
      "Orders",
    ),
    ...item(
      "pickups",
      "Pickups not collected: a manager marks them not collected",
      readStatus(state.pickups, (p) => left(p.waiting + p.earlierDays, p.more)),
      "/operations/pickup",
      "Pickup",
    ),
    ...item(
      "tables",
      "Tables closed once the guests have left",
      readStatus(tables, (t) => left(t.open, t.more)),
      "/operations/dining",
      "Tables",
    ),
    ...item(
      "exceptions",
      "Exceptions handled or noted for tomorrow",
      readStatus(state.exceptions, (e) => left(e.open)),
      "/operations/order-exceptions",
      "Exceptions",
    ),
    ...(serviceHref === null
      ? []
      : [
          instruction(
            "ordering-off",
            "When you stop taking orders, pause online ordering so guests can't order after close.",
            serviceHref,
            "Hours & ordering",
          ),
        ]),
    ...(settlement.kind === "Hidden"
      ? []
      : [
          {
            key: "settlement-later",
            text: "Today's payments are checked against the payment provider after the business day ends. Look at the result when you open.",
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
              <strong className="overview-checklist__status">{entry.status}</strong>
            )}
            {entry.href === undefined ? null : (
              <Link to={entry.href}>Go to {entry.linkLabel ?? "the page"}</Link>
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
        <h3 id="day-checklist-heading">Opening and closing</h3>
      </header>
      <ChecklistList label="When you open" items={opening} />
      <ChecklistList label="Before you close" items={closing} />
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
      <OverviewToday
        state={state}
        timeZone={timeZone}
        busy={busy}
        onRefresh={() => void load(true)}
      />
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
