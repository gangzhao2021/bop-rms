import { useEffect, useState, useSyncExternalStore } from "react";
import { Link, useParams } from "react-router";
import {
  createReceiptController,
  createUnavailableReceiptClient,
  type ReceiptController,
} from "./receipt-controller.js";
import type { ReceiptMoneyView, ReceiptRecordView, ReceiptView } from "./types.js";

function money(value: ReceiptMoneyView): string {
  const absolute = value.amountMinor;
  return `${value.currencyCode} ${absolute / 100n}.${(absolute % 100n).toString().padStart(2, "0")}`;
}

function ReceiptVersion({ record }: { readonly record: ReceiptRecordView }) {
  const snapshot = record.snapshot;
  return (
    <article
      className="receipt-page__version"
      aria-labelledby={`receipt-version-${record.version}`}
    >
      <h2 id={`receipt-version-${record.version}`}>
        Version {record.version}: {record.kind}
      </h2>
      <p>Recorded {new Date(record.recordedAt).toLocaleString(snapshot.locale)}</p>
      {record.reasonCode ? <p>Reason: {record.reasonCode.replaceAll("_", " ")}</p> : null}
      <ul className="receipt-page__lines">
        {snapshot.lines.map((line) => (
          <li key={line.lineReference}>
            <span>
              {line.quantity} × {line.displayName}
            </span>
            <span>{money(line.lineTotal)}</span>
          </li>
        ))}
      </ul>
      <dl className="receipt-page__totals">
        {snapshot.adjustments ? (
          <>
            <div>
              <dt>Discount</dt>
              <dd>{money(snapshot.adjustments.discount)}</dd>
            </div>
            <div>
              <dt>Fees</dt>
              <dd>{money(snapshot.adjustments.fee)}</dd>
            </div>
          </>
        ) : null}
        <div>
          <dt>Subtotal</dt>
          <dd>{money(snapshot.subtotal)}</dd>
        </div>
        <div>
          <dt>Tax</dt>
          <dd>{money(snapshot.tax)}</dd>
        </div>
        <div>
          <dt>Tip</dt>
          <dd>{money(snapshot.tip)}</dd>
        </div>
        <div>
          <dt>Total</dt>
          <dd>{money(snapshot.total)}</dd>
        </div>
        <div>
          <dt>Payment</dt>
          <dd>{snapshot.paymentStatus}</dd>
        </div>
        <div>
          <dt>Refunded</dt>
          <dd>{money(snapshot.refundedTotal)}</dd>
        </div>
      </dl>
    </article>
  );
}

function ReceiptContent({
  view,
  online,
}: {
  readonly view: ReceiptView;
  readonly online: boolean;
}) {
  const current = view.records.at(-1)?.snapshot;
  if (!current) return null;
  const financial = online ? view.financial : null;
  return (
    <>
      <section className="receipt-page__merchant" aria-labelledby="receipt-merchant-heading">
        <h2 id="receipt-merchant-heading">Merchant and order</h2>
        <p>{current.operatingEntityDisplayName}</p>
        <p>{current.storeDisplayName}</p>
        <p>Order {current.orderNumber}</p>
        <p>Issued {new Date(current.issuedAt).toLocaleString(current.locale)}</p>
      </section>
      {view.freshnessStatus === "Stale" ? (
        <section className="receipt-page__stale" role="status">
          <h2>Live receipt status is unavailable</h2>
          <p>
            {financial
              ? "The receipt below is saved history. Payment amounts are shown separately; delivery and support status remain unavailable."
              : "The receipt below is saved history. Current payment, delivery and support status is not available here."}
          </p>
        </section>
      ) : null}
      <section className="receipt-page__financial" aria-labelledby="receipt-financial-heading">
        <h2 id="receipt-financial-heading">Payment and refunds</h2>
        {financial ? (
          <>
            <p>
              Checked {new Date(financial.observedAt).toLocaleString(current.locale)}. Refresh to
              check again.
            </p>
            <dl className="receipt-page__totals">
              <div>
                <dt>Captured</dt>
                <dd>
                  {money({
                    amountMinor: financial.capturedMinor,
                    currencyCode: financial.currencyCode,
                  })}
                </dd>
              </div>
              <div>
                <dt>Confirmed refunds</dt>
                <dd>
                  {money({
                    amountMinor: financial.confirmedRefundMinor,
                    currencyCode: financial.currencyCode,
                  })}
                </dd>
              </div>
              <div>
                <dt>Pending refunds</dt>
                <dd>
                  {money({
                    amountMinor: financial.pendingRefundMinor,
                    currencyCode: financial.currencyCode,
                  })}
                </dd>
              </div>
            </dl>
            <p>Pending refunds are not confirmed refunds.</p>
            {financial.unresolvedAttemptCount > 0 ? (
              <p role="status">Some payment attempts still need a final result.</p>
            ) : null}
          </>
        ) : (
          <p>
            Current payment and refund amounts are unavailable{online ? "." : " while offline."}
          </p>
        )}
      </section>
      <section className="receipt-page__history" aria-labelledby="receipt-history-heading">
        <h2 id="receipt-history-heading">Immutable receipt history</h2>
        {view.records.map((record) => (
          <ReceiptVersion key={record.recordReference} record={record} />
        ))}
      </section>
      <section className="receipt-page__support" aria-labelledby="receipt-delivery-heading">
        <h2 id="receipt-delivery-heading">Delivery and support</h2>
        <p>Delivery status: {view.deliveryStatus}</p>
        <p>
          {view.supportEligible
            ? "Support is available for this order."
            : "No support action is currently eligible."}
        </p>
        <p>
          {view.cancellationEligible
            ? "Cancellation may be requested and remains subject to server validation."
            : "Cancellation is not available for this receipt."}
        </p>
      </section>
      <section className="receipt-page__action-card" aria-labelledby="receipt-actions-heading">
        <h2 id="receipt-actions-heading">Receipt actions</h2>
        <div className="receipt-page__actions">
          <button type="button" onClick={() => window.print()}>
            Print receipt
          </button>
          <div className="receipt-page__email-action">
            <button
              type="button"
              disabled
              aria-describedby="receipt-email-unavailable"
              title="Transactional email delivery is not active yet"
            >
              Request email receipt
            </button>
            <p id="receipt-email-unavailable">Transactional email delivery is not active yet.</p>
          </div>
        </div>
      </section>
    </>
  );
}

export function ReceiptPage({ controller: provided }: { readonly controller?: ReceiptController }) {
  const { orderReference = "" } = useParams();
  const [controller] = useState(
    () => provided ?? createReceiptController(orderReference, createUnavailableReceiptClient()),
  );
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getState,
    controller.getState,
  );
  useEffect(() => {
    void controller.load();
    const offline = () => controller.setOnline(false);
    const online = () => controller.setOnline(true);
    window.addEventListener("offline", offline);
    window.addEventListener("online", online);
    return () => {
      window.removeEventListener("offline", offline);
      window.removeEventListener("online", online);
    };
  }, [controller]);
  const view = state.status === "ready" || state.status === "offline" ? state.view : null;
  const messages: Partial<Record<typeof state.status, [string, string]>> = {
    loading: ["Loading receipt", "Retrieving the authorized immutable receipt."],
    "invalid-reference": ["Receipt link is invalid", "Use the exact link supplied for this order."],
    "permission-denied": [
      "Receipt access denied",
      "The order reference alone does not authorize access.",
    ],
    "not-found": ["Receipt not found", "No authorized receipt was found."],
    "feature-disabled": ["Digital receipt is disabled", "Contact the Store for support."],
    unavailable: ["Receipt is unavailable", "Try again later or ask the Store for help."],
  };
  const message = messages[state.status];
  return (
    <main id="main-content" className="receipt-page">
      <header className="receipt-page__header">
        <p className="cart-page__eyebrow">Digital receipt</p>
        <h1>Your receipt</h1>
        <p>This versioned record preserves the transaction facts issued for your order.</p>
      </header>
      <div className="receipt-page__toolbar">
        <Link to={`/orders/${orderReference}`}>Back to order status</Link>
        <button
          type="button"
          disabled={state.status !== "ready" && state.status !== "unavailable"}
          onClick={() => void controller.load()}
        >
          Refresh receipt
        </button>
      </div>
      <div className="receipt-page__content">
        {message ? (
          <section
            className="receipt-page__state"
            role={state.status === "loading" ? "status" : "alert"}
          >
            <h2>{message[0]}</h2>
            <p>{message[1]}</p>
          </section>
        ) : null}
        {state.status === "offline" ? (
          <section className="receipt-page__state" role="status">
            <h2>Offline read-only</h2>
            <p>
              {view
                ? "Showing the receipt already accepted on this page."
                : "No accepted receipt is available on this page."}{" "}
              Reconnecting does not submit an action.
            </p>
          </section>
        ) : null}
        {view ? <ReceiptContent view={view} online={state.status === "ready"} /> : null}
      </div>
    </main>
  );
}
