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

/** WP-2423 P2: what the Store is dealing with right now, from the pilot projections. */
export interface OrdersSummary {
  readonly open: number;
  readonly awaitingAcceptance: number;
  readonly ready: number;
  /** The first page was full; there are more open orders than counted here. */
  readonly more: boolean;
}
export interface PickupsSummary {
  readonly waiting: number;
  readonly more: boolean;
}
export interface ExceptionsSummary {
  readonly open: number;
  readonly overdue: number;
}
const openPhases = new Set(["Submitted", "Accepted", "InProgress", "Ready"]);
export function summarizeOrders(queue: CurrentOrderQueue): OrdersSummary {
  const open = queue.items.filter((order) => openPhases.has(order.currentPhase ?? ""));
  return {
    open: open.length,
    awaitingAcceptance: open.filter((order) => order.canRequestAcceptance).length,
    ready: open.filter((order) => order.currentPhase === "Ready").length,
    more: queue.nextAfterOrderReference !== null,
  };
}
export function summarizePickups(view: {
  readonly items: readonly { readonly phase: string }[];
  readonly nextAfterFulfillmentReference?: string | null | undefined;
}): PickupsSummary {
  return {
    waiting: view.items.filter((item) => item.phase !== "Completed").length,
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
          detail={(o) => `${o.awaitingAcceptance} awaiting acceptance · ${o.ready} ready`}
          href="/operations/orders"
          linkLabel="View orders"
        />
        <Count
          label="Pickups waiting"
          read={state.pickups}
          value={(p) => count(p.waiting, p.more)}
          detail={(p) =>
            p.waiting === 0 ? "Nothing waiting for collection" : "Ready for collection"
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
          : `Updated · ${storeTime(state.updatedAt, timeZone)}`}
      </p>
    </section>
  );
}

/** Reads the three pilot projections for the selected Store and keeps them current on demand. */
export function StoreOverview({
  csrf,
  storeReference,
  storeLabel,
  timeZone,
  fetcher,
}: {
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
  const [state, setState] = useState<OverviewTodayState>(initialOverviewState);
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
      read(
        async () => summarizeOrders(await clients.orders.load(null, controller.signal)),
        (orders) => setState((s) => ({ ...s, orders })),
      ),
      read(
        async () => summarizePickups(parsePickupQueueView(await clients.pickups.loadQueue())),
        (pickups) => setState((s) => ({ ...s, pickups })),
      ),
      read(
        async () =>
          summarizeExceptions(
            parseOrderExceptionView(await clients.exceptions.load(controller.signal)),
          ),
        (exceptions) => setState((s) => ({ ...s, exceptions })),
      ),
    ]);
    if (!controller.signal.aborted) {
      setState((s) => ({ ...s, updatedAt: new Date().toISOString() }));
      setBusy(false);
    }
  }, [clients]);
  useEffect(() => {
    void load();
    return () => active.current?.abort();
  }, [load]);
  return (
    <OverviewToday state={state} timeZone={timeZone} busy={busy} onRefresh={() => void load()} />
  );
}
