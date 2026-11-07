import { t } from "./i18n/i18n.js";
import { Link } from "react-router";
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
import { CounterCancelAction } from "./CounterCancelAction.js";
import { useStaffSessionLive } from "./staff-session-reads.js";
import { storeTime } from "./StoreTime.js";
import { orderMoney } from "./order-money.js";
import { paidNoteText } from "./counter-payment.js";
import type { RecordedCardPayment } from "./staff-order-entry.js";

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
  onExcludedCancellable,
}: {
  /**
   * WP-2423 M127: whether the order this page is charging may be cancelled by this staff member
   * (it is unpaid and they may cancel orders), from the same read.
   */
  readonly onExcludedCancellable?: ((cancellable: boolean) => void) | undefined;
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
  /**
   * The last order recorded here. It leaves the list, so staff get the same "Order N paid" panel
   * as after a direct charge, with what to do next, until they dismiss it.
   */
  const [recorded, setRecorded] = useState<{
    readonly orderNumber: string;
    readonly payment: RecordedCardPayment;
  } | null>(null);
  const paidHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (recorded !== null) paidHeading.current?.focus();
  }, [recorded]);
  const paidPanel =
    recorded === null ? null : (
      <section
        className="counter-order__charge counter-order__awaiting-paid store-card"
        aria-labelledby="counter-awaiting-paid"
        data-phase={recorded.payment.acceptance === "Accepted" ? "Accepted" : "Paid"}
      >
        <h2 id="counter-awaiting-paid" ref={paidHeading} tabIndex={-1}>
          {t("Order {orderNumber} paid", { orderNumber: recorded.orderNumber })}
        </h2>
        <dl>
          <div>
            <dt>{t("Order")}</dt>
            <dd>{recorded.orderNumber}</dd>
          </div>
          <div>
            <dt>{t("Paid on card machine")}</dt>
            <dd>
              <strong>
                {orderMoney({ amountMinor: recorded.payment.amountMinor, currencyCode: "CAD" })}
              </strong>
            </dd>
          </div>
        </dl>
        <p role="status">
          {paidNoteText({
            tableMode: false,
            recordedAfterOutage: recorded.payment.recordingReason === "RecordedAfterOutage",
            acceptance: recorded.payment.acceptance,
          })}
        </p>
        <div className="card-actions">
          <button type="button" onClick={() => setRecorded(null)}>
            {t("Done")}
          </button>
          <Link to="/operations/orders">{t("Open Orders")}</Link>
        </div>
      </section>
    );
  const pending = useRef<AbortController | null>(null);
  const excluded = useRef(excludeOrderReference);
  excluded.current = excludeOrderReference;
  const onExcluded = useRef(onExcludedCancellable);
  onExcluded.current = onExcludedCancellable;
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
        onExcluded.current?.(
          view.items.some(
            (order) =>
              order.orderReference === excluded.current && order.counter?.canCancelUnpaid === true,
          ),
        );
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
  if (!failed && shown.length === 0) return paidPanel;
  return (
    <>
      {paidPanel}
      <section
        className="counter-order__awaiting store-card"
        aria-labelledby="counter-awaiting-heading"
      >
        <h2 id="counter-awaiting-heading">{t("Sent, not paid yet")}</h2>
        {failed ? (
          <div role="status">
            <p>{t("Couldn't check for sent orders waiting for payment. Orders lists them too.")}</p>
            <button type="button" onClick={() => setReads((value) => value + 1)}>
              {t("Try again")}
            </button>
          </div>
        ) : (
          <p className="bop-muted">
            {/* WP-2423 M127: only those who may cancel are told to cancel; front of house asks a
                manager, as the counter's charge step says. */}
            {shown.some((order) => order.counter?.canCancelUnpaid === true)
              ? t(
                  "Charge each on the card machine and record it here before its time ends. A guest who isn't paying: cancel the order so its items go back to stock.",
                )
              : t(
                  "Charge each on the card machine and record it here before its time ends. A guest who isn't paying: ask a manager to cancel it; otherwise it is released at its time and its items go back to stock.",
                )}
          </p>
        )}
        <ul className="counter-order__awaiting-list">
          {shown.map((order) => {
            const payBy = order.counter?.payBy ?? "";
            const batch = order.batches[0];
            return (
              <li key={order.orderReference}>
                <p className="counter-order__awaiting-title">
                  <strong>{t("Order {orderNumber}", { orderNumber: order.orderNumber })}</strong>{" "}
                  <span className="bop-muted">
                    {t("sent {submittedAt}{value}", {
                      submittedAt: storeTime(order.submittedAt, timeZone),
                      value: order.counter?.recordedAfterOutage ? t(" · paper order") : "",
                    })}
                  </span>
                </p>
                <p className="order-accept-by" data-tier={counterPayByTier(payBy, now)}>
                  {counterPayByText(payBy, timeZone, now)}
                </p>
                {batch === undefined || !order.canRecordCardMachinePayment ? (
                  <p className="bop-muted">{t("Ask a manager to record its payment.")}</p>
                ) : (
                  <StaffRoundPaymentAction
                    subject="order"
                    label={
                      // WP-2423 M96: a paper order was paid during the outage; it is recorded only.
                      order.counter?.recordedAfterOutage
                        ? t("Record the paper order's payment")
                        : t("Charge on card machine")
                    }
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
                    onRecorded={(payment) => {
                      if (payment !== undefined)
                        setRecorded({ orderNumber: order.orderNumber, payment });
                      setReads((value) => value + 1);
                    }}
                  />
                )}
                {/* WP-2423 M127: a guest who isn't paying: cancel it, so its items go back. */}
                {batch !== undefined &&
                order.counter?.canCancelUnpaid === true &&
                order.currentVersion !== null ? (
                  <CounterCancelAction
                    orderReference={order.orderReference}
                    orderBatchReference={batch.orderBatchReference}
                    orderNumber={order.orderNumber}
                    expectedOrderVersion={order.currentVersion}
                    csrf={csrf}
                    {...(fetcher === undefined ? {} : { fetcher })}
                    onCancelled={() => setReads((value) => value + 1)}
                  />
                ) : null}
              </li>
            );
          })}
        </ul>
      </section>
    </>
  );
}
