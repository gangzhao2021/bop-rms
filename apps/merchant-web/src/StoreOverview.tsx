import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import {
  createCurrentOrderQueueClient,
  type CurrentOrderQueue,
} from "./current-order-queue-client.js";
import { createOrderExceptionClient } from "./order-exception-client.js";
import { parseOrderExceptionView, type OrderExceptionView } from "./OrderExceptionPage.js";
import { createPickupClient } from "./pickup-client.js";
import { parsePickupQueueView } from "./pickup.js";
import { storeTime } from "./StoreTime.js";
import { OperationsAlerts } from "./OperationsAlerts.js";

/** WP-2423 P2: what the Store is dealing with right now, from the pilot projections. */
export interface OrdersSummary {
  readonly open: number;
  readonly awaitingAcceptance: number;
  /**
   * Open dine-in orders whose food is all cooked but not yet all served. Pickup readiness is a
   * Fulfillment fact (the pickup queue), never an Ordering phase, so pickups are not counted here.
   */
  readonly readyToServe: number;
  /** Whether any open order is dine-in; a pickup-only Store has nothing to serve at tables. */
  readonly dineIn: boolean;
  /** The first page was full; there are more open orders than counted here. */
  readonly more: boolean;
}
export interface PickupsSummary {
  readonly waiting: number;
  /** Waiting pickups with a dish the kitchen is remaking; staff wait before handing them over. */
  readonly remaking: number;
  readonly more: boolean;
}
export interface ExceptionsSummary {
  readonly open: number;
  readonly overdue: number;
}
/** WP-2423 Q1: the home page re-reads its summaries this often. */
export const OVERVIEW_REFRESH_MS = 30_000;
const openPhases = new Set(["Submitted", "Accepted", "InProgress", "Ready"]);
export function summarizeOrders(queue: CurrentOrderQueue): OrdersSummary {
  const open = queue.items.filter((order) => openPhases.has(order.currentPhase ?? ""));
  const dineIn = open.filter((order) => order.orderType === "DineIn");
  return {
    open: open.length,
    awaitingAcceptance: open.filter((order) => order.canRequestAcceptance).length,
    readyToServe: dineIn.filter((order) => order.currentPhase === "Ready").length,
    dineIn: dineIn.length > 0,
    more: queue.nextAfterOrderReference !== null,
  };
}
export function summarizePickups(view: {
  readonly items: readonly { readonly phase: string; readonly remakeQuantity?: number }[];
  readonly nextAfterFulfillmentReference?: string | null | undefined;
}): PickupsSummary {
  const waiting = view.items.filter((item) => item.phase !== "Completed");
  return {
    waiting: waiting.length,
    remaking: waiting.filter((item) => (item.remakeQuantity ?? 0) > 0).length,
    more: (view.nextAfterFulfillmentReference ?? null) !== null,
  };
}
export function summarizeExceptions(view: OrderExceptionView): ExceptionsSummary {
  const open = view.items.filter((item) => item.status !== "Resolved");
  const now = Date.parse(view.projectedAt);
  return {
    open: open.length,
    overdue: open.filter((item) => Date.parse(item.dueAt) < now).length,
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
  readonly updatedAt: string | null;
}
const loading = { kind: "Loading" } as const;
export const initialOverviewState: OverviewTodayState = {
  orders: loading,
  pickups: loading,
  exceptions: loading,
  updatedAt: null,
};

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
  readonly value: (summary: T) => string;
  readonly detail: (summary: T) => string;
  readonly href: string;
  readonly linkLabel: string;
}) {
  if (read.kind === "Hidden") return null;
  return (
    <li aria-busy={read.kind === "Loading"}>
      <span className="overview-count__label">{label}</span>
      {read.kind === "Ready" ? (
        <>
          <strong className="overview-count__value">{value(read.value)}</strong>
          <span className="overview-count__detail">{detail(read.value)}</span>
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
  const count = (n: number, more: boolean) => (more ? `${n}+` : String(n));
  if ([state.orders, state.pickups, state.exceptions].every((read) => read.kind === "Hidden"))
    return null;
  return (
    <section className="overview-card overview-card--today" aria-labelledby="today-summary-heading">
      <header>
        <h3 id="today-summary-heading">Right now</h3>
        {onRefresh ? (
          <button type="button" onClick={onRefresh} disabled={busy}>
            Refresh
          </button>
        ) : null}
      </header>
      <ul className="overview-counts">
        <Count
          label="Open orders"
          read={state.orders}
          value={(o) => count(o.open, o.more)}
          detail={(o) =>
            `${o.awaitingAcceptance} awaiting acceptance` +
            (o.dineIn ? ` · ${o.readyToServe} ready to serve` : "")
          }
          href="/operations/orders"
          linkLabel="View orders"
        />
        <Count
          label="Pickups waiting"
          read={state.pickups}
          value={(p) => count(p.waiting, p.more)}
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
        <Count
          label="Open exceptions"
          read={state.exceptions}
          value={(e) => String(e.open)}
          detail={(e) => (e.overdue === 0 ? "None overdue" : plural(e.overdue, "overdue"))}
          href="/operations/order-exceptions"
          linkLabel="View exceptions"
        />
      </ul>
      <p className="overview-updated">
        {state.updatedAt === null
          ? "Reading current work…"
          : `Last checked ${storeTime(state.updatedAt, timeZone)}`}
      </p>
    </section>
  );
}

/** Reads the three pilot projections for the selected Store and keeps them current on demand. */
/** Home summary screens, each read only when the role's workspace includes its screen. */
export const overviewScreens = Object.freeze({
  orders: "OPS-ORDER-QUEUE",
  pickups: "FUL-PICKUP-QUEUE",
  exceptions: "OPS-ORDER-EXCEPTION",
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
    };
  }, [screenKey]);
  const hidden = { kind: "Hidden" } as const;
  const [state, setState] = useState<OverviewTodayState>(() => ({
    ...initialOverviewState,
    orders: permitted.orders ? initialOverviewState.orders : hidden,
    pickups: permitted.pickups ? initialOverviewState.pickups : hidden,
    exceptions: permitted.exceptions ? initialOverviewState.exceptions : hidden,
  }));
  const [busy, setBusy] = useState(false);
  const active = useRef<AbortController | null>(null);
  const load = useCallback(async () => {
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
            async () => summarizePickups(parsePickupQueueView(await clients.pickups.loadQueue())),
            (pickups) => setState((s) => ({ ...s, pickups })),
          )
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
  }, [clients, permitted]);
  useEffect(() => {
    if (!permitted.orders && !permitted.pickups && !permitted.exceptions) return;
    void load();
    // WP-2423 Q1: keep "Right now" current while the home page is open and visible.
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, OVERVIEW_REFRESH_MS);
    return () => {
      clearInterval(timer);
      active.current?.abort();
    };
  }, [load, permitted]);
  return (
    <>
      {/* WP-2423 Q13: store system alerts, for the roles that handle exceptions (Owner, Manager). */}
      {permitted.exceptions ? <OperationsAlerts timeZone={timeZone} fetcher={fetcher} /> : null}
      <OverviewToday state={state} timeZone={timeZone} busy={busy} onRefresh={() => void load()} />
    </>
  );
}
