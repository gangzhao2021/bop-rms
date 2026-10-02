import { OrderPaymentLinks } from "./RefundPaymentPage.js";
import { DiningOrderProgress } from "./DiningOrderProgress.js";
import { OrderAcceptanceAction } from "./OrderAcceptanceAction.js";
import { createOrderAcceptanceClient } from "./order-acceptance-client.js";
import { serviceOperationReference } from "./service-control-client.js";
import { AppFrame, StatePanel } from "@bop-rms/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  createCurrentOrderQueueClient,
  CurrentOrderQueueError,
  type CurrentOrderQueue,
} from "./current-order-queue-client.js";

type State =
  | { kind: "Loading" | "PermissionDenied" | "Unavailable" }
  | { kind: "Ready"; view: CurrentOrderQueue };
const client = createCurrentOrderQueueClient();
interface CurrentOrderFilters {
  readonly orderNumber: string;
  readonly type: string;
  readonly channel: string;
  readonly phase: string;
}
export function filterCurrentOrderItems(
  items: CurrentOrderQueue["items"],
  filters: CurrentOrderFilters,
) {
  const orderNumber = filters.orderNumber.trim().toLocaleLowerCase();
  return items.filter(
    (order) =>
      (!orderNumber || order.orderNumber.toLocaleLowerCase() === orderNumber) &&
      (filters.type === "All" || order.orderType === filters.type) &&
      (filters.channel === "All" || order.sourceChannel === filters.channel) &&
      (filters.phase === "All" || (order.currentPhase ?? "Unavailable") === filters.phase),
  );
}
export function CurrentOrderQueueRows({
  view,
  visibleOrderReferences,
  action,
  detail,
}: {
  readonly view: CurrentOrderQueue;
  readonly visibleOrderReferences?: ReadonlySet<string>;
  readonly detail?: (order: CurrentOrderQueue["items"][number]) => React.ReactNode;
  readonly action?: (
    order: CurrentOrderQueue["items"][number],
    batch: CurrentOrderQueue["items"][number]["batches"][number],
  ) => React.ReactNode;
}) {
  return view.items.length === 0 ? (
    <StatePanel heading="No orders on this page" status>
      <p>No orders were returned for this page.</p>
    </StatePanel>
  ) : (
    <div className="order-workbench" aria-label="Current orders">
      <p className="order-workbench-count">
        {visibleOrderReferences?.size ?? view.items.length} matching orders on this page
      </p>
      {view.items.map((order) => (
        <details
          className="order-workbench-entry"
          key={order.orderReference}
          hidden={
            visibleOrderReferences !== undefined &&
            !visibleOrderReferences.has(order.orderReference)
          }
          open={view.items.length === 1 || visibleOrderReferences?.size === 1}
        >
          <summary>
            <span className="order-workbench-identity">
              <h2>
                {order.orderNumber}{" "}
                <span className="order-workbench-disclosure" aria-hidden="true">
                  ⌄
                </span>
              </h2>
              <span>
                {order.orderType === "DineIn" ? "Dine-in" : "Pickup"} · {order.sourceChannel}
              </span>
            </span>
            <span
              className="order-workbench-phase"
              data-phase={order.currentPhase ?? "Unavailable"}
            >
              {order.currentPhase === "InProgress"
                ? "In progress"
                : (order.currentPhase ?? "Status unavailable")}
            </span>
            <span className="order-workbench-batches">
              {order.batches.filter((batch) => batch.acceptanceStatus === "Accepted").length}{" "}
              accepted ·{" "}
              {order.batches.filter((batch) => batch.acceptanceStatus === "NotAccepted").length} not
              accepted
              {order.batches.some((batch) => batch.acceptanceStatus === "Cancelled")
                ? ` · ${order.batches.filter((batch) => batch.acceptanceStatus === "Cancelled").length} cancelled`
                : ""}
            </span>
            <time
              className="order-workbench-time"
              dateTime={order.submittedAt}
              title={order.submittedAt}
            >
              {order.submittedAt.slice(11, 16)} UTC
            </time>
          </summary>
          <div className="order-workbench-detail">
            <dl>
              <div>
                <dt>Order type</dt>
                <dd>{order.orderType}</dd>
              </div>
              <div>
                <dt>Channel</dt>
                <dd>{order.sourceChannel}</dd>
              </div>
              <div>
                <dt>Current version</dt>
                <dd>{order.currentVersion ?? "Unavailable"}</dd>
              </div>
              <div>
                <dt>Submitted</dt>
                <dd>
                  <time dateTime={order.submittedAt}>{order.submittedAt}</time>
                </dd>
              </div>
              <div>
                <dt>Last checked</dt>
                <dd>
                  <time dateTime={order.observedAt}>{order.observedAt}</time>
                </dd>
              </div>
            </dl>
            {detail?.(order)}
            {order.batches.map((batch) => (
              <section key={batch.orderBatchReference} aria-label={"Batch " + batch.sequence}>
                <h3>
                  Batch {batch.sequence}
                  {batch.sequence === 1 ? " · Initial" : " · Additional"}
                </h3>
                <p>
                  {batch.acceptanceStatus === "Cancelled"
                    ? "Batch cancelled"
                    : "Acceptance: " +
                      (batch.acceptanceStatus === "Accepted" ? "Accepted" : "Not accepted")}
                </p>
                {action?.(order, batch)}
              </section>
            ))}
          </div>
        </details>
      ))}
    </div>
  );
}
export function CurrentOrderDetails({
  order,
  csrf,
  locked,
  onBusy,
}: {
  readonly order: CurrentOrderQueue["items"][number];
  readonly csrf: string;
  readonly locked: boolean;
  readonly onBusy: (busy: boolean) => void;
}) {
  return (
    <>
      <OrderPaymentLinks orderReference={order.orderReference} csrf={csrf} />
      {order.orderType === "DineIn" && order.currentPhase !== "Cancelled" ? (
        <DiningOrderProgress
          orderReference={order.orderReference}
          csrf={csrf}
          locked={locked}
          onBusy={onBusy}
        />
      ) : null}
    </>
  );
}

export function CurrentOrderQueuePage({
  storeLabel,
  csrf,
}: {
  readonly storeLabel: string;
  readonly csrf: string;
}) {
  const operations = useRef(
    new Map<string, ReturnType<ReturnType<typeof createOrderAcceptanceClient>["prepare"]>>(),
  );
  const servingOrders = useRef(new Set<string>());
  const [servingBusy, setServingBusy] = useState(false);
  const refreshButton = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  const [after, setAfter] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [state, setState] = useState<State>({ kind: "Loading" });
  const [orderNumberSearch, setOrderNumberSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState("All");
  const [channelFilter, setChannelFilter] = useState("All");
  const [phaseFilter, setPhaseFilter] = useState("All");
  useEffect(() => {
    const controller = new AbortController();
    setState({ kind: "Loading" });
    void client
      .load(after, controller.signal)
      .then((view) => {
        if (!controller.signal.aborted) setState({ kind: "Ready", view });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setState({ kind: error instanceof CurrentOrderQueueError ? error.code : "Unavailable" });
      });
    return () => controller.abort();
  }, [after, refresh]);
  useEffect(() => {
    if (state.kind !== "Loading" && restoreFocus.current) {
      restoreFocus.current = false;
      refreshButton.current?.focus();
    }
  }, [state]);
  const reload = (cursor: string | null) => {
    if (servingOrders.current.size > 0) return;
    restoreFocus.current = true;
    setState({ kind: "Loading" });
    setAfter(cursor);
    setRefresh((value) => value + 1);
  };
  const filteredOrders = useMemo(() => {
    if (state.kind !== "Ready") return [];
    return filterCurrentOrderItems(state.view.items, {
      orderNumber: orderNumberSearch,
      type: typeFilter,
      channel: channelFilter,
      phase: phaseFilter,
    });
  }, [channelFilter, orderNumberSearch, phaseFilter, state, typeFilter]);
  const visibleOrderReferences = useMemo(
    () => new Set(filteredOrders.map((order) => order.orderReference)),
    [filteredOrders],
  );
  const hasOrderFilters =
    orderNumberSearch !== "" ||
    typeFilter !== "All" ||
    channelFilter !== "All" ||
    phaseFilter !== "All";
  const clearOrderFilters = () => {
    setOrderNumberSearch("");
    setTypeFilter("All");
    setChannelFilter("All");
    setPhaseFilter("All");
  };
  return (
    <div className="orders-page">
      <AppFrame title="Orders" description={storeLabel}>
        <div className="card-actions">
          <button
            ref={refreshButton}
            onClick={() => reload(null)}
            disabled={state.kind === "Loading" || servingBusy}
          >
            Refresh orders
          </button>
          {after !== null ? (
            <button onClick={() => reload(null)} disabled={state.kind === "Loading" || servingBusy}>
              First page
            </button>
          ) : null}
        </div>
        {state.kind === "Ready" ? (
          <>
            <div
              className="list-filters order-queue-filters"
              role="search"
              aria-label="Filter orders on this page"
            >
              <label>
                Exact order number
                <input
                  type="search"
                  value={orderNumberSearch}
                  maxLength={40}
                  autoComplete="off"
                  onChange={(event) => setOrderNumberSearch(event.target.value)}
                />
              </label>
              <label>
                Order type
                <select value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)}>
                  <option value="All">All types</option>
                  <option value="DineIn">Dine-in</option>
                  <option value="Pickup">Pickup</option>
                </select>
              </label>
              <label>
                Channel
                <select
                  value={channelFilter}
                  onChange={(event) => setChannelFilter(event.target.value)}
                >
                  <option value="All">All channels</option>
                  <option value="Api">API</option>
                  <option value="Pos">POS</option>
                  <option value="Qr">QR</option>
                  <option value="Web">Web</option>
                </select>
              </label>
              <label>
                Order status
                <select
                  value={phaseFilter}
                  onChange={(event) => setPhaseFilter(event.target.value)}
                >
                  <option value="All">All statuses</option>
                  <option value="Submitted">Submitted</option>
                  <option value="Accepted">Accepted</option>
                  <option value="InProgress">In progress</option>
                  <option value="Ready">Ready</option>
                  <option value="Rejected">Rejected</option>
                  <option value="Cancelled">Cancelled</option>
                  <option value="Fulfilled">Fulfilled</option>
                  <option value="Unavailable">Unavailable</option>
                </select>
              </label>
              <p className="order-queue-filter-count" aria-live="polite">
                Showing {filteredOrders.length} of {state.view.items.length} orders on this server
                page.
              </p>
              <p className="order-queue-filter-note">
                Search and filters apply to this loaded page only. Payment, Kitchen, overdue,
                exception and claim filters require additional authorized queue fields.
              </p>
              {hasOrderFilters ? (
                <button type="button" onClick={clearOrderFilters}>
                  Clear order filters
                </button>
              ) : null}
            </div>
            {state.view.items.length > 0 && filteredOrders.length === 0 ? (
              <StatePanel heading="No orders match these filters" status>
                <p>Clear the filters or load another server page.</p>
              </StatePanel>
            ) : null}
            <CurrentOrderQueueRows
              view={state.view}
              visibleOrderReferences={visibleOrderReferences}
              detail={(order) => (
                <CurrentOrderDetails
                  order={order}
                  csrf={csrf}
                  locked={servingBusy}
                  onBusy={(busy) => {
                    if (busy) servingOrders.current.add(order.orderReference);
                    else servingOrders.current.delete(order.orderReference);
                    setServingBusy(servingOrders.current.size > 0);
                  }}
                />
              )}
              action={(order, batch) =>
                batch.canRequestAcceptance ? (
                  <fieldset disabled={servingBusy}>
                    <OrderAcceptanceAction
                      key={batch.orderBatchReference}
                      csrf={csrf}
                      orderNumber={
                        batch.sequence === 1
                          ? order.orderNumber
                          : order.orderNumber + " · batch " + batch.sequence
                      }
                      operation={() => {
                        let operation = operations.current.get(batch.orderBatchReference);
                        if (!operation) {
                          operation = createOrderAcceptanceClient().prepare({
                            acceptanceReference: serviceOperationReference(),
                            operationReference: serviceOperationReference(),
                            orderReference: order.orderReference,
                            orderBatchReference: batch.orderBatchReference,
                            expectedOrderVersion: order.currentVersion ?? 0,
                          });
                          operations.current.set(batch.orderBatchReference, operation);
                        }
                        return operation;
                      }}
                      onRejected={() => operations.current.delete(batch.orderBatchReference)}
                      onAccepted={() => {
                        operations.current.delete(batch.orderBatchReference);
                        reload(after);
                      }}
                    />
                  </fieldset>
                ) : null
              }
            />
            {state.view.nextAfterOrderReference !== null ? (
              <button
                disabled={servingBusy}
                onClick={() => reload(state.view.nextAfterOrderReference)}
              >
                Next page
              </button>
            ) : null}
          </>
        ) : (
          <StatePanel
            heading={
              state.kind === "Loading"
                ? "Loading orders"
                : state.kind === "PermissionDenied"
                  ? "Permission denied"
                  : "Orders unavailable"
            }
            status
          >
            <p>
              {state.kind === "Loading"
                ? "Reading current orders…"
                : state.kind === "PermissionDenied"
                  ? "Your current session or Store permissions do not allow this queue."
                  : "Orders could not be refreshed. Check your connection and try again."}
            </p>
          </StatePanel>
        )}
      </AppFrame>
    </div>
  );
}
