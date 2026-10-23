import { t } from "../i18n/i18n.js";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Link, useParams } from "react-router";
import {
  createReceiptController,
  createUnavailableReceiptClient,
  type ReceiptController,
} from "./receipt-controller.js";
import type {
  ReceiptMoneyView,
  ReceiptRecordView,
  ReceiptRefundView,
  ReceiptView,
} from "./types.js";

import { CustomerPage, PageHeading, type CustomerStoreContext } from "../journey/CustomerPage.js";
import {
  describeChosenOption,
  endSentence,
  formatDateTime,
  formatLocalityLine,
  formatMoney,
} from "../journey/format.js";
import { StoreContactCard } from "../journey/StoreContact.js";
import { PrivacyNoticeLink } from "../journey/PrivacyNotice.js";

function money(value: ReceiptMoneyView): string {
  return formatMoney(value.amountMinor, value.currencyCode);
}

/** Customer words for the payment state, never the internal code. */
const paymentStatusText: Record<ReceiptRecordView["snapshot"]["paymentStatus"], string> = {
  get Paid() {
    return t("Paid");
  },
  get RefundPending() {
    return t("Refund in progress");
  },
  get PartiallyRefunded() {
    return t("Partly refunded");
  },
  get Refunded() {
    return t("Refunded");
  },
};
/**
 * The receipt prints the tax name the Store's tax configuration gives each tax ("HST", "GST",
 * "PST", "QST"). The internal test configuration's placeholder "SYNTHETIC TAX" is not a real tax,
 * so it is shown as a labelled test value instead of looking like one.
 */
export function receiptTaxLabel(label: string): string {
  return /^SYNTHETIC(?: |$)/u.test(label) ? t("Test tax (internal testing only)") : label;
}

/**
 * Why a later receipt version was issued, in the guest's words. A reason without a reviewed wording
 * is left out (the version heading already says what changed) instead of showing its code.
 */
export const receiptReasonText: Readonly<Record<string, string>> = {
  get ORDER_ADDITIONAL_PAYMENT_CAPTURED() {
    return t("An additional payment was added to this order.");
  },
  get PAYMENT_REFUND_STATUS_CHANGED() {
    return t("A refund on this order was updated.");
  },
};

/** WP-2423 (v15 3cd0f8dd M4): what kind of refund each stated refund is, in the guest's words. */
export const receiptRefundKindText: Record<ReceiptRefundView["kind"], string> = {
  get Refund() {
    return t("Refund");
  },
  get ItemCancellation() {
    return t("Cancelled items");
  },
  get RoundRefund() {
    return t("Refunded in full");
  },
  get Other() {
    return t("Refund");
  },
};

/**
 * WP-2423 (v15 3cd0f8dd M4): a refund version states every confirmed refund to date — the items,
 * tax and tip each returned — then what was refunded in total and what the order cost after it.
 */
function ReceiptRefunds({
  snapshot,
  version,
}: {
  readonly snapshot: ReceiptRecordView["snapshot"];
  readonly version: number;
}) {
  const refunds = snapshot.refunds;
  if (!refunds || refunds.length === 0) return null;
  const currencyCode = snapshot.total.currencyCode;
  return (
    <section
      className="receipt-page__refunds"
      aria-labelledby={`receipt-version-${version}-refunds`}
    >
      <h3 id={`receipt-version-${version}-refunds`}>{t("What was refunded")}</h3>
      {refunds.map((refund, index) => (
        <div className="receipt-page__refund" key={index}>
          <p>
            <strong>{receiptRefundKindText[refund.kind]}</strong>
            {refund.newInThisVersion ? t(" · new on this version") : ""}
          </p>
          {refund.lines.length > 0 ? (
            <ul className="receipt-page__lines">
              {refund.lines.map((line) => (
                <li key={line.lineReference}>
                  <span>
                    {line.quantity} × {line.displayName}
                  </span>
                  <span>{money(line.amount)}</span>
                </li>
              ))}
            </ul>
          ) : null}
          <dl className="receipt-page__totals">
            {refund.tax.amountMinor > 0n ? (
              <div>
                <dt>{t("Tax")}</dt>
                <dd>{money(refund.tax)}</dd>
              </div>
            ) : null}
            {refund.tip.amountMinor > 0n ? (
              <div>
                <dt>{t("Tip")}</dt>
                <dd>{money(refund.tip)}</dd>
              </div>
            ) : null}
            {refund.other.amountMinor > 0n ? (
              <div>
                <dt>{refund.lines.length > 0 ? t("Fees") : t("Amount")}</dt>
                <dd>{money(refund.other)}</dd>
              </div>
            ) : null}
            <div>
              <dt>{t("Refunded")}</dt>
              <dd>{money(refund.total)}</dd>
            </div>
          </dl>
        </div>
      ))}
      <dl className="receipt-page__totals">
        <div>
          <dt>{t("Refunded in total")}</dt>
          <dd>{money(snapshot.refundedTotal)}</dd>
        </div>
        <div>
          <dt>{t("Total after refunds")}</dt>
          <dd>
            {money({
              amountMinor: snapshot.total.amountMinor - snapshot.refundedTotal.amountMinor,
              currencyCode,
            })}
          </dd>
        </div>
      </dl>
    </section>
  );
}

/** Why this version was issued, in the guest's words (null when there is no reviewed wording). */
export function receiptVersionReason(record: ReceiptRecordView): string | null {
  // WP-2423 (v15 3cd0f8dd M4): a refund version that states a new refund says so plainly.
  if (record.kind === "Refund" && record.snapshot.refunds?.some((entry) => entry.newInThisVersion))
    return t("A refund was made to your original payment.");
  return record.reasonCode ? (receiptReasonText[record.reasonCode] ?? null) : null;
}

const kindText: Record<ReceiptRecordView["kind"], string> = {
  get Original() {
    return t("Receipt");
  },
  get Correction() {
    return t("Corrected receipt");
  },
  get Void() {
    return t("Voided");
  },
  get Refund() {
    return t("Refund");
  },
  get Reissue() {
    return t("Reissued receipt");
  },
};

/**
 * WP-2423 D5: a receipt prints each item's price before tax, then the subtotal and each tax. Versions
 * issued before item prices were frozen only hold each item's total after tax and fees; they are
 * printed as issued, with a note so the item amounts are not mistaken for pre-tax prices.
 */
export function receiptLineAmount(
  line: ReceiptRecordView["snapshot"]["lines"][number],
): ReceiptMoneyView {
  return line.lineSubtotal ?? line.lineTotal;
}

export function receiptLinesIncludeTax(snapshot: ReceiptRecordView["snapshot"]): boolean {
  return (
    snapshot.lines.some((line) => line.lineSubtotal === undefined) &&
    snapshot.tax.amountMinor +
      (snapshot.adjustments?.fee.amountMinor ?? 0n) +
      (snapshot.adjustments?.discount.amountMinor ?? 0n) >
      0n
  );
}

function ReceiptVersion({ record }: { readonly record: ReceiptRecordView }) {
  const snapshot = record.snapshot;
  return (
    <article
      className="receipt-page__version"
      aria-labelledby={`receipt-version-${record.version}`}
    >
      <h2 id={`receipt-version-${record.version}`}>
        {t("Version")} {record.version}: {kindText[record.kind]}
      </h2>
      <p>
        {t("Recorded")} {formatDateTime(record.recordedAt, snapshot.locale)}
      </p>
      {receiptVersionReason(record) ? (
        <p>
          {t("Reason:")} {receiptVersionReason(record)}
        </p>
      ) : null}
      <ul className="receipt-page__lines">
        {snapshot.lines.map((line) => (
          <li key={line.lineReference}>
            <span>
              {line.quantity} × {line.displayName}
              {/* WP-2423: each chosen option and what it added (part of the item's price). */}
              {line.options?.map((option, index) => (
                <span className="receipt-page__option" key={index}>
                  {describeChosenOption(option)}
                </span>
              ))}
            </span>
            <span>{money(receiptLineAmount(line))}</span>
          </li>
        ))}
      </ul>
      {receiptLinesIncludeTax(snapshot) ? (
        <p className="receipt-page__lines-note">
          {t("Item amounts on this version already include tax and any fees or discounts.")}
        </p>
      ) : null}
      <dl className="receipt-page__totals">
        {snapshot.adjustments ? (
          <>
            <div>
              <dt>{t("Discount")}</dt>
              <dd>{money(snapshot.adjustments.discount)}</dd>
            </div>
            <div>
              <dt>{t("Fees")}</dt>
              <dd>{money(snapshot.adjustments.fee)}</dd>
            </div>
          </>
        ) : null}
        <div>
          <dt>{t("Subtotal")}</dt>
          <dd>{money(snapshot.subtotal)}</dd>
        </div>
        {/* WP-2423 Q15: each tax type and rate on its own line, from the order's tax snapshot. */}
        {snapshot.taxDetails && snapshot.taxDetails.taxLines.length > 0 ? (
          snapshot.taxDetails.taxLines.map((line) => (
            <div key={line.label + line.ratePercent + String(line.included)}>
              <dt>
                {receiptTaxLabel(line.label)} {line.ratePercent}%
                {line.included ? t(" (included in prices)") : ""}
              </dt>
              <dd>{money(line.amount)}</dd>
            </div>
          ))
        ) : (
          <div>
            <dt>{t("Tax")}</dt>
            <dd>{money(snapshot.tax)}</dd>
          </div>
        )}
        <div>
          <dt>{t("Tip")}</dt>
          <dd>{money(snapshot.tip)}</dd>
        </div>
        <div>
          <dt>{t("Total")}</dt>
          <dd>{money(snapshot.total)}</dd>
        </div>
        <div>
          <dt>{t("Payment")}</dt>
          <dd>
            {snapshot.taxDetails?.paymentMethod === "Card" ? t("Card · ") : ""}
            {paymentStatusText[snapshot.paymentStatus]}
          </dd>
        </div>
        <div>
          <dt>{t("Refunded")}</dt>
          <dd>{money(snapshot.refundedTotal)}</dd>
        </div>
      </dl>
      <ReceiptRefunds snapshot={snapshot} version={record.version} />
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
      {/* WP-2423 (v15 3cd0f8dd M5): the visit ended; the receipt is still here, read only. */}
      {view.visitEnded ? (
        <section className="receipt-page__state" role="status">
          <h2>{t("Your visit has ended")}</h2>
          <p>
            {t("You can still view and save this receipt on this phone until")}{" "}
            {endSentence(formatDateTime(view.visitEnded.receiptAvailableUntil, current.locale))}
          </p>
        </section>
      ) : null}
      <section className="receipt-page__merchant" aria-labelledby="receipt-merchant-heading">
        <h2 id="receipt-merchant-heading">{t("Merchant and order")}</h2>
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
            {registration.label} {t("registration no.")} {registration.number}
          </p>
        ))}
        <p>
          {t("Order")} {current.orderNumber}
        </p>
        <p>
          {t("Issued")} {formatDateTime(current.issuedAt, current.locale)}
        </p>
      </section>
      <section className="receipt-page__financial" aria-labelledby="receipt-financial-heading">
        <h2 id="receipt-financial-heading">{t("Payment and refunds")}</h2>
        {financial ? (
          <>
            <p>
              {t("Last checked")} {formatDateTime(financial.observedAt, current.locale)}
            </p>
            <dl className="receipt-page__totals">
              <div>
                <dt>{t("Paid")}</dt>
                <dd>
                  {money({
                    amountMinor: financial.capturedMinor,
                    currencyCode: financial.currencyCode,
                  })}
                </dd>
              </div>
              {/* WP-2423 (v15 3cd0f8dd H1): a table that paid rounds both ways sees each. */}
              {financial.paidOnCardMachineMinor !== undefined &&
              financial.paidOnCardMachineMinor > 0n ? (
                <>
                  <div>
                    <dt>{t("Paid online")}</dt>
                    <dd>
                      {money({
                        amountMinor: financial.paidOnlineMinor ?? 0n,
                        currencyCode: financial.currencyCode,
                      })}
                    </dd>
                  </div>
                  <div>
                    <dt>{t("Paid on the store’s card machine")}</dt>
                    <dd>
                      {money({
                        amountMinor: financial.paidOnCardMachineMinor,
                        currencyCode: financial.currencyCode,
                      })}
                    </dd>
                  </div>
                </>
              ) : null}
              <div>
                <dt>{t("Confirmed refunds")}</dt>
                <dd>
                  {money({
                    amountMinor: financial.confirmedRefundMinor,
                    currencyCode: financial.currencyCode,
                  })}
                </dd>
              </div>
              <div>
                <dt>{t("Pending refunds")}</dt>
                <dd>
                  {money({
                    amountMinor: financial.pendingRefundMinor,
                    currencyCode: financial.currencyCode,
                  })}
                </dd>
              </div>
            </dl>
            <p>{t("Pending refunds are not confirmed refunds.")}</p>
            {financial.unresolvedAttemptCount > 0 ? (
              <p role="status">{t("Some payment attempts still need a final result.")}</p>
            ) : null}
          </>
        ) : (
          <p>
            {online
              ? t(
                  "Payment and refund amounts could not be checked just now. Refresh the receipt to try again.",
                )
              : t("Payment and refund amounts can't be checked while you're offline.")}
          </p>
        )}
      </section>
      <section className="receipt-page__history" aria-labelledby="receipt-history-heading">
        <h2 id="receipt-history-heading">{t("Receipt history")}</h2>
        {view.records.map((record) => (
          <ReceiptVersion key={record.recordReference} record={record} />
        ))}
      </section>
      {/* WP-2423 Q10: how to reach the Store, instead of internal delivery/support codes. */}
      {view.storeContact ? (
        <StoreContactCard contact={view.storeContact} storeName={current.storeDisplayName} />
      ) : (
        <section className="store-contact" aria-labelledby="store-contact-heading">
          <h2 id="store-contact-heading">{t("Questions about this order?")}</h2>
          <p>
            {t("Ask a staff member at")} {current.storeDisplayName}.
          </p>
        </section>
      )}
      {/* WP-2423 Q16: the Store's own privacy notice, only once its Owner has entered one. */}
      {view.privacyNoticeUrl ? (
        <p className="receipt-page__privacy">
          {t("How")} {current.storeDisplayName} {t("handles your contact details:")}{" "}
          <PrivacyNoticeLink url={view.privacyNoticeUrl} />
        </p>
      ) : null}
      <section className="receipt-page__action-card" aria-labelledby="receipt-actions-heading">
        <h2 id="receipt-actions-heading">{t("Keep a copy")}</h2>
        <div className="receipt-page__actions">
          {/* Emailing a receipt appears only once the store's email account is connected. */}
          <button type="button" onClick={() => window.print()}>
            {t("Print or save receipt")}
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
    loading: [t("Loading receipt"), t("Retrieving your receipt.")],
    "invalid-reference": [
      t("Receipt link is invalid"),
      t("Use the exact link supplied for this order."),
    ],
    // WP-2423 Q10: the visit on this phone ended; say so and point to the counter.
    // WP-2423 (v15 3cd0f8dd M5): receipts stay readable for 24 hours after the visit started.
    "permission-denied": [
      t("This receipt is no longer available on this phone"),
      t(
        "Receipts stay available on the phone that ordered for 24 hours after the visit started. Ask a staff member for a copy.",
      ),
    ],
    // WP-2423 (f5ae43a5 low): no receipt for this order on this phone (another guest's order,
    // or none issued yet), said plainly.
    "not-found": [
      t("Receipt not found"),
      t(
        "There’s no receipt for this order on this phone. A receipt shows on the phone that placed the order once it’s paid. Ask a staff member if you need a copy.",
      ),
    ],
    "feature-disabled": [t("Digital receipt is disabled"), t("Contact the Store for support.")],
    unavailable: [
      t("We couldn’t load your receipt"),
      t("Try again later or ask a staff member for help."),
    ],
  };
  const message = messages[state.status];
  return (
    <CustomerPage
      step="receipt"
      store={store}
      orderReference={orderReference}
      className="receipt-page"
    >
      <PageHeading title={t("Receipt")} />
      <div className="receipt-page__toolbar">
        <Link to={`/orders/${orderReference}`}>{t("Back to order status")}</Link>
        <button
          type="button"
          disabled={state.status !== "ready" && state.status !== "unavailable"}
          onClick={() => void controller.load()}
        >
          {t("Refresh receipt")}
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
            <h2>{t("You’re offline")}</h2>
            <p>
              {view
                ? t("Showing the receipt already loaded on this page.")
                : t("No receipt is available on this page yet.")}{" "}
              {t("Reconnect to refresh.")}
            </p>
          </section>
        ) : null}
        {view ? <ReceiptContent view={view} online={state.status === "ready"} /> : null}
      </div>
    </CustomerPage>
  );
}
