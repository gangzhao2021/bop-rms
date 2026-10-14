import { useEffect, useState, useSyncExternalStore } from "react";
import { Link, useParams } from "react-router";
import {
  createReceiptController,
  createUnavailableReceiptClient,
  type ReceiptController,
} from "./receipt-controller.js";
import type { ReceiptMoneyView, ReceiptRecordView, ReceiptView } from "./types.js";

import { CustomerPage, PageHeading, type CustomerStoreContext } from "../journey/CustomerPage.js";
import { formatDateTime, formatLocalityLine, formatMoney } from "../journey/format.js";
import { StoreContactCard } from "../journey/StoreContact.js";
import { PrivacyNoticeLink } from "../journey/PrivacyNotice.js";

function money(value: ReceiptMoneyView): string {
  return formatMoney(value.amountMinor, value.currencyCode);
}

/** Customer words for the payment state, never the internal code. */
const paymentStatusText: Record<ReceiptRecordView["snapshot"]["paymentStatus"], string> = {
  Paid: "Paid",
  RefundPending: "Refund in progress",
  PartiallyRefunded: "Partly refunded",
  Refunded: "Refunded",
};
/**
 * The receipt prints the tax name the Store's tax configuration gives each tax ("HST", "GST",
 * "PST", "QST"). The internal test configuration's placeholder "SYNTHETIC TAX" is not a real tax,
 * so it is shown as a labelled test value instead of looking like one.
 */
export function receiptTaxLabel(label: string): string {
  return /^SYNTHETIC(?: |$)/u.test(label) ? "Test tax (internal testing only)" : label;
}

const kindText: Record<ReceiptRecordView["kind"], string> = {
  Original: "Receipt",
  Correction: "Corrected receipt",
  Void: "Voided",
  Refund: "Refund",
  Reissue: "Reissued receipt",
};

function ReceiptVersion({ record }: { readonly record: ReceiptRecordView }) {
  const snapshot = record.snapshot;
  return (
    <article
      className="receipt-page__version"
      aria-labelledby={`receipt-version-${record.version}`}
    >
      <h2 id={`receipt-version-${record.version}`}>
        Version {record.version}: {kindText[record.kind]}
      </h2>
      <p>Recorded {formatDateTime(record.recordedAt, snapshot.locale)}</p>
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
        {/* WP-2423 Q15: each tax type and rate on its own line, from the order's tax snapshot. */}
        {snapshot.taxDetails && snapshot.taxDetails.taxLines.length > 0 ? (
          snapshot.taxDetails.taxLines.map((line) => (
            <div key={line.label + line.ratePercent + String(line.included)}>
              <dt>
                {receiptTaxLabel(line.label)} {line.ratePercent}%
                {line.included ? " (included in prices)" : ""}
              </dt>
              <dd>{money(line.amount)}</dd>
            </div>
          ))
        ) : (
          <div>
            <dt>Tax</dt>
            <dd>{money(snapshot.tax)}</dd>
          </div>
        )}
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
          <dd>
            {snapshot.taxDetails?.paymentMethod === "Card" ? "Card · " : ""}
            {paymentStatusText[snapshot.paymentStatus]}
          </dd>
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
        {/* WP-2423 Q15: the address and registrations frozen when the receipt was issued. */}
        {current.taxDetails?.businessAddress ? (
          <address className="receipt-page__address">
            {current.taxDetails.businessAddress.addressLines.map((line) => (
              <span key={line}>{line}</span>
            ))}
            <span>{formatLocalityLine(current.taxDetails.businessAddress)}</span>
          </address>
        ) : null}
        {current.taxDetails?.taxRegistrations.map((registration) => (
          <p key={registration.label}>
            {registration.label} registration no. {registration.number}
          </p>
        ))}
        <p>Order {current.orderNumber}</p>
        <p>Issued {formatDateTime(current.issuedAt, current.locale)}</p>
      </section>
      <section className="receipt-page__financial" aria-labelledby="receipt-financial-heading">
        <h2 id="receipt-financial-heading">Payment and refunds</h2>
        {financial ? (
          <>
            <p>Last checked {formatDateTime(financial.observedAt, current.locale)}</p>
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
            {online
              ? "Payment and refund amounts could not be checked just now. Refresh the receipt to try again."
              : "Payment and refund amounts can't be checked while you're offline."}
          </p>
        )}
      </section>
      <section className="receipt-page__history" aria-labelledby="receipt-history-heading">
        <h2 id="receipt-history-heading">Receipt history</h2>
        {view.records.map((record) => (
          <ReceiptVersion key={record.recordReference} record={record} />
        ))}
      </section>
      {/* WP-2423 Q10: how to reach the Store, instead of internal delivery/support codes. */}
      {view.storeContact ? (
        <StoreContactCard contact={view.storeContact} storeName={current.storeDisplayName} />
      ) : (
        <section className="store-contact" aria-labelledby="store-contact-heading">
          <h2 id="store-contact-heading">Questions about this order?</h2>
          <p>Ask a staff member at {current.storeDisplayName}.</p>
        </section>
      )}
      {/* WP-2423 Q16: the Store's own privacy notice, only once its Owner has entered one. */}
      {view.privacyNoticeUrl ? (
        <p className="receipt-page__privacy">
          How {current.storeDisplayName} handles your contact details:{" "}
          <PrivacyNoticeLink url={view.privacyNoticeUrl} />
        </p>
      ) : null}
      <section className="receipt-page__action-card" aria-labelledby="receipt-actions-heading">
        <h2 id="receipt-actions-heading">Keep a copy</h2>
        <div className="receipt-page__actions">
          {/* Emailing a receipt appears only once the store's email account is connected. */}
          <button type="button" onClick={() => window.print()}>
            Print or save receipt
          </button>
        </div>
      </section>
    </>
  );
}

export function ReceiptPage({
  controller: provided,
  store,
}: {
  readonly controller?: ReceiptController;
  readonly store?: CustomerStoreContext | undefined;
}) {
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
    loading: ["Loading receipt", "Retrieving your receipt."],
    "invalid-reference": ["Receipt link is invalid", "Use the exact link supplied for this order."],
    // WP-2423 Q10: the visit on this phone ended; say so and point to the counter.
    "permission-denied": [
      "Your visit on this phone has ended",
      "This receipt can only be opened while your visit is active. Ask a staff member for a copy.",
    ],
    "not-found": ["Receipt not found", "No authorized receipt was found."],
    "feature-disabled": ["Digital receipt is disabled", "Contact the Store for support."],
    unavailable: ["Receipt is unavailable", "Try again later or ask the Store for help."],
  };
  const message = messages[state.status];
  return (
    <CustomerPage
      step="receipt"
      store={store}
      orderReference={orderReference}
      className="receipt-page"
    >
      <PageHeading title="Receipt" />
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
            <h2>You’re offline</h2>
            <p>
              {view
                ? "Showing the receipt already loaded on this page."
                : "No receipt is available on this page yet."}{" "}
              Reconnect to refresh.
            </p>
          </section>
        ) : null}
        {view ? <ReceiptContent view={view} online={state.status === "ready"} /> : null}
      </div>
    </CustomerPage>
  );
}
