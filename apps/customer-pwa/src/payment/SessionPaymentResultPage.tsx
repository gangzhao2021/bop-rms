import { t } from "../i18n/i18n.js";
import { orderStatusText } from "../journey/messages.js";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Link } from "react-router";
import { formatCartMoney } from "../cart/format-money.js";
import { CustomerPage, PageHeading, type CustomerStoreContext } from "../journey/CustomerPage.js";
import { createSessionPaymentResultClient } from "./session-payment-result-client.js";
import { createSessionPaymentResultController } from "./session-payment-result-controller.js";
import { useCheckoutReturn } from "./checkout-return.js";
import { RetryCardPanel } from "./RetryCardPanel.js";
import { ResumePaymentPanel } from "./ResumePaymentPanel.js";
import { RestoreDishesPanel } from "./RestoreDishesPanel.js";
import { paymentConfiguration } from "./payment-configuration.js";
import { createHttpOrderStatusClient } from "../order-status/order-status-client.js";
import type { CustomerOrderStatusClient } from "../order-status/order-status-controller.js";
import {
  createRoundKitchenWatch,
  paidIntroText,
  type RoundKitchenState,
} from "./round-kitchen-state.js";

/** Pending and unknown results are re-checked with a growing delay, up to this many times. */
export const paymentResultPollDelaysMs = [3_000, 5_000, 8_000, 13_000, 21_000, 30_000] as const;
export const paymentResultPollLimit = 12;

/**
 * WP-2423: once the payment is confirmed, whether staff have sent the paid round to the kitchen,
 * re-checked until they have. Null when there is no confirmed payment naming its round.
 */
function usePaidRoundKitchenState(
  client: CustomerOrderStatusClient,
  orderReference: string | null,
  orderBatchReference: string | null,
): RoundKitchenState | null {
  const [watched, setWatched] = useState<{ key: string; state: RoundKitchenState } | null>(null);
  const key =
    orderReference === null || orderBatchReference === null
      ? null
      : orderReference + "/" + orderBatchReference;
  useEffect(() => {
    if (orderReference === null || orderBatchReference === null || key === null) return;
    return createRoundKitchenWatch({
      client,
      orderReference,
      orderBatchReference,
      onChange: (state) => setWatched({ key, state }),
    });
  }, [client, key, orderReference, orderBatchReference]);
  if (key === null) return null;
  return watched?.key === key ? watched.state : "Checking";
}

export function SessionPaymentResultPage({
  store,
  orderStatusClient,
}: {
  readonly store?: CustomerStoreContext | undefined;
  /** The customer order status read used to tell whether the paid round reached the kitchen. */
  readonly orderStatusClient?: CustomerOrderStatusClient;
}) {
  const [controller] = useState(() =>
    createSessionPaymentResultController(createSessionPaymentResultClient()),
  );
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getState,
    controller.getState,
  );
  useEffect(() => {
    void controller.load();
    const offline = () => controller.setOnline(false),
      online = () => controller.setOnline(true);
    window.addEventListener("offline", offline);
    window.addEventListener("online", online);
    return () => {
      window.removeEventListener("offline", offline);
      window.removeEventListener("online", online);
    };
  }, [controller]);
  const result = state.status === "ready" ? state.result : null;
  const [statusClient] = useState(() => orderStatusClient ?? createHttpOrderStatusClient());
  const kitchen = usePaidRoundKitchenState(
    statusClient,
    result?.status === "Succeeded" ? result.orderReference : null,
    result?.status === "Succeeded" ? (result.orderBatchReference ?? null) : null,
  );
  const [configuration] = useState(paymentConfiguration);
  const refresh =
    state.status === "unknown" ||
    (result?.status === "Pending" && result.paymentIntentReference !== null) ||
    result?.status === "Unknown";
  const [polls, setPolls] = useState(0);
  useEffect(() => {
    if (!refresh || polls >= paymentResultPollLimit) return;
    const delay = paymentResultPollDelaysMs[Math.min(polls, paymentResultPollDelaysMs.length - 1)];
    const timer = window.setTimeout(() => {
      setPolls((count) => count + 1);
      void controller.refresh();
    }, delay);
    return () => window.clearTimeout(timer);
  }, [controller, polls, refresh]);
  const unknown = state.status === "unknown" || result?.status === "Unknown";
  const unprepared = result?.status === "Pending" && result.paymentIntentReference === null;
  // WP-2423 item 2: this checkout's dishes may already be an unpaid round on the table page.
  const back = useCheckoutReturn(unprepared, store?.serviceMode === "DineIn");
  // WP-2423 abandoned payment: a payment never finished (cancelled when its time ran out).
  const notCompleted = result?.status === "Failed" && result.failure === "NotCompleted";
  // v15 batch-5: the round's payer stopped it before paying; its dishes are back in the cart.
  const stopped = result?.status === "Failed" && result.failure === "StoppedByGuest";
  // v15 b15: the restaurant cancelled the round before it was paid; nothing was charged.
  const cancelled = result?.status === "Failed" && result.failure === "CancelledByStaff";
  // WP-2423 M03: a pickup order empties its cart when it is placed, so once a payment started
  // there is no checkout to go back to (going back must never pay the same dishes twice).
  const pickup = store?.serviceMode !== "DineIn";
  // The guest who started this payment can finish it here while its time is open.
  const resumable =
    result?.status === "Pending" &&
    result.paymentIntentReference !== null &&
    result.payBy !== null &&
    Date.parse(result.payBy) > Date.now();
  const heading =
    state.status === "loading"
      ? t("Verifying payment")
      : state.status === "missing" || state.status === "denied"
        ? t("Payment result not found")
        : state.status === "offline"
          ? t("Connection required")
          : unknown
            ? t("Payment result unknown")
            : unprepared
              ? t("Your payment hasn’t started")
              : result?.status === "Pending"
                ? t("Payment not confirmed yet")
                : result?.status === "Succeeded"
                  ? t("Payment confirmed")
                  : stopped
                    ? t("Payment stopped")
                    : cancelled
                      ? t("Round cancelled")
                      : notCompleted
                        ? t("Payment not finished")
                        : result?.status === "Failed"
                          ? t("Payment declined")
                          : t("Payment result not found");
  const badge = unknown
    ? t("Status not confirmed")
    : notCompleted || unprepared || stopped || cancelled
      ? t("Not charged")
      : result?.status === "Failed"
        ? t("Declined")
        : result?.status === "Succeeded"
          ? t("Paid")
          : result?.status === "Pending"
            ? t("Pending")
            : state.status === "loading"
              ? t("Checking")
              : state.status === "offline"
                ? t("Offline")
                : t("Not found");
  const badgeTone = unknown
    ? "warning"
    : stopped || cancelled
      ? "neutral"
      : result?.status === "Failed"
        ? "danger"
        : result?.status === "Succeeded"
          ? "success"
          : result?.status === "Pending"
            ? "pending"
            : "neutral";
  const alert =
    state.status === "missing" ||
    state.status === "denied" ||
    state.status === "offline" ||
    unknown ||
    (result?.status === "Failed" && !stopped && !cancelled);
  return (
    <CustomerPage
      step="payment"
      store={store}
      orderReference={
        result?.status === "Succeeded" ? (result.orderReference ?? undefined) : undefined
      }
      className="payment-page payment-result-page"
    >
      <PageHeading title={t("Check your payment")}>
        <p className="payment-result-page__intro" aria-live="polite">
          {unknown
            ? t("The payment result is still being confirmed.")
            : stopped
              ? orderStatusText.roundWithdrawnUnpaid
              : cancelled
                ? t("The restaurant cancelled this round before it was paid. Nothing was charged.")
                : notCompleted
                  ? t(
                      "This payment wasn’t finished in time, so it was cancelled. Nothing was charged.",
                    )
                  : result?.status === "Failed"
                    ? t("Your card was declined. Nothing was charged.")
                    : result?.status === "Succeeded"
                      ? paidIntroText(kitchen)
                      : t("Payment details come from your current checkout.")}
        </p>
      </PageHeading>
      <ol className="checkout-progress" aria-label={t("Checkout progress")}>
        <li>{t("Review")}</li>
        <li>{t("Pay")}</li>
        <li aria-current="step">{t("Done")}</li>
      </ol>
      <section className="payment-result-page__card" aria-labelledby="payment-result-heading">
        <span className="payment-result-page__badge" data-tone={badgeTone}>
          {badge}
        </span>
        <h2 id="payment-result-heading">{heading}</h2>
        <div role={alert ? "alert" : "status"} className="payment-result-page__message">
          {state.status === "loading" ? <p>{t("Verifying payment…")}</p> : null}
          {state.status === "missing" ? (
            <p>
              {t(
                "This payment cannot be identified in this window. Contact the store to check your payment before paying again.",
              )}
            </p>
          ) : null}
          {state.status === "denied" ? (
            <p>
              {t(
                "This payment can’t be shown on this phone right now. Contact the store to check its status.",
              )}
            </p>
          ) : null}
          {state.status === "offline" ? (
            <p>{t("Reconnect to check your payment. Nothing will restart automatically.")}</p>
          ) : null}
          {unknown ? (
            <>
              <p>{t("Neither success nor failure is confirmed.")}</p>
              <p>{t("Check the same payment; do not submit another.")}</p>
            </>
          ) : null}
          {unprepared ? (
            <>
              <p>
                {t(
                  "This order hasn’t been charged. Go back to check out again, or ask a staff member.",
                )}
              </p>
              {back === "table-saved" ? (
                <p>
                  {t("Your dishes are saved on your table page and go to the kitchen once paid.")}
                </p>
              ) : null}
            </>
          ) : null}
          {result?.status === "Pending" && !unprepared ? (
            <p>
              {resumable
                ? t(
                    "If you already entered your card, the result shows here shortly. If you left before paying, finish paying below — you won’t be charged twice.",
                  )
                : t("Your payment is still being confirmed. Don’t start another payment.")}
            </p>
          ) : null}
          {cancelled ? (
            <p>{t("It wasn’t sent to the kitchen. Ask staff if you still want it.")}</p>
          ) : null}
          {notCompleted && !pickup ? (
            <p>{t("It wasn’t sent to the kitchen. Ask staff if you still want it.")}</p>
          ) : null}
          {notCompleted && pickup ? <p>{t("It wasn’t sent to the kitchen.")}</p> : null}
          {stopped ? (
            <Link className="cart-primary-link" to="/cart">
              {t("Go to your cart")}
            </Link>
          ) : null}
          {result?.status === "Succeeded" ? (
            <>
              {result.total ? (
                <p>
                  {t("Paid:")} <strong>{formatCartMoney(result.total)}</strong>
                </p>
              ) : null}
              {result.orderReference ? (
                <Link
                  className="payment-result-page__order"
                  to={"/orders/" + result.orderReference}
                >
                  {t("View order status")}
                </Link>
              ) : null}
            </>
          ) : null}
          {result?.status === "Failed" && !notCompleted && !stopped && !cancelled ? (
            <p>
              {t("Your card was declined. Try another card or ask staff to pay at the counter.")}
            </p>
          ) : null}
        </div>
        {resumable && result ? (
          <ResumePaymentPanel
            checkoutSessionReference={result.checkoutSessionReference}
            total={result.total}
            payBy={result.payBy}
            configuration={configuration}
            online={state.status !== "offline"}
            onSettled={() => void controller.refresh()}
          />
        ) : null}
        {notCompleted && pickup && result?.orderReference ? (
          <RestoreDishesPanel orderReference={result.orderReference} />
        ) : null}
        {result?.status === "Failed" && !notCompleted && !stopped && !cancelled ? (
          <RetryCardPanel
            checkoutSessionReference={result.checkoutSessionReference}
            total={result.total}
            configuration={configuration}
            online={state.status !== "offline"}
            onSettled={() => void controller.refresh()}
          />
        ) : null}
        {refresh ? (
          <>
            <p className="payment-result-page__polling" role="status">
              {polls < paymentResultPollLimit
                ? t("Checking again automatically…")
                : t("Automatic checks stopped. Check again or contact the store.")}
            </p>
            <button
              type="button"
              className="payment-result-page__refresh"
              onClick={() => void controller.refresh()}
            >
              {t("Check payment status")}
            </button>
          </>
        ) : null}
      </section>
      {unprepared && back !== "cart" ? (
        <Link className="payment-result-page__back cart-primary-link" to="/dine-in/session">
          {back === "table-saved" ? t("See your table") : t("Back to your table")}
        </Link>
      ) : pickup && !unprepared && result !== null ? (
        <Link className="payment-result-page__back" to="/menu">
          {t("Back to menu")}
        </Link>
      ) : !pickup && !unprepared && result !== null ? (
        // WP-2423 M113: a table's payment has a result; the way on is the table, not checkout.
        <Link className="payment-result-page__back" to="/dine-in/session">
          {t("See your table")}
        </Link>
      ) : (
        <Link
          className={"payment-result-page__back" + (unprepared ? " cart-primary-link" : "")}
          to="/checkout"
        >
          {t("Back to checkout")}
        </Link>
      )}
    </CustomerPage>
  );
}
