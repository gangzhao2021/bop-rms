import { t } from "../i18n/i18n.js";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import { manualRetryBusyTotalMs } from "../checkout/checkout-client.js";
import {
  CheckoutSessionClientError,
  createCheckoutSessionClient,
} from "../checkout/session-client.js";
import { DiningStaffCallPanel } from "../dining/DiningStaffCallPanel.js";
import {
  captureCustomerCsrfContext,
  getCheckoutSessionReference,
  getCheckoutTipSelection,
  markCheckoutCardOffered,
  setTablePaymentTiming,
  wasCheckoutCardOffered,
} from "../session/customer-transaction-context.js";
import { formatCartMoney } from "../cart/format-money.js";
import { CustomerPage, PageHeading, type CustomerStoreContext } from "../journey/CustomerPage.js";
import { SlowWaitNote } from "../journey/SlowWaitNote.js";
import {
  createSessionPaymentClient,
  SessionPaymentClientError,
  type SessionPaymentView,
} from "./session-payment-client.js";
import { useCheckoutReturn, type CheckoutReturn } from "./checkout-return.js";
import { paymentResultPollDelaysMs, SessionPaymentResultPage } from "./SessionPaymentResultPage.js";
import {
  createSessionPaymentResultClient,
  type SessionPaymentResult,
} from "./session-payment-result-client.js";
import {
  earlierPaymentDeadline,
  nextPaymentDeadlineChangeMs,
  paymentDeadlinePhase,
  type PaymentDeadline,
  type PaymentDeadlinePhase,
} from "./payment-deadline.js";
import { formatClockTime } from "../journey/format.js";
import { StripeCardForm } from "./StripeCardForm.js";
import { paymentConfiguration } from "./payment-configuration.js";
import { RestoreDishesPanel } from "./RestoreDishesPanel.js";

/**
 * WP-2423 Q10: only a checkout the server no longer recognises ends the payment page; a timeout,
 * outage or other failure keeps the customer here with a retry.
 */
export function checkoutLoadFailureState(error: unknown): "denied" | "retry" {
  return error instanceof CheckoutSessionClientError &&
    (error.code === "denied" || error.code === "invalid" || error.code === "conflict")
    ? "denied"
    : "retry";
}

export type PaymentStartFailureState =
  | "closed"
  | "items_short"
  | "tips_off"
  | "denied"
  | "expired"
  | "start_failed"
  | "unknown"
  /** WP-2423: the restaurant updated its menu after this checkout began; nothing was charged. */
  | "requote_required"
  /** WP-2423 M03: these dishes are already in an order; nothing new was charged. */
  | "already_ordered"
  /** WP-2423: staff moved the table while this round was being sent; nothing was charged. */
  | "table_moved"
  /** The table pays at the end, so nothing here takes payment: back to its cart. */
  | "table_pays_later"
  /** WP-2423 M19: the time to pay ran out before any card was offered; nothing was charged. */
  | "window_ended";

/**
 * WP-2423 item 2: which panel a failed start shows. No money moves before a guest submits the secure
 * card form, so until a card was offered in this tab a failure can say this order wasn't charged.
 * After that it can't, whatever the failure says: "last orders" can be answered while a captured card
 * is still confirming. So once a card was offered, every answer that would claim it leads to the panel
 * that says to check the result first.
 */
export function paymentStartFailureState(
  error: unknown,
  cardOffered: boolean,
): PaymentStartFailureState {
  const code = error instanceof SessionPaymentClientError ? error.code : "unknown";
  if (code === "pay_later_table") return "table_pays_later";
  // The server made no order for this checkout, so no card offered here can have been charged.
  if (code === "already_ordered") return "already_ordered";
  if (code === "denied" || code === "conflict") return "denied";
  if (cardOffered) return "unknown";
  switch (code) {
    case "store_closed":
      return "closed";
    case "items_short":
      return "items_short";
    case "tips_off":
      return "tips_off";
    case "not_ready":
      return "expired";
    case "requote_required":
      return "requote_required";
    case "table_moved":
      return "table_moved";
    case "window_ended":
      return "window_ended";
    case "invalid":
    case "unknown":
      return "start_failed";
    // Already paid, another attempt pending: the page reads the result before offering anything.
    case "already_paid":
    case "retry_pending":
    default:
      return "unknown";
  }
}

/**
 * WP-2423 M17: what an unclear payment turns out to be once its result is read. Only a confirmed
 * "no payment exists" may offer the card again; anything unclear keeps saying "don't pay again".
 */
export type UnknownPaymentResolution =
  /** Paid: the result page shows it. */
  | "paid"
  /** A payment exists (declined, open, or finished): the result page offers the same attempt. */
  | "result"
  /** No payment was ever started for this checkout: continuing is safe. */
  | "not_started"
  /** The result can't be read yet: keep checking, offer nothing. */
  | "checking";
export function resolveUnknownPayment(
  result: Pick<SessionPaymentResult, "status" | "paymentIntentReference"> | null,
): UnknownPaymentResolution {
  if (result === null || result.status === "Unknown") return "checking";
  if (result.status === "Succeeded") return "paid";
  if (result.status === "Failed") return "result";
  return result.paymentIntentReference === null ? "not_started" : "result";
}

/** Back to where this guest's dishes are now (never a screen saying the cart is empty). */
function CheckoutReturnLink({
  to,
  cartPath,
  cartText,
  menuUpdated = false,
}: {
  readonly to: CheckoutReturn;
  readonly cartPath: string;
  readonly cartText: string;
  /** WP-2423 M165: checkout then says it priced the order again because the menu changed. */
  readonly menuUpdated?: boolean;
}) {
  return to === "cart" ? (
    <Link to={cartPath} state={menuUpdated ? { menuUpdated: true } : undefined}>
      {cartText}
    </Link>
  ) : (
    <Link to="/dine-in/session">
      {to === "table-saved" ? t("See your table") : t("Back to your table")}
    </Link>
  );
}

/** The dishes of a round that was placed before the payment failed are safe, and say where. */
function SavedOnTable({ to }: { readonly to: CheckoutReturn }): ReactNode {
  return to === "table-saved" ? (
    <p>{t("Your dishes are saved on your table page and go to the kitchen once paid.")}</p>
  ) : null;
}
export function SessionPaymentPage({
  store,
}: {
  readonly store?: CustomerStoreContext | undefined;
}) {
  const [session] = useState(getCheckoutSessionReference);
  const [tip] = useState(getCheckoutTipSelection);
  // A restored checkout has no page-memory tip. Read its outcome before another payment action.
  return session && !tip ? (
    <SessionPaymentResultPage store={store} />
  ) : (
    <PreparedSessionPaymentPage store={store} />
  );
}
function PreparedSessionPaymentPage({
  store,
}: {
  readonly store?: CustomerStoreContext | undefined;
}) {
  const navigate = useNavigate();
  const [config] = useState(paymentConfiguration);
  const [sessionReference] = useState(getCheckoutSessionReference);
  const [client] = useState(createSessionPaymentClient);
  const [current] = useState(() => captureCustomerCsrfContext());
  const [status, setStatus] = useState<
    | "loading"
    | "ready"
    | "creating"
    | "card"
    /** The simulated card was submitted: what it does can't be taken back. */
    | "confirming"
    | "processing"
    | "unknown"
    | "denied"
    | "retry"
    | "closed"
    /** WP-2423: items ran out after checkout; no order was placed and nothing was charged. */
    | "items_short"
    /** WP-2423 item 8 ⑦: the Store turned tips off before payment started; nothing was charged. */
    | "tips_off"
    /** WP-2423: the restaurant updated its menu after this checkout began; nothing was charged. */
    | "requote_required"
    /** WP-2423 M03: these dishes are already in an order; nothing new was charged. */
    | "already_ordered"
    /** WP-2423: staff moved the table while this round was being sent; nothing was charged. */
    | "table_moved"
    /** WP-2423 item 2: the payment couldn't start; no card was offered, so nothing was charged. */
    | "start_failed"
    /** WP-2423 item 2: the checkout's prices no longer hold; no card was offered. */
    | "expired"
    /** WP-2423 M19: the time to pay ran out before a card was offered; nothing was charged. */
    | "window_ended"
    | "unavailable"
  >("loading");
  /** WP-2423 M19: until when this payment is accepted, on the server's clock. */
  const [deadline, setDeadline] = useState<PaymentDeadline | null>(null);
  const [phase, setPhase] = useState<PaymentDeadlinePhase>("open");
  /** WP-2423 M17: what the read of an unclear payment found ("checking" until it is clear). */
  const [resolution, setResolution] = useState<"checking" | "not_started">("checking");
  const [resolveReads, setResolveReads] = useState(0);
  // WP-2423 Q10: a failed check of the checkout is retried in place, never a dead end.
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [selectedTip] = useState(getCheckoutTipSelection);
  const [payment, setPayment] = useState<SessionPaymentView | null>(null);
  const [placedOrder, setPlacedOrder] = useState<SessionPaymentClientError["placedOrder"]>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [firstOffer, setFirstOffer] = useState(false);
  const [online, setOnline] = useState(
    () => typeof navigator === "undefined" || navigator.onLine !== false,
  );
  const flight = useRef(false),
    alive = useRef(true);
  /** This guest's checkout is still the one on this page. */
  const inContext = () => current() && getCheckoutSessionReference() === sessionReference;
  useEffect(() => {
    alive.current = true;
    let stopped = false;
    if (!config) setStatus("unavailable");
    else if (
      !sessionReference ||
      !selectedTip ||
      selectedTip.checkoutSessionReference !== sessionReference ||
      !current()
    )
      setStatus("denied");
    else
      void createCheckoutSessionClient()
        .read(sessionReference)
        .then(() => {
          if (!stopped) setStatus(current() ? "ready" : "denied");
        })
        .catch((error: unknown) => {
          if (stopped) return;
          setStatus(current() ? checkoutLoadFailureState(error) : "denied");
        });
    return () => {
      stopped = true;
      alive.current = false;
    };
  }, [config, current, sessionReference, selectedTip, loadAttempt]);
  useEffect(() => {
    const offline = () => {
      setOnline(false);
      setSecret(null);
      setStatus((value) => (value === "card" ? "unknown" : value));
    };
    const connected = () => setOnline(true);
    window.addEventListener("offline", offline);
    window.addEventListener("online", connected);
    return () => {
      window.removeEventListener("offline", offline);
      window.removeEventListener("online", connected);
    };
  }, []);
  // In both modes: what comes after this can't claim nothing was charged.
  useEffect(() => {
    if (status === "card") markCheckoutCardOffered();
  }, [status]);
  /** `manual`: the guest asked again, having already outlasted a menu listing. */
  const prepare = async (manual = false) => {
    if (!config || !sessionReference || !alive.current || !online || flight.current) return;
    if (!selectedTip || selectedTip.checkoutSessionReference !== sessionReference) return;
    // WP-2423 M19: past a known deadline nothing new is asked for; the result says what happened.
    if (deadline !== null && paymentDeadlinePhase(deadline, Date.now()) === "ended") {
      setSecret(null);
      setStatus("unknown");
      return;
    }
    // The credential was replaced under this page: an ended page says so, it never waits.
    if (!inContext()) {
      setStatus("denied");
      return;
    }
    flight.current = true;
    setSecret(null);
    setStatus("creating");
    const options = {
      isWanted: () => alive.current,
      ...(manual ? { busyTotalMs: manualRetryBusyTotalMs } : {}),
    };
    try {
      const result = await client.create(
        sessionReference,
        selectedTip.selectionReference,
        selectedTip.amountMinor,
        options,
      );
      if (!alive.current) return;
      if (!inContext()) {
        setStatus("denied");
        return;
      }
      setPayment(result);
      setDeadline((known) => earlierPaymentDeadline(known, result.deadline ?? null));
      if (result.creationStatus === "Processing") {
        setStatus(wasCheckoutCardOffered() ? "unknown" : "processing");
        return;
      }
      if (config.mode === "simulation") {
        setFirstOffer(!wasCheckoutCardOffered());
        setStatus("card");
        return;
      }
      const handed = await client.handoffWithDeadline(sessionReference);
      const credential = handed.clientSecret;
      setDeadline((known) => earlierPaymentDeadline(known, handed.deadline));
      if (!alive.current) return;
      if (!inContext()) {
        setStatus("denied");
        return;
      }
      if (typeof navigator !== "undefined" && navigator.onLine === false) {
        setStatus("unknown");
        return;
      }
      setFirstOffer(!wasCheckoutCardOffered());
      setSecret(credential);
      setStatus("card");
    } catch (error) {
      if (!alive.current) return;
      if (!inContext()) {
        setStatus("denied");
        return;
      }
      const failure = paymentStartFailureState(error, wasCheckoutCardOffered());
      if (failure === "already_ordered" && error instanceof SessionPaymentClientError)
        setPlacedOrder(error.placedOrder);
      if (failure === "table_pays_later") {
        setTablePaymentTiming("PayLater");
        void navigate("/cart", { replace: true });
        return;
      }
      setStatus(failure);
    } finally {
      flight.current = false;
    }
  };
  // U1: the amount and the secure card field appear as soon as the checkout is confirmed.
  const autoPrepared = useRef(false);
  useEffect(() => {
    if (status !== "ready" || autoPrepared.current || !online) return;
    autoPrepared.current = true;
    void prepare();
    // prepare reads refs and page-memory selections; the status transition is the trigger.
  }, [status, online]);
  // WP-2423 M19: one timer to the next change (the 5-minute warning, then the end), never polling.
  useEffect(() => {
    if (deadline === null) return;
    const update = () => setPhase(paymentDeadlinePhase(deadline, Date.now()));
    update();
    const wait = nextPaymentDeadlineChangeMs(deadline, Date.now());
    if (wait === null) return;
    const timer = window.setTimeout(update, Math.min(wait + 250, 2_147_483_647));
    return () => window.clearTimeout(timer);
  }, [deadline, phase]);
  // At the deadline the card is no longer offered; the payment's result says what happened.
  useEffect(() => {
    if (phase !== "ended") return;
    if (status === "card" || status === "ready" || status === "processing") {
      setSecret(null);
      setStatus("unknown");
    }
  }, [phase, status]);
  // WP-2423 M17: an unclear payment is read, never guessed. Only "no payment exists" offers the
  // card again; a payment that exists goes to its result, which offers that same attempt.
  useEffect(() => {
    if (status !== "unknown" || !sessionReference) return;
    let stopped = false;
    let timer: number | undefined;
    const read = async () => {
      let answer: SessionPaymentResult | null;
      try {
        answer = await createSessionPaymentResultClient().read(sessionReference);
      } catch {
        answer = null;
      }
      if (stopped || !alive.current) return;
      const next = resolveUnknownPayment(answer);
      if (next === "paid" || next === "result") {
        void navigate("/checkout/result", { replace: true });
        return;
      }
      setResolution(next);
      if (next === "checking") {
        const delay =
          paymentResultPollDelaysMs[Math.min(resolveReads, paymentResultPollDelaysMs.length - 1)];
        timer = window.setTimeout(() => setResolveReads((count) => count + 1), delay);
      }
    };
    setResolution("checking");
    if (online) void read();
    return () => {
      stopped = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [status, sessionReference, resolveReads, online, navigate]);
  const simulate = async (outcome: "approve" | "decline" = "approve") => {
    if (
      config?.mode !== "simulation" ||
      !sessionReference ||
      !selectedTip ||
      !alive.current ||
      !inContext() ||
      !online ||
      flight.current
    )
      return;
    flight.current = true;
    setStatus("confirming");
    try {
      await (outcome === "approve" ? client.simulate : client.simulateDecline)(
        sessionReference,
        selectedTip.selectionReference,
        selectedTip.amountMinor,
      );
      if (alive.current && inContext()) void navigate("/checkout/result", { replace: true });
    } catch {
      if (alive.current) setStatus(inContext() ? "unknown" : "denied");
    } finally {
      flight.current = false;
    }
  };
  const submitted = () => {
    setSecret(null);
    if (alive.current && inContext()) void navigate("/checkout/result", { replace: true });
  };
  const demo = config?.mode === "simulation";
  const cardOffered = wasCheckoutCardOffered();
  const failedStart =
    status === "start_failed" ||
    status === "expired" ||
    status === "closed" ||
    // The server places a table's round before it records the tip: the dishes may be on the table.
    status === "tips_off" ||
    // Nothing was placed, so the dishes are in the cart, unless another phone at the table placed them.
    status === "requote_required" ||
    status === "table_moved" ||
    status === "window_ended" ||
    (status === "denied" && !cardOffered);
  const back = useCheckoutReturn(failedStart, store?.serviceMode === "DineIn");
  // While a payment may be under way (or just failed), a second checkout is the last thing to offer.
  const inFlow =
    status === "loading" ||
    status === "ready" ||
    status === "creating" ||
    status === "card" ||
    status === "unavailable";
  return (
    <CustomerPage step="payment" store={store} className="payment-page">
      <PageHeading title={demo ? t("DEMO payment") : t("Secure payment")}>
        {demo ? <p>{t("Internal testing only. No real money is charged.")}</p> : null}
      </PageHeading>
      <ol className="checkout-progress" aria-label={t("Checkout progress")}>
        <li>{t("Review")}</li>
        <li aria-current="step">{t("Pay")}</li>
        <li>{t("Done")}</li>
      </ol>
      {status === "loading" ? <p role="status">{t("Loading checkout…")}</p> : null}
      {status === "unavailable" ? (
        <section className="payment-page__unavailable" role="alert">
          <h2>{t("Online payment is unavailable")}</h2>
          <p>{t("Card payment isn’t set up at this location yet. Ask staff how to pay.")}</p>
        </section>
      ) : null}
      {status === "denied" && cardOffered ? (
        <section className="checkout-attention" role="alert">
          <h2>{t("We can’t show this payment on this phone")}</h2>
          <p>{t("Ask a staff member to check it before you pay again.")}</p>
        </section>
      ) : null}
      {status === "denied" && !cardOffered ? (
        <section className="checkout-attention" role="alert">
          <h2>{t("This checkout has ended")}</h2>
          <p>
            {back === "cart"
              ? t(
                  "You haven’t been charged for it. Go back to your cart to check out again, or ask a staff member for help.",
                )
              : t(
                  "You haven’t been charged for it. See your table, or ask a staff member for help.",
                )}
          </p>
          <SavedOnTable to={back} />
          <CheckoutReturnLink to={back} cartPath="/cart" cartText={t("Back to your cart")} />
        </section>
      ) : null}
      {status === "retry" ? (
        <section className="checkout-attention" role="alert">
          <h2>{t("We couldn’t load your payment")}</h2>
          <p>
            {cardOffered
              ? t("Check your connection and try again.")
              : t("This order hasn’t been charged. Check your connection and try again.")}
          </p>
          <button
            type="button"
            disabled={!online}
            onClick={() => {
              setStatus("loading");
              setLoadAttempt((count) => count + 1);
            }}
          >
            {t("Try again")}
          </button>
        </section>
      ) : null}
      {status === "closed" ? (
        <section className="checkout-attention" role="alert">
          <h2>{t("The store stopped taking orders")}</h2>
          <p>
            {t(
              "It stopped before payment started (it closed, or the kitchen stopped taking orders for today), so this order hasn’t been charged. To add something, ask a staff member.",
            )}
          </p>
          <CheckoutReturnLink to={back} cartPath="/cart" cartText={t("Back to your cart")} />
        </section>
      ) : null}
      {status === "items_short" ? (
        <section className="checkout-attention" role="alert">
          <h2>{t("Some items just ran out")}</h2>
          <p>
            {t(
              "Part of your order sold out while we were getting it ready, so we didn’t place it and this order hasn’t been charged. Go back to your cart to change your order.",
            )}
          </p>
          <Link to="/cart">{t("Back to your cart")}</Link>
        </section>
      ) : null}
      {status === "tips_off" ? (
        <section className="checkout-attention" role="alert">
          <h2>{t("The restaurant stopped taking tips")}</h2>
          <p>
            {back === "cart"
              ? t(
                  "Tips were turned off while you were checking out, so this order hasn’t been charged. Go back to checkout to pay without a tip.",
                )
              : t(
                  "Tips were turned off while you were checking out, so this order hasn’t been charged. Pay for it from your table page, without a tip.",
                )}
          </p>
          <SavedOnTable to={back} />
          <CheckoutReturnLink to={back} cartPath="/checkout" cartText={t("Back to checkout")} />
        </section>
      ) : null}
      {status === "already_ordered" ? (
        <section className="checkout-attention" role="alert">
          <h2>{t("Already ordered")}</h2>
          <p>
            {placedOrder !== null
              ? t("These dishes were already ordered (order {number}). Nothing new was charged.", {
                  number: placedOrder.orderNumber,
                })
              : t("These dishes were already ordered. Nothing new was charged.")}
          </p>
          {placedOrder !== null ? (
            <Link className="cart-primary-link" to={"/orders/" + placedOrder.orderReference}>
              {t("View order status")}
            </Link>
          ) : (
            <Link className="cart-primary-link" to="/menu">
              {t("Back to menu")}
            </Link>
          )}
        </section>
      ) : null}
      {status === "requote_required" ? (
        <section className="checkout-attention" role="alert">
          <h2>{t("The menu was just updated")}</h2>
          <p>
            {back === "cart"
              ? t(
                  "The restaurant updated its menu while you were checking out, so you haven’t been charged. Go back to checkout to see your total and pay.",
                )
              : t(
                  "The restaurant updated its menu while you were checking out, so you haven’t been charged. Pay for your order from your table page.",
                )}
          </p>
          <SavedOnTable to={back} />
          <CheckoutReturnLink
            to={back}
            cartPath="/checkout"
            cartText={t("Back to checkout")}
            menuUpdated
          />
        </section>
      ) : null}
      {status === "table_moved" ? (
        <section className="checkout-attention" role="alert">
          <h2>{t("Your table was changed")}</h2>
          <p>
            {t(
              "Staff moved your party to another table while you were paying, so you haven’t been charged. Go back to checkout to pay at your new table.",
            )}
          </p>
          <SavedOnTable to={back} />
          <CheckoutReturnLink to={back} cartPath="/checkout" cartText={t("Back to checkout")} />
        </section>
      ) : null}
      {status === "start_failed" ? (
        <section className="checkout-attention" role="alert">
          <h2>{t("We couldn’t start your payment")}</h2>
          <p>{t("This order hasn’t been charged, and it hasn’t gone to the kitchen.")}</p>
          <SavedOnTable to={back} />
          <p>
            {t(
              "Try again in a moment. If it still doesn’t work, ask a staff member: they can take your order and payment.",
            )}
          </p>
          <button type="button" disabled={!online} onClick={() => void prepare(true)}>
            {t("Try again")}
          </button>
          <CheckoutReturnLink to={back} cartPath="/cart" cartText={t("Back to your cart")} />
        </section>
      ) : null}
      {status === "processing" ? (
        <section className="checkout-attention" role="alert">
          <h2>{t("Your payment is still being set up")}</h2>
          <p>{t("This order hasn’t been charged.")}</p>
          <button type="button" disabled={!online} onClick={() => void prepare(true)}>
            {t("Try again")}
          </button>
        </section>
      ) : null}
      {status === "expired" ? (
        <section className="checkout-attention" role="alert">
          <h2>{t("Your order needs checking again")}</h2>
          <p>
            {back === "cart"
              ? t("This order hasn’t been charged. Go back to check out again.")
              : t("This order hasn’t been charged. Pay for it from your table page.")}
          </p>
          <SavedOnTable to={back} />
          <CheckoutReturnLink to={back} cartPath="/checkout" cartText={t("Back to checkout")} />
        </section>
      ) : null}
      {status === "unknown" && resolution === "checking" ? (
        <section className="checkout-attention" role="alert">
          <h2>{t("Checking your payment — don’t pay again")}</h2>
          <p>{t("We’re checking your payment. This page updates by itself.")}</p>
          <button
            type="button"
            disabled={!online}
            onClick={() => setResolveReads((count) => count + 1)}
          >
            {t("Check now")}
          </button>
        </section>
      ) : null}
      {status === "unknown" && resolution === "not_started" ? (
        <section className="checkout-attention" role="alert">
          <h2>{t("Your payment hasn’t started")}</h2>
          <p>{t("This order hasn’t been charged.")}</p>
          <button type="button" disabled={!online} onClick={() => void prepare(true)}>
            {t("Continue to payment")}
          </button>
        </section>
      ) : null}
      {status === "window_ended" ? (
        <section className="checkout-attention" role="alert">
          <h2>{t("Time to pay ran out")}</h2>
          <p>{t("Your order was cancelled and you haven’t been charged.")}</p>
          {store?.serviceMode === "DineIn" ? (
            <Link className="cart-primary-link" to="/dine-in/session">
              {t("See your table")}
            </Link>
          ) : (
            <>
              {payment !== null ? (
                <RestoreDishesPanel orderReference={payment.orderReference} />
              ) : null}
              <Link className="cart-primary-link" to="/menu">
                {t("Back to menu")}
              </Link>
            </>
          )}
        </section>
      ) : null}
      {store?.serviceMode === "DineIn" &&
      (status === "start_failed" ||
        status === "processing" ||
        status === "unknown" ||
        status === "closed" ||
        status === "tips_off" ||
        (status === "denied" && cardOffered)) ? (
        // Asking for help is one tap for a seated guest; the panel hides itself if none is offered.
        <DiningStaffCallPanel />
      ) : null}
      {payment !== null &&
      (status === "card" ||
        status === "confirming" ||
        status === "processing" ||
        status === "unknown") ? (
        <section className="payment-page__amount" aria-label={t("Amount")}>
          <dl>
            {selectedTip && selectedTip.amountMinor !== "0" ? (
              <div>
                <dt>{t("Tip")}</dt>
                <dd>
                  {formatCartMoney({ amountMinor: selectedTip.amountMinor, currency: "CAD" })}
                </dd>
              </div>
            ) : null}
            <div className="payment-page__total">
              <dt>{t("Total to pay")}</dt>
              <dd>{formatCartMoney(payment.total)}</dd>
            </div>
          </dl>
          {deadline !== null && status === "card" ? (
            <p className="payment-page__pay-by">
              {t("Pay by {time}", { time: formatClockTime(deadline.payBy) })}
            </p>
          ) : null}
          {deadline !== null && status === "card" && phase === "warning" ? (
            <p role="alert">
              {t(
                "About 5 minutes left to pay. After {time} this order is cancelled and you won’t be charged.",
                { time: formatClockTime(deadline.payBy) },
              )}
            </p>
          ) : null}
        </section>
      ) : null}
      {status === "creating" ? <p role="status">{t("Preparing your payment…")}</p> : null}
      <SlowWaitNote active={status === "creating"}>
        {cardOffered
          ? t("Still working on it.")
          : t("Still working on it. This order hasn’t been charged.")}
      </SlowWaitNote>
      {status === "confirming" ? <p role="status">{t("Confirming your payment…")}</p> : null}
      <SlowWaitNote active={status === "confirming"}>{t("Still working on it.")}</SlowWaitNote>
      {status === "card" && demo ? (
        <>
          <button
            className="payment-page__pay"
            type="button"
            disabled={!online}
            onClick={() => void simulate()}
          >
            {t("Confirm simulated payment")}
          </button>
          {/* WP-2423 Q20: internal testing of a declined card and paying with another card. */}
          <button type="button" disabled={!online} onClick={() => void simulate("decline")}>
            {t("Simulate a declined card (test only)")}
          </button>
        </>
      ) : null}
      {status === "card" && secret && config?.mode === "stripe" ? (
        <StripeCardForm
          {...config}
          clientSecret={secret}
          onSubmitted={submitted}
          firstOffer={firstOffer}
          resultPath="/checkout/result"
        />
      ) : null}
      {!online ? (
        <p role="alert">{t("Reconnect to continue. Payment will not restart automatically.")}</p>
      ) : null}
      {inFlow ? (
        <Link className="payment-page__back" to="/checkout">
          {t("Back to checkout")}
        </Link>
      ) : null}
    </CustomerPage>
  );
}
