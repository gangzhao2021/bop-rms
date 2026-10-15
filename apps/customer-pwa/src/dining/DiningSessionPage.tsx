import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { CustomerPage, PageHeading, type CustomerStoreContext } from "../journey/CustomerPage.js";
import { endSentence, formatClockTime, formatMoney } from "../journey/format.js";
import { staffCancellationReasonText } from "../order-status/OrderStatusPage.js";
import {
  createHttpDiningSessionClient,
  DiningSessionClientError,
  type DiningMoney,
  type DiningRound,
  type DiningRoundPayment,
  type DiningRoundStatus,
  type DiningSessionClient,
  type DiningSessionView,
} from "./dining-session-client.js";

/** How often the table view re-reads while something at the table is still in progress. */
export const diningSessionPollIntervalMs = 15_000;

const statusText: Readonly<Record<DiningRoundStatus, string>> = {
  AwaitingPayment: "Waiting for payment",
  PaymentFailed: "On hold until paid",
  NotPaidCancelled: "Cancelled — payment didn't go through",
  StoreCancelled: "Cancelled by the store",
  Received: "Received by the store",
  Queued: "Sent to the kitchen",
  Preparing: "Being prepared",
  Ready: "Ready — on its way to your table",
  Serving: "Being served",
  Served: "Served",
};
const paymentText: Readonly<Record<DiningRoundPayment, string>> = {
  Paid: "Paid",
  Awaiting: "Not paid yet",
  Failed: "Payment failed",
  NotCharged: "Not charged",
  Refunded: "Refunded",
  RefundPending: "Refund on its way",
};
/** WP-2423 Q7 slice 2: who ordered a round, in the guest's words (never a staff name). */
const orderedByText: Readonly<Record<DiningRound["orderedBy"], string>> = {
  You: "Ordered by you",
  AnotherGuest: "Ordered by another guest",
  Staff: "Entered by staff",
};
const settled: ReadonlySet<DiningRoundStatus> = new Set([
  "NotPaidCancelled",
  "StoreCancelled",
  "Served",
]);

const money = (value: DiningMoney) => formatMoney(value.amountMinor, value.currencyCode);
/** Discounts and fees the items carried (total − subtotal − tax), or null when there are none. */
function adjustments(total: DiningMoney, subtotal: DiningMoney, tax: DiningMoney): string | null {
  const rest = BigInt(total.amountMinor) - BigInt(subtotal.amountMinor) - BigInt(tax.amountMinor);
  return rest === 0n ? null : formatMoney(rest, total.currencyCode);
}

function RoundNote({ round }: { readonly round: DiningRound }) {
  if (round.status === "PaymentFailed")
    return (
      <p className="order-status__warning" role="status">
        {round.cancelsAt
          ? `This round will be cancelled at ${endSentence(formatClockTime(round.cancelsAt))} `
          : ""}
        Ask a staff member if you need help.
      </p>
    );
  if (round.status === "NotPaidCancelled")
    return <p>This round never went to the kitchen. No one was charged for it.</p>;
  if (round.status === "StoreCancelled")
    return (
      <p>
        {round.storeCancellationReason
          ? staffCancellationReasonText[round.storeCancellationReason] + " "
          : ""}
        {round.payment === "Refunded"
          ? "The payment was refunded."
          : "The payment is being refunded to the card that paid."}
      </p>
    );
  if (round.status === "AwaitingPayment")
    return (
      <p>
        {round.orderedBy === "You"
          ? "Finish paying for this round so the kitchen can start it."
          : round.orderedBy === "Staff"
            ? "Staff entered this round for your table. Pay them on the card machine and the kitchen starts it."
            : "The kitchen starts this round once it is paid."}
      </p>
    );
  return null;
}

function RoundCard({ round }: { readonly round: DiningRound }) {
  const headingId = `dining-round-${round.roundNumber}`;
  return (
    <article className="order-status__card order-status__batch" aria-labelledby={headingId}>
      <h3 id={headingId}>
        Round {round.roundNumber} · {orderedByText[round.orderedBy]}
      </h3>
      <dl className="dining-session__round-facts">
        <div>
          <dt>Ordered at</dt>
          <dd>{formatClockTime(round.submittedAt)}</dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>{statusText[round.status]}</dd>
        </div>
        <div>
          <dt>Payment</dt>
          <dd>{paymentText[round.payment]}</dd>
        </div>
      </dl>
      <RoundNote round={round} />
      <ul>
        {round.items.map((item, index) => (
          <li key={index} className={item.cancelled ? "order-status__item--cancelled" : undefined}>
            <span className="order-status__item-name">
              {item.quantity} × {item.displayName}
            </span>
            <span className="order-status__item-amount">
              {money(item.priceBeforeTax ?? item.lineTotal)}
            </span>
            {item.cancelled ? (
              <span className="order-status__item-cancelled">Cancelled</span>
            ) : item.beingRemade ? (
              <span className="order-status__item-remake">
                Being remade · we&apos;ll bring it to your table shortly
              </span>
            ) : round.payment === "Paid" ? (
              <span>
                Served {item.servedQuantity} of {item.quantity}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
      {/* WP-2423 D5: like the receipt — items before tax, then subtotal, tax and total. */}
      {round.subtotal !== undefined && round.tax !== undefined ? (
        <dl className="order-status__money">
          <div>
            <dt>Subtotal</dt>
            <dd>{money(round.subtotal)}</dd>
          </div>
          {adjustments(round.itemsTotal, round.subtotal, round.tax) ? (
            <div>
              <dt>Discounts and fees</dt>
              <dd>{adjustments(round.itemsTotal, round.subtotal, round.tax)}</dd>
            </div>
          ) : null}
          <div>
            <dt>Tax</dt>
            <dd>{money(round.tax)}</dd>
          </div>
        </dl>
      ) : null}
      <p className="order-status__total">
        <span>{round.subtotal === undefined ? "Round total including tax" : "Round total"}</span>
        <span>{money(round.itemsTotal)}</span>
      </p>
    </article>
  );
}

function TableSummary({ view }: { readonly view: DiningSessionView }) {
  const summary = view.summary;
  if (summary === null) return null;
  const nonZero = (value: DiningMoney) => value.amountMinor !== "0";
  return (
    <section
      className="order-status__card order-status__summary dining-session__summary"
      aria-labelledby="dining-summary-heading"
    >
      <h2 id="dining-summary-heading">Table total</h2>
      {summary.ordered !== undefined ? (
        <dl className="order-status__money">
          <div>
            <dt>Subtotal</dt>
            <dd>{money(summary.ordered.subtotal)}</dd>
          </div>
          {adjustments(summary.ordered.total, summary.ordered.subtotal, summary.ordered.tax) ? (
            <div>
              <dt>Discounts and fees</dt>
              <dd>
                {adjustments(summary.ordered.total, summary.ordered.subtotal, summary.ordered.tax)}
              </dd>
            </div>
          ) : null}
          <div>
            <dt>Tax</dt>
            <dd>{money(summary.ordered.tax)}</dd>
          </div>
          <div>
            <dt>Total ordered</dt>
            <dd>{money(summary.ordered.total)}</dd>
          </div>
        </dl>
      ) : null}
      <dl>
        <div>
          <dt>Paid so far</dt>
          <dd>{money(summary.paid)}</dd>
        </div>
        <div>
          <dt>Waiting for payment</dt>
          <dd>{nonZero(summary.due) ? money(summary.due) : "Nothing"}</dd>
        </div>
        {nonZero(summary.refunded) ? (
          <div>
            <dt>Refunded</dt>
            <dd>{money(summary.refunded)}</dd>
          </div>
        ) : null}
        {nonZero(summary.refundPending) ? (
          <div>
            <dt>Refund on its way</dt>
            <dd>{money(summary.refundPending)}</dd>
          </div>
        ) : null}
      </dl>
      <p>
        {summary.ordered !== undefined
          ? "Item prices are before tax. Rounds that were never paid are not included. "
          : ""}
        Paid amounts include tax and any tip. Amounts waiting for payment include tax, before any
        tip. Each guest pays for the rounds they order.
      </p>
    </section>
  );
}

export type DiningSessionState =
  | { readonly status: "loading" }
  | { readonly status: "not-joined" }
  | {
      readonly status: "unavailable";
      readonly view: DiningSessionView | null;
      readonly offline: boolean;
    }
  | { readonly status: "ready"; readonly view: DiningSessionView; readonly refreshing: boolean };

/** Rounds still moving (or a table with no rounds yet) keep the page re-reading. */
export function isDiningSessionActive(view: DiningSessionView | null): boolean {
  return (
    view !== null &&
    (view.rounds.length === 0 || view.rounds.some((round) => !settled.has(round.status)))
  );
}

export function DiningSessionPage({
  store,
  client: provided,
}: {
  readonly store?: CustomerStoreContext | undefined;
  readonly client?: DiningSessionClient | undefined;
}) {
  const [client] = useState(() => provided ?? createHttpDiningSessionClient());
  const [state, setState] = useState<DiningSessionState>({ status: "loading" });
  const pending = useRef<AbortController | null>(null);
  const load = useCallback(async () => {
    if (pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setState((prior) =>
      prior.status === "ready"
        ? { ...prior, refreshing: true }
        : prior.status === "unavailable"
          ? prior
          : { status: "loading" },
    );
    try {
      const view = await client.load(controller.signal);
      if (!controller.signal.aborted) setState({ status: "ready", view, refreshing: false });
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof DiningSessionClientError && error.code === "not-joined")
        setState({ status: "not-joined" });
      // Keep the last loaded table on screen; say it may be out of date.
      else
        setState((prior) => ({
          status: "unavailable",
          view: prior.status === "ready" || prior.status === "unavailable" ? prior.view : null,
          offline: typeof navigator !== "undefined" && navigator.onLine === false,
        }));
    } finally {
      if (pending.current === controller) pending.current = null;
    }
  }, [client]);
  useEffect(() => {
    void load();
    return () => {
      pending.current?.abort();
      pending.current = null;
    };
  }, [load]);
  const active = isDiningSessionActive(
    state.status === "ready" || state.status === "unavailable" ? state.view : null,
  );
  useEffect(() => {
    if (!active) return;
    const tick = () => {
      if (typeof document === "undefined" || document.visibilityState === "visible") void load();
    };
    const timer = window.setInterval(tick, diningSessionPollIntervalMs);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [active, load]);
  return <DiningSessionScreen state={state} store={store} onRefresh={() => void load()} />;
}

export function DiningSessionScreen({
  state,
  store,
  onRefresh,
}: {
  readonly state: DiningSessionState;
  readonly store?: CustomerStoreContext | undefined;
  readonly onRefresh: () => void;
}) {
  const view = state.status === "ready" || state.status === "unavailable" ? state.view : null;
  const active = isDiningSessionActive(view);
  return (
    <CustomerPage step="table" store={store} className="order-status dining-session">
      <PageHeading
        eyebrow={view?.orderNumber ? `Order ${view.orderNumber}` : undefined}
        title={view?.tableLabel ? `Your table · ${view.tableLabel}` : "Your table"}
      >
        <p>Everything ordered at this table, by you and the other guests.</p>
      </PageHeading>
      {state.status === "loading" ? (
        <section role="status">
          <h2>Loading your table</h2>
        </section>
      ) : null}
      {state.status === "not-joined" ? (
        <section className="order-status__card" role="alert">
          <h2>Join your table first</h2>
          <p>
            Ask a staff member for your table&apos;s code and enter it after scanning the
            table&apos;s QR code. Then you can see what your table has ordered.
          </p>
          <Link className="order-status__back" to="/">
            Go to the start
          </Link>
        </section>
      ) : null}
      {state.status === "unavailable" ? (
        <section className="order-status__unavailable" role="alert">
          <span className="order-status__unavailable-icon" aria-hidden="true">
            !
          </span>
          <h2>{state.offline ? "You\u2019re offline" : "We couldn\u2019t load your table"}</h2>
          <p>
            {view
              ? "Showing what was loaded before. It may be out of date."
              : "Check your connection and try again. A staff member can also tell you what your table has ordered."}
          </p>
          <button className="order-status__retry" type="button" onClick={onRefresh}>
            Try again
          </button>
        </section>
      ) : null}
      {view && view.rounds.length === 0 ? (
        <section className="order-status__card">
          <h2>No one at this table has ordered yet</h2>
          <p>Rounds appear here as soon as someone at your table places an order.</p>
        </section>
      ) : null}
      {view ? <TableSummary view={view} /> : null}
      {view && view.rounds.length > 0 ? (
        <section className="order-status__batches" aria-labelledby="dining-rounds-heading">
          <h2 id="dining-rounds-heading">Rounds</h2>
          {view.rounds.map((round) => (
            <RoundCard key={round.roundNumber} round={round} />
          ))}
        </section>
      ) : null}
      {state.status === "ready" ? (
        <section className="order-status__actions" aria-label="Updates">
          <p>
            {active
              ? "This page checks for updates every few seconds."
              : "Everything at this table is served or closed."}
          </p>
          <button type="button" disabled={state.refreshing} onClick={onRefresh}>
            {state.refreshing ? "Refreshing…" : "Refresh now"}
          </button>
        </section>
      ) : null}
      {view ? (
        <aside className="menu-help" aria-labelledby="dining-help-heading">
          <h2 id="dining-help-heading">Allergies or a problem with your food?</h2>
          <p>Tell a staff member before you eat. They can check any dish for you.</p>
        </aside>
      ) : null}
      <Link className="order-status__back" to="/menu">
        Order more from the menu
      </Link>
    </CustomerPage>
  );
}
