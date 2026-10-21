import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  counterAwaitingCardMachine,
  counterPayByText,
  counterPayByTier,
} from "./counter-payment.js";
import {
  createCurrentOrderQueueClient,
  CurrentOrderQueueError,
  type CurrentOrderQueue,
} from "./current-order-queue-client.js";
import { StaffRoundPaymentAction } from "./StaffRoundPaymentAction.js";
import { useStaffSessionLive } from "./staff-session-reads.js";
import { storeTime } from "./StoreTime.js";

/** How often the counter re-reads its sent, unpaid orders (their pay-by time moves on its own). */
export const COUNTER_AWAITING_REFRESH_MS = 30_000;

type Order = CurrentOrderQueue["items"][number];

/**
 * WP-2423 (v15 751dd768, operating continuity): counter orders that were sent but not yet recorded
 * as paid on the card machine, read from the server (the Orders list), so a reload, a closed tab or
 * another tablet never loses the charge step. Each can be charged and recorded here until it is
 * released at its pay-by time, which is shown and warned about. An unpaid counter order is at most
 * its pickup hold old (minutes), so it is always among the newest orders the first page holds.
 */
export function CounterAwaitingPayment({
  csrf,
  timeZone,
  fetcher,
  refreshKey,
  excludeOrderReference,
}: {
  readonly csrf: string;
  readonly timeZone?: string | undefined;
  readonly fetcher?: typeof fetch | undefined;
  /** Changes after this page sends or records an order, so the list is read again. */
  readonly refreshKey: number;
  /** The order this page is charging right now (shown in its own charge step). */
  readonly excludeOrderReference?: string | null | undefined;
}) {
  const client = useMemo(() => createCurrentOrderQueueClient(fetcher), [fetcher]);
  const [orders, setOrders] = useState<readonly Order[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [reads, setReads] = useState(0);
  /** The last order recorded here (it leaves the list, so staff are told it went through). */
  const [recorded, setRecorded] = useState<string | null>(null);
  const pending = useRef<AbortController | null>(null);
  const live = useStaffSessionLive();
  const read = useCallback(() => {
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    client
      .load(null, controller.signal)
      .then((view) => {
        if (controller.signal.aborted) return;
        setNow(Date.now());
        setOrders(view.items.filter((order) => counterAwaitingCardMachine(order)));
        setFailed(false);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        // Without access to Orders nothing is listed here (the payment record checks again).
        if (error instanceof CurrentOrderQueueError && error.code === "PermissionDenied") {
          setOrders([]);
          setFailed(false);
        } else setFailed(true);
      });
  }, [client]);
  useEffect(() => {
    read();
  }, [read, refreshKey, reads]);
  useEffect(() => () => pending.current?.abort(), []);
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(read, COUNTER_AWAITING_REFRESH_MS);
    const tick = setInterval(() => setNow(Date.now()), 15_000);
    return () => {
      clearInterval(timer);
      clearInterval(tick);
    };
  }, [live, read]);
  const shown = (orders ?? []).filter(
    (order) =>
      order.orderReference !== excludeOrderReference &&
      order.counter?.payBy != null &&
      Date.parse(order.counter.payBy) > now,
  );
  if (!failed && shown.length === 0)
    return recorded === null ? null : (
      <p className="counter-order__awaiting-done" role="status">
        {recorded}
      </p>
    );
  return (
    <section
      className="counter-order__awaiting store-card"
      aria-labelledby="counter-awaiting-heading"
    >
      <h2 id="counter-awaiting-heading">Sent, not paid yet</h2>
      {failed ? (
        <div role="status">
          <p>Couldn&apos;t check for sent orders waiting for payment. Orders lists them too.</p>
          <button type="button" onClick={() => setReads((value) => value + 1)}>
            Try again
          </button>
        </div>
      ) : (
        <p className="bop-muted">
          Charge each on the card machine and record it here before its time ends, or it is released
          and its items go back to stock.
        </p>
      )}
      {recorded !== null ? <p role="status">{recorded}</p> : null}
      <ul className="counter-order__awaiting-list">
        {shown.map((order) => {
          const payBy = order.counter?.payBy ?? "";
          const batch = order.batches[0];
          return (
            <li key={order.orderReference}>
              <p className="counter-order__awaiting-title">
                <strong>Order {order.orderNumber}</strong>{" "}
                <span className="bop-muted">
                  sent {storeTime(order.submittedAt, timeZone)}
                  {order.counter?.recordedAfterOutage ? " · paper order" : ""}
                </span>
              </p>
              <p className="order-accept-by" data-tier={counterPayByTier(payBy, now)}>
                {counterPayByText(payBy, timeZone, now)}
              </p>
              {batch === undefined || !order.canRecordCardMachinePayment ? (
                <p className="bop-muted">Ask a manager to record its payment.</p>
              ) : (
                <StaffRoundPaymentAction
                  kind="CounterOrder"
                  label="Charge on card machine"
                  csrf={csrf}
                  fetcher={fetcher}
                  orderReference={order.orderReference}
                  orderBatchReference={batch.orderBatchReference}
                  amountDueMinor={null}
                  payBy={payBy}
                  loadAmountDue={(signal) =>
                    client
                      .loadDetail(order.orderReference, signal)
                      .then((detail) => detail.order.counter?.amountDueMinor ?? null)
                  }
                  recordedAfterOutage={order.counter?.recordedAfterOutage ?? false}
                  timeZone={timeZone}
                  onRecorded={() => {
                    setRecorded(`Order ${order.orderNumber}: payment recorded. Orders shows it.`);
                    setReads((value) => value + 1);
                  }}
                />
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
