import { AppFrame, StatePanel } from "@bop-rms/ui";
import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import {
  OrderQueueClientError,
  parseOrderDetailView,
  parseOrderQueueView,
  parseOrderRouteReference,
  unavailableOrderQueueClient,
  type OrderDetailView,
  type OrderQueueClient,
  type OrderQueueItem,
  type OrderQueueView,
} from "./order-queue.js";

type LoadState<T> =
  | {
      readonly kind:
        | "Loading"
        | "PermissionDenied"
        | "NotFound"
        | "Offline"
        | "Conflict"
        | "CommandFailed"
        | "Unavailable";
    }
  | { readonly kind: "Found"; readonly view: T };

function useLoad<T>(load: () => Promise<T>, key: string): LoadState<T> {
  const [state, setState] = useState<LoadState<T>>({ kind: "Loading" });
  useEffect(() => {
    let active = true;
    setState({ kind: "Loading" });
    void load()
      .then((view) => {
        if (active) setState({ kind: "Found", view });
      })
      .catch((error: unknown) => {
        if (active)
          setState({ kind: error instanceof OrderQueueClientError ? error.code : "Unavailable" });
      });
    return () => {
      active = false;
    };
  }, [key, load]);
  return state;
}

type QueueState = Exclude<LoadState<never>["kind"], "Found">;
export function OrderQueueStatePanel({ state }: { readonly state: QueueState }) {
  const states: Record<QueueState, readonly [string, string, "neutral" | "error" | "offline"]> = {
    Loading: ["Loading", "Loading authorized Store Order Queue…", "neutral"],
    PermissionDenied: [
      "Permission denied",
      "Your Ordering permission and Store scope do not allow this queue.",
      "error",
    ],
    NotFound: [
      "Order unavailable",
      "This Order is unavailable in the current authorized Store scope.",
      "neutral",
    ],
    Offline: [
      "Offline read-only",
      "The Order Queue cannot refresh or execute actions while offline.",
      "offline",
    ],
    Conflict: [
      "Source changed",
      "Refresh the authoritative Order version before another action.",
      "offline",
    ],
    CommandFailed: [
      "Command failed",
      "No Order transition is assumed. Refresh before retrying an allowed action.",
      "error",
    ],
    Unavailable: [
      "Order Queue unavailable",
      "The Merchant Order Queue API is not connected. No Order fact was changed.",
      "error",
    ],
  };
  const content = states[state];
  return (
    <StatePanel heading={content[0]} tone={content[2]} status>
      <p>{content[1]}</p>
      <Link to="/app">Return to overview</Link>
    </StatePanel>
  );
}

function OrderCard({
  order,
  readOnly,
  observedAt,
}: {
  readonly order: OrderQueueItem;
  readonly readOnly: boolean;
  readonly observedAt: string;
}) {
  const age = Math.max(
    0,
    Math.floor((Date.parse(observedAt) - Date.parse(order.submittedAt)) / 60_000),
  );
  return (
    <article className="store-card">
      <header>
        <div>
          <p className="bop-eyebrow">
            {order.sourceChannel} · {order.orderType}
          </p>
          <h3>{order.orderNumber}</h3>
        </div>
        <strong>{order.canonicalPhase}</strong>
      </header>
      <dl>
        <div>
          <dt>Age</dt>
          <dd>{age} minutes</dd>
        </div>
        <div>
          <dt>Promise / SLA</dt>
          <dd>Unavailable</dd>
        </div>
        <div>
          <dt>Payment</dt>
          <dd>{order.paymentStatus}</dd>
        </div>
        <div>
          <dt>Kitchen</dt>
          <dd>{order.kitchenStatus}</dd>
        </div>
        <div>
          <dt>Fulfillment</dt>
          <dd>{order.fulfillmentStatus}</dd>
        </div>
        <div>
          <dt>Claim</dt>
          <dd>{order.claimStatus}</dd>
        </div>
        <div>
          <dt>Exception</dt>
          <dd>{order.exceptionStatus}</dd>
        </div>
        <div>
          <dt>Batches / items</dt>
          <dd>
            {order.batchCount} / {order.itemCount}
          </dd>
        </div>
      </dl>
      <div className="card-actions">
        <Link to={`/operations/orders/${order.orderReference}`}>Open detail</Link>
        <button disabled={readOnly || order.claimStatus === "Unavailable"}>Claim</button>
        <button disabled>Accept / reject per policy</button>
      </div>
    </article>
  );
}

export function OrderQueueScreen({ view }: { readonly view: OrderQueueView }) {
  const [query, setQuery] = useState("");
  const [phase, setPhase] = useState("All");
  const normalized = query.trim().toUpperCase();
  const items = view.items.filter(
    (item) =>
      (phase === "All" || item.canonicalPhase === phase) &&
      (normalized.length === 0 ||
        item.orderNumber === normalized ||
        item.orderReference === query.trim()),
  );
  const readOnly = view.freshnessStatus !== "Fresh";
  return (
    <AppFrame
      title="Order Queue"
      description={`OPS-ORDER-QUEUE · ${view.storeLabel} · ${view.businessDate}`}
    >
      <header className="screen-heading">
        <div>
          <h2>Current Order Queue</h2>
          <p>
            {view.freshnessStatus} · {view.projectedAt}
          </p>
        </div>
        <button disabled title="Realtime composition remains WP-1900">
          Refresh from source
        </button>
      </header>
      {readOnly ? (
        <StatePanel heading="Stale board — read-only" tone="offline" status>
          <p>This projection cannot authorize an Order action until the source is refreshed.</p>
        </StatePanel>
      ) : null}
      <div className="list-filters" role="search">
        <label>
          Exact Order number or reference
          <input value={query} onChange={(event) => setQuery(event.currentTarget.value)} />
        </label>
        <label>
          Phase
          <select value={phase} onChange={(event) => setPhase(event.currentTarget.value)}>
            <option>All</option>
            <option>Submitted</option>
            <option>Fulfilled</option>
          </select>
        </label>
      </div>
      {items.length === 0 ? (
        <StatePanel heading="No matching Orders" status>
          <p>No authorized Order matches the exact search and filter.</p>
        </StatePanel>
      ) : (
        <div className="store-card-grid">
          {items.map((order) => (
            <OrderCard
              key={order.orderReference}
              order={order}
              readOnly={readOnly}
              observedAt={view.projectedAt}
            />
          ))}
        </div>
      )}
    </AppFrame>
  );
}

export function OrderDetailScreen({ view }: { readonly view: OrderDetailView }) {
  return (
    <AppFrame
      title={view.order.orderNumber}
      description={`OPS-ORDER-DETAIL · immutable projection · ${view.freshnessStatus}`}
    >
      <OrderCard order={view.order} readOnly observedAt={view.projectedAt} />
      <div className="detail-section-grid">
        {view.batches.map((batch) => (
          <StatePanel heading={`Batch ${batch.sequence}`} key={batch.batchReference}>
            <p>{batch.itemCount} immutable item snapshots</p>
          </StatePanel>
        ))}
      </div>
      <StatePanel heading="Collaborating summaries unavailable" tone="offline">
        <p>
          Money/tax detail, Payment allocations, Kitchen, notifications, audit and unrestricted
          snapshots are not present in WP-1225 and are not inferred.
        </p>
      </StatePanel>
    </AppFrame>
  );
}

export function OrderQueuePage({
  client = unavailableOrderQueueClient,
}: {
  readonly client?: OrderQueueClient;
}) {
  const load = useCallback(() => client.loadQueue().then(parseOrderQueueView), [client]);
  const state = useLoad(load, "queue");
  return state.kind === "Found" ? (
    <OrderQueueScreen view={state.view} />
  ) : (
    <AppFrame title="Order Queue" description="OPS-ORDER-QUEUE">
      <OrderQueueStatePanel state={state.kind} />
    </AppFrame>
  );
}

export function OrderDetailPage({
  client = unavailableOrderQueueClient,
}: {
  readonly client?: OrderQueueClient;
}) {
  let route: string | null = null;
  try {
    route = parseOrderRouteReference(useParams().id);
  } catch {
    route = null;
  }
  const load = useCallback(
    () =>
      route === null
        ? Promise.reject(new OrderQueueClientError("NotFound"))
        : client.loadDetail(route).then((value) => {
            const view = parseOrderDetailView(value);
            if (view.order.orderReference !== route) throw new Error("ORDER_MISMATCH");
            return view;
          }),
    [client, route],
  );
  const state = useLoad(load, route ?? "invalid");
  if (route === null)
    return (
      <AppFrame title="Order" description="OPS-ORDER-DETAIL">
        <OrderQueueStatePanel state="NotFound" />
      </AppFrame>
    );
  return state.kind === "Found" ? (
    <OrderDetailScreen view={state.view} />
  ) : (
    <AppFrame title="Order" description="OPS-ORDER-DETAIL">
      <OrderQueueStatePanel state={state.kind} />
    </AppFrame>
  );
}
