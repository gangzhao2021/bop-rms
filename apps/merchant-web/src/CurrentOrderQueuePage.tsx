import { OrderPaymentLinks } from "./RefundPaymentPage.js";
import { DiningOrderProgress } from "./DiningOrderProgress.js";
import { OrderAcceptanceAction } from "./OrderAcceptanceAction.js";
import { createOrderAcceptanceClient } from "./order-acceptance-client.js";
import { serviceOperationReference } from "./service-control-client.js";
import { StatePanel } from "@bop-rms/ui";
import { storeTime } from "./StoreTime.js";
import { WorkspacePage } from "./WorkspacePage.js";
export { storeTime } from "./StoreTime.js";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import {
  createCurrentOrderQueueClient,
  CurrentOrderQueueError,
  type CurrentOrderDetail,
  type CurrentOrderQueue,
} from "./current-order-queue-client.js";

type State =
  | { kind: "Loading" | "PermissionDenied" | "NotFound" | "Unavailable" }
  | { kind: "Ready"; view: CurrentOrderQueue; detail?: CurrentOrderDetail };
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
      (filters.phase === "All" ||
        (filters.phase === "Expired"
          ? order.unfulfillable !== null
          : filters.phase === "NotCollected"
            ? order.pickupNotCollected
            : order.unfulfillable === null &&
              !order.pickupNotCollected &&
              (order.currentPhase ?? "Unavailable") === filters.phase)),
  );
}
/** "$6.78" for 678 CAD minor units; the currency's own minor-unit exponent, no floating point. */
export function orderMoney(value: { readonly amountMinor: string; readonly currencyCode: string }) {
  const exponent =
    new Intl.NumberFormat("en-CA", {
      style: "currency",
      currency: value.currencyCode,
    }).resolvedOptions().maximumFractionDigits ?? 2;
  const negative = value.amountMinor.startsWith("-");
  const digits = (negative ? value.amountMinor.slice(1) : value.amountMinor).padStart(
    exponent + 1,
    "0",
  );
  const amount =
    exponent === 0 ? digits : digits.slice(0, -exponent) + "." + digits.slice(-exponent);
  return (
    (negative ? "−" : "") + (value.currencyCode === "CAD" ? "$" : value.currencyCode + " ") + amount
  );
}

/** WP-2423 OPS-ORDER-DETAIL: what was ordered — items with options and notes, and the totals. */
export function CurrentOrderLines({ lines }: { readonly lines: CurrentOrderDetail["lines"] }) {
  const t = lines.totals;
  return (
    <section className="order-lines" aria-label="Items ordered">
      <h3>Items</h3>
      <ul>
        {lines.items.map((item) => (
          <li key={item.orderItemReference}>
            <span className="order-line-quantity">{item.quantity} ×</span>
            <span className="order-line-name">
              {item.name}
              {item.options.length > 0 ? (
                <span className="order-line-options">
                  {item.options
                    .map((option) =>
                      option.quantity > 1 ? `${option.name} × ${option.quantity}` : option.name,
                    )
                    .join(" · ")}
                </span>
              ) : null}
              {item.customerNote !== null ? (
                <span className="order-line-note">Note: {item.customerNote}</span>
              ) : null}
            </span>
            <span className="order-line-amount">{orderMoney(item.subtotal)}</span>
          </li>
        ))}
      </ul>
      <dl className="order-lines-totals">
        <div>
          <dt>Subtotal</dt>
          <dd>{orderMoney(t.subtotal)}</dd>
        </div>
        {t.discount.amountMinor !== "0" ? (
          <div>
            <dt>Discount</dt>
            <dd>{orderMoney(t.discount)}</dd>
          </div>
        ) : null}
        {t.fee.amountMinor !== "0" ? (
          <div>
            <dt>Fees</dt>
            <dd>{orderMoney(t.fee)}</dd>
          </div>
        ) : null}
        <div>
          <dt>Tax</dt>
          <dd>{orderMoney(t.tax)}</dd>
        </div>
        <div>
          <dt>Total</dt>
          <dd>{orderMoney(t.total)}</dd>
        </div>
      </dl>
    </section>
  );
}

/** Reads an Order's lines when its queue entry is opened. */
function QueuedOrderLines({
  orderReference,
  client,
}: {
  readonly orderReference: string;
  readonly client: ReturnType<typeof createCurrentOrderQueueClient>;
}) {
  const [state, setState] = useState<
    { kind: "Loading" | "Unavailable" } | { kind: "Ready"; detail: CurrentOrderDetail }
  >({ kind: "Loading" });
  useEffect(() => {
    const controller = new AbortController();
    void client
      .loadDetail(orderReference, controller.signal)
      .then((detail) => {
        if (!controller.signal.aborted) setState({ kind: "Ready", detail });
      })
      .catch(() => {
        if (!controller.signal.aborted) setState({ kind: "Unavailable" });
      });
    return () => controller.abort();
  }, [orderReference, client]);
  return state.kind === "Ready" ? (
    <CurrentOrderLines lines={state.detail.lines} />
  ) : (
    <p className="order-lines-state" role="status">
      {state.kind === "Loading"
        ? "Reading items…"
        : "Items could not be read. Open the order to retry."}
    </p>
  );
}

const unfulfillableText = {
  CapacityExpired: "Not accepted before its preparation slot expired.",
  SubmissionCancelled: "The submission was cancelled after payment.",
  OrderNoLongerFulfillable: "The order could no longer be fulfilled after payment.",
} as const;

export function CurrentOrderQueueRows({
  single = false,
  view,
  visibleOrderReferences,
  action,
  detail,
  timeZone,
}: {
  readonly view: CurrentOrderQueue;
  readonly timeZone?: string | undefined;
  readonly visibleOrderReferences?: ReadonlySet<string>;
  readonly detail?: (order: CurrentOrderQueue["items"][number], open: boolean) => React.ReactNode;
  /** OPS-ORDER-DETAIL: one Order, no page count. */
  readonly single?: boolean;
  readonly action?: (
    order: CurrentOrderQueue["items"][number],
    batch: CurrentOrderQueue["items"][number]["batches"][number],
  ) => React.ReactNode;
}) {
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  return view.items.length === 0 ? (
    <StatePanel heading="No orders on this page" status>
      <p>No orders were returned for this page.</p>
    </StatePanel>
  ) : (
    <div className="order-workbench" aria-label="Current orders">
      <p className="order-workbench-count" hidden={single}>
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
          onToggle={(event) => {
            const open = event.currentTarget.open;
            setOpened((current) => {
              if (open === current.has(order.orderReference)) return current;
              const next = new Set(current);
              if (open) next.add(order.orderReference);
              else next.delete(order.orderReference);
              return next;
            });
          }}
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
              data-phase={
                order.pickupNotCollected
                  ? "NotCollected"
                  : order.unfulfillable !== null
                    ? "Expired"
                    : (order.currentPhase ?? "Unavailable")
              }
            >
              {order.pickupNotCollected
                ? "Not collected"
                : order.unfulfillable !== null
                  ? "Expired · refunded"
                  : order.currentPhase === "InProgress"
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
              {storeTime(order.submittedAt, timeZone)}
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
                <dt>Submitted</dt>
                <dd>
                  <time dateTime={order.submittedAt}>
                    {storeTime(order.submittedAt, timeZone, true)}
                  </time>
                </dd>
              </div>
              <div>
                <dt>Last checked</dt>
                <dd>
                  <time dateTime={order.observedAt} title={order.observedAt}>
                    {storeTime(order.observedAt, timeZone, true)}
                  </time>
                </dd>
              </div>
            </dl>
            {order.pickupNotCollected ? (
              <p className="order-workbench-closed" role="note">
                Closed as not collected after the pickup hold. It was not refunded automatically; a
                manager can still grant a refund from payments.
              </p>
            ) : null}
            {order.unfulfillable !== null ? (
              <p className="order-workbench-closed" role="note">
                {unfulfillableText[order.unfulfillable]} The payment was refunded automatically;
                this order cannot be accepted.
              </p>
            ) : null}
            {detail?.(order, opened.has(order.orderReference) || view.items.length === 1)}
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
  lines,
  fetcher,
}: {
  readonly order: CurrentOrderQueue["items"][number];
  readonly csrf: string;
  readonly locked: boolean;
  readonly onBusy: (busy: boolean) => void;
  /** The Order's items, or null when they are not shown (the queue entry is closed). */
  readonly lines?: React.ReactNode;
  readonly fetcher?: typeof fetch | undefined;
}) {
  return (
    <>
      {lines}
      <OrderPaymentLinks orderReference={order.orderReference} csrf={csrf} fetcher={fetcher} />
      {order.orderType === "DineIn" && order.currentPhase !== "Cancelled" ? (
        <DiningOrderProgress
          orderReference={order.orderReference}
          csrf={csrf}
          locked={locked}
          onBusy={onBusy}
          fetcher={fetcher}
        />
      ) : null}
    </>
  );
}

export function CurrentOrderQueuePage({
  storeLabel,
  csrf,
  timeZone,
  orderReference,
  fetcher,
}: {
  readonly storeLabel: string;
  readonly csrf: string;
  /** WP-2423 OPS-ORDER-DETAIL (/operations/orders/:id): only this Order, with its items. */
  readonly orderReference?: string | undefined;
  /** WP-2423: the Store's IANA time zone; order times are shown in it. */
  readonly timeZone?: string | undefined;
  /** WP-2423 P5: the transport for every read and command on this page (the local demo injects one). */
  readonly fetcher?: typeof fetch | undefined;
}) {
  const client = useMemo(() => createCurrentOrderQueueClient(fetcher), [fetcher]);
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
    void (
      orderReference === undefined
        ? client.load(after, controller.signal).then((view) => ({ kind: "Ready" as const, view }))
        : client
            .loadDetail(orderReference, controller.signal)
            .then((detail) => ({ kind: "Ready" as const, view: detail.view, detail }))
    )
      .then((ready) => {
        if (!controller.signal.aborted) setState(ready);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setState({ kind: error instanceof CurrentOrderQueueError ? error.code : "Unavailable" });
      });
    return () => controller.abort();
  }, [after, refresh, orderReference]);
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
  const single = orderReference !== undefined;
  const detail = state.kind === "Ready" ? state.detail : undefined;
  return (
    <WorkspacePage
      className="orders-page"
      title={
        single ? (detail === undefined ? "Order" : `Order ${detail.order.orderNumber}`) : "Orders"
      }
      meta={storeLabel}
      actions={
        <>
          {single ? <Link to="/operations/orders">All orders</Link> : null}
          {after !== null ? (
            <button onClick={() => reload(null)} disabled={state.kind === "Loading" || servingBusy}>
              First page
            </button>
          ) : null}
          <button
            ref={refreshButton}
            onClick={() => reload(null)}
            disabled={state.kind === "Loading" || servingBusy}
          >
            {single ? "Refresh order" : "Refresh orders"}
          </button>
        </>
      }
    >
      <>
        {state.kind === "Ready" ? (
          <>
            <div
              hidden={single}
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
                  <option value="Expired">Expired · refunded</option>
                  <option value="NotCollected">Not collected</option>
                  <option value="Unavailable">Unavailable</option>
                </select>
              </label>
              <p className="order-queue-filter-count" aria-live="polite">
                Showing {filteredOrders.length} of {state.view.items.length} orders on this page.
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
              single={single}
              view={state.view}
              timeZone={timeZone}
              visibleOrderReferences={visibleOrderReferences}
              detail={(order, open) => (
                <CurrentOrderDetails
                  fetcher={fetcher}
                  lines={
                    detail !== undefined ? (
                      <CurrentOrderLines lines={detail.lines} />
                    ) : open ? (
                      <>
                        <QueuedOrderLines orderReference={order.orderReference} client={client} />
                        <Link to={`/operations/orders/${order.orderReference}`}>Open order</Link>
                      </>
                    ) : null
                  }
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
                          operation = createOrderAcceptanceClient(fetcher).prepare({
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
            {!single && state.view.nextAfterOrderReference !== null ? (
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
                ? single
                  ? "Loading order"
                  : "Loading orders"
                : state.kind === "PermissionDenied"
                  ? "Permission denied"
                  : state.kind === "NotFound"
                    ? "Order not found"
                    : single
                      ? "Order unavailable"
                      : "Orders unavailable"
            }
            status
          >
            <p>
              {state.kind === "Loading"
                ? single
                  ? "Reading the order…"
                  : "Reading current orders…"
                : state.kind === "PermissionDenied"
                  ? "Your current session or Store permissions do not allow this queue."
                  : state.kind === "NotFound"
                    ? "This order is not at the selected Store."
                    : "Orders could not be refreshed. Check your connection and try again."}
            </p>
          </StatePanel>
        )}
      </>
    </WorkspacePage>
  );
}

const orderRoute = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** WP-2423 OPS-ORDER-DETAIL at /operations/orders/:id. */
export function CurrentOrderDetailRoute(props: {
  readonly storeLabel: string;
  readonly csrf: string;
  readonly timeZone?: string | undefined;
  readonly fetcher?: typeof fetch | undefined;
}) {
  const id = useParams().id;
  return id === undefined || !orderRoute.test(id) ? (
    <WorkspacePage title="Order" meta={props.storeLabel}>
      <StatePanel heading="Order not found" status>
        <p>This order link is not valid.</p>
        <Link to="/operations/orders">All orders</Link>
      </StatePanel>
    </WorkspacePage>
  ) : (
    <CurrentOrderQueuePage key={id} {...props} orderReference={id} />
  );
}
