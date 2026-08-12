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

function ReceiptContent({ view }: { readonly view: ReceiptView }) {
  const current = view.records.at(-1)?.snapshot;
  if (!current) return null;
  return (
    <>
      <section aria-labelledby="receipt-merchant-heading">
        <h2 id="receipt-merchant-heading">Merchant and order</h2>
        <p>{current.operatingEntityDisplayName}</p>
        <p>{current.storeDisplayName}</p>
        <p>Order {current.orderNumber}</p>
        <p>Issued {new Date(current.issuedAt).toLocaleString(current.locale)}</p>
      </section>
      {view.freshnessStatus === "Stale" ? (
        <section role="status">
          <h2>Receipt status may be delayed</h2>
        </section>
      ) : null}
      <section aria-labelledby="receipt-history-heading">
        <h2 id="receipt-history-heading">Immutable receipt history</h2>
        {view.records.map((record) => (
          <ReceiptVersion key={record.recordReference} record={record} />
        ))}
      </section>
      <section aria-labelledby="receipt-delivery-heading">
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
        <button type="button" onClick={() => window.print()}>
          Print receipt
        </button>
        <button type="button" disabled title="Transactional email delivery is not active yet">
          Request email receipt
        </button>
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
    unavailable: [
      "Receipt is unavailable",
      "The receipt adapter is not active. No request was retried.",
    ],
  };
  const message = messages[state.status];
  return (
    <main id="main-content" className="receipt-page">
      <header>
        <p className="cart-page__eyebrow">Digital receipt</p>
        <h1>Your receipt</h1>
        <p>This versioned record preserves the transaction facts issued for your order.</p>
      </header>
      {message ? (
        <section role={state.status === "loading" ? "status" : "alert"}>
          <h2>{message[0]}</h2>
          <p>{message[1]}</p>
        </section>
      ) : null}
      {state.status === "offline" ? (
        <section role="status">
          <h2>Offline read-only</h2>
          <p>
            {view
              ? "Showing the receipt already accepted on this page."
              : "No accepted receipt is available on this page."}{" "}
            Reconnecting does not submit an action.
          </p>
        </section>
      ) : null}
      {view ? <ReceiptContent view={view} /> : null}
      <Link to={`/orders/${orderReference}`}>Back to order status</Link>
    </main>
  );
}
