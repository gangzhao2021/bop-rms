import { AlreadyOrdered } from "./AlreadyOrdered.js";
import { createCheckoutSessionClient } from "./session-client.js";
import {
  createCheckoutSessionController,
  type CheckoutSessionController,
} from "./session-controller.js";
import { v7 as uuidv7 } from "uuid";
import { parseTipAmount } from "./tip-amount.js";
import {
  setCheckoutSessionReference,
  setCheckoutTipSelection,
  setTablePaymentTiming,
} from "../session/customer-transaction-context.js";
import { captureCustomerCsrfContext } from "../session/customer-transaction-context.js";
import {
  CheckoutDetailsForm,
  type CheckoutDetailsFormHandle,
  type CheckoutFormSelection,
  type PickupContactDraft,
} from "./CheckoutDetailsForm.js";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import {
  checkoutTips,
  customTipCheck,
  priceChangesNeedAcceptance,
  priceHold,
  quotePricedLines,
} from "./checkout-decisions.js";
import { acceptSeenPrices, recordFirstSeenPrices, seenPriceChanges } from "../cart/seen-prices.js";
import { PriceChangeList } from "./PriceChangeList.js";
import { createBrowserCustomerCartClient, type CustomerCartClient } from "../cart/cart-client.js";
import { startTableCartPoll } from "../cart/table-cart-poll.js";
import { tableCartChange, type TableCartChange } from "../cart/table-cart-change.js";
import { formatCartMoney } from "../cart/format-money.js";
import {
  checkoutInProgressMessage,
  orderProcessingMessage,
  type CartTablePay,
} from "../cart/types.js";
import { describeConfiguration } from "../cart/CartPage.js";
import { ScopeExpiryWarning } from "../cart/TablePayChoice.js";
import { checkoutItemRefusalMessage } from "./item-refusal-message.js";
import { checkoutSessionAlert } from "./session-message.js";
import { storeServiceNoticeText, useStoreService } from "../store/StoreIdentity.js";
import { takesNewOrders } from "../store/store-service.js";
import {
  createStoreProfileClient,
  type StoreProfileLoader,
} from "../store/store-profile-client.js";

const browserCheckoutStoreProfile: StoreProfileLoader = createStoreProfileClient();
import { sendFailureState } from "./send-round.js";
import { paymentConfiguration } from "../payment/payment-configuration.js";
import { quoteConsistentLinePrices, usePublishedMenu } from "../menu/menu-line-prices.js";
import type { CustomerMenuClient, MenuJourneyContext } from "../menu/types.js";
import { CustomerPage, PageHeading, type CustomerStoreContext } from "../journey/CustomerPage.js";
import { currencySymbol, formatMoney, percentOfMinor } from "../journey/format.js";
import {
  cartText,
  checkoutText,
  commonText,
  lineEstimateLabel,
  quoteIssueMessage,
  tableCartAddedDishes,
  tableCartChangedDishes,
} from "../journey/messages.js";
import {
  createCheckoutClient,
  createCheckoutController,
  type CheckoutController,
} from "./checkout-client.js";
import type { DiningSessionClient } from "../dining/dining-session-client.js";
import { useTablePaymentTiming } from "../dining/table-timing.js";
import {
  createSessionPaymentClient,
  SessionPaymentClientError,
} from "../payment/session-payment-client.js";

/** A tip percentage of the subtotal before tax (0: no tip), or an amount the guest types. */
type TipChoice = number | "custom";

/** Dollars-and-cents text for a minor-unit amount, for the custom tip field. */
function minorToText(minor: string): string {
  const digits = minor.padStart(3, "0");
  return `${digits.slice(0, -2)}.${digits.slice(-2)}`;
}

export function CheckoutPage({
  controller: provided,
  now = Date.now,
  store,
  menuContext,
  menuClient,
  diningClient,
  sendClient,
  sessionController: providedSession,
  cartClient,
  storeProfile,
}: {
  /** The Store's live service answer (tests inject; null reads nothing). */
  readonly storeProfile?: StoreProfileLoader | null | undefined;
  /** WP-2423 (same-table-ordering): reads the table cart while this phone checks out. */
  readonly cartClient?: Pick<CustomerCartClient, "loadCurrent">;
  /** DEC-DINE-IN-PAY-LATER: the table's payment timing (tests pass their own). */
  readonly diningClient?: DiningSessionClient;
  readonly sendClient?: Pick<ReturnType<typeof createSessionPaymentClient>, "sendToKitchen">;
  readonly controller?: CheckoutController;
  /** The checkout-session start (tests pass their own). */
  readonly sessionController?: CheckoutSessionController;
  readonly now?: () => number;
  readonly store?: CustomerStoreContext | undefined;
  /** The published menu prices each line as the guest saw it, when it agrees with the quote. */
  readonly menuContext?: MenuJourneyContext | undefined;
  readonly menuClient?: CustomerMenuClient | undefined;
}) {
  const [controller] = useState(
    () =>
      provided ?? createCheckoutController(createCheckoutClient(createBrowserCustomerCartClient())),
  );
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getState,
    controller.getState,
  );
  const [detailsLocked, setDetailsLocked] = useState(false);
  const [confirmedQuote, setConfirmedQuote] = useState<string | null>(null);
  const navigate = useNavigate();
  const location = useLocation();
  const [sessionController] = useState(
    () => providedSession ?? createCheckoutSessionController(createCheckoutSessionClient()),
  );
  const sessionState = useSyncExternalStore(
    sessionController.subscribe,
    sessionController.getState,
    sessionController.getState,
  );
  // AGENTS.md (customer respect), Owner decision 11: no tip is chosen for the guest; every
  // option, "No tip" included, is offered alike and the guest chooses before paying.
  const [tipChoice, setTipChoice] = useState<TipChoice | null>(null);
  const [customTip, setCustomTip] = useState("");
  const selectedTip = useRef<{ selectionReference: string; amountMinor: string } | null>(null);
  const [readyDetails, setReadyDetails] = useState<CheckoutFormSelection | null>(null);
  const [detailsSubmittable, setDetailsSubmittable] = useState(false);
  const detailsForm = useRef<CheckoutDetailsFormHandle>(null);
  // Contact the guest typed but has not saved. A re-price (after a reconnect, an expired quote)
  // remounts the details form for the new quote; this keeps their typing for the same cart. It is
  // only shown again, never sent until the guest continues.
  const [unsavedContact, setUnsavedContact] = useState<{
    readonly cartReference: string;
    readonly contact: PickupContactDraft;
  } | null>(null);
  const [continueRequested, setContinueRequested] = useState(false);
  // WP-2423 (same-table-ordering): what another phone at the table did to this cart meanwhile.
  const [tableChange, setTableChange] = useState<TableCartChange | null>(null);
  // WP-2423 shared-table-checkout (a): this phone chose this round's dishes; until when the others
  // wait for theirs, as last read.
  const [readPayer, setReadPayer] = useState<CartTablePay["payer"] | undefined>(undefined);
  const [tableCartReader] = useState(() => cartClient ?? createBrowserCustomerCartClient());
  const [sendClientValue] = useState(() => sendClient ?? createSessionPaymentClient());
  const [sendState, setSendState] = useState<
    "idle" | "sending" | "failed" | "pay_first" | "store_closed" | "items_short"
  >("idle");
  // WP-2423: the restaurant updated its menu while this guest was checking out; nothing was placed
  // or charged. The page prices the cart again once and says why, and the guest checks the total
  // and presses again. What was chosen for the old price goes with it.
  // WP-2423 M165: also when the payment page found the menu updated and sent the guest back here
  // (the notice used to be lost on that round trip, so the new price looked silent).
  const [menuUpdated, setMenuUpdated] = useState(
    () => (location.state as { menuUpdated?: unknown } | null | undefined)?.menuUpdated === true,
  );
  /** WP-2423 M132: the large typed tip the guest confirmed (its amount), if any. */
  const [confirmedTip, setConfirmedTip] = useState<string | null>(null);
  const priceAgainAfterMenuUpdate = () => {
    selectedTip.current = null;
    setMenuUpdated(true);
    setSendState("idle");
    sessionController.reset();
    void controller.quote();
  };
  const sendRound = async (checkoutSessionReference: string, selectionReference: string) => {
    setSendState("sending");
    try {
      const sent = await sendClientValue.sendToKitchen(
        checkoutSessionReference,
        selectionReference,
      );
      void navigate("/dine-in/session", {
        replace: true,
        state: { placed: sent.status === "Held" ? "Held" : "Sent" },
      });
    } catch (error) {
      if (
        error instanceof SessionPaymentClientError &&
        (error.code === "requote_required" || error.code === "table_moved")
      ) {
        priceAgainAfterMenuUpdate();
        return;
      }
      setSendState(sendFailureState(error));
    }
  };
  // DEC-DINE-IN-PAY-LATER: at a table that pays once at the end the round goes to the kitchen
  // when sent: no tip and no payment here. WP-2423 item 6: such a table is here only for the Store's
  // documents; the cart places its rounds in one tap.
  const payLater =
    useTablePaymentTiming(
      "cart" in state && state.cart?.cart.orderType === "DineIn",
      diningClient,
    ) === "PayLater";
  useEffect(() => {
    if (sessionState.status === "ready" && selectedTip.current && payLater) {
      if (sendState === "idle")
        void sendRound(
          sessionState.session.checkoutSessionReference,
          selectedTip.current.selectionReference,
        );
      return;
    }
    if (sessionState.status === "ready" && selectedTip.current) {
      setCheckoutSessionReference(sessionState.session.checkoutSessionReference);
      setCheckoutTipSelection({
        checkoutSessionReference: sessionState.session.checkoutSessionReference,
        ...selectedTip.current,
      });
      void navigate("/checkout/payment");
    }
  }, [navigate, sessionState, payLater]);
  useEffect(() => {
    if (sessionState.status === "requote_required") priceAgainAfterMenuUpdate();
    // Once per refusal: the price-again step leaves this state straight away.
  }, [sessionState.status]);
  useEffect(() => {
    const offline = () => sessionController.setOnline(false);
    const online = () => sessionController.setOnline(true);
    window.addEventListener("offline", offline);
    window.addEventListener("online", online);
    return () => {
      window.removeEventListener("offline", offline);
      window.removeEventListener("online", online);
    };
  }, [sessionController]);

  const [retained, setRetained] = useState<{
    selection: CheckoutFormSelection;
    current: () => boolean;
  } | null>(null);
  const quoteAction = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (state.status === "quote-expired" && document.activeElement === document.body)
      quoteAction.current?.focus();
  }, [state.status]);
  const [, setClockRevision] = useState(0);
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
  const cart = "cart" in state ? state.cart : null;
  const service = useStoreService(
    storeProfile === undefined ? browserCheckoutStoreProfile : storeProfile,
  );
  const dineIn = cart?.cart.orderType === "DineIn";
  const quote = state.status === "ready" ? state.quote : null;
  // WP-2423 (same-table-ordering): before payment starts, a table checkout re-reads the cart every
  // few seconds (only on screen and online, slower after a failure), so this phone learns at once
  // that someone at the table added a dish, or sent these dishes in their own round.
  const loadedCart = useRef(cart);
  loadedCart.current = cart;
  const pollAllowed = useRef(false);
  pollAllowed.current =
    dineIn &&
    cart !== null &&
    sessionState.status === "idle" &&
    sendState === "idle" &&
    !continueRequested &&
    !detailsLocked &&
    (tableChange === null || tableChange.kind === "changed");
  const checkTable = useRef(async (): Promise<boolean> => false);
  checkTable.current = async () => {
    const loaded = loadedCart.current;
    if (loaded === null || loaded.cart.orderType !== "DineIn") return true;
    const current = await tableCartReader.loadCurrent();
    if (loadedCart.current !== loaded) return true;
    setReadPayer(current?.cart.tablePay?.payer ?? null);
    const change = tableCartChange(loaded, current);
    setTableChange(change.kind === "unchanged" ? null : change);
    return true;
  };
  useEffect(() => {
    if (!dineIn) return;
    const poll = startTableCartPoll({
      read: () => checkTable.current().catch(() => false),
      shouldRead: () => pollAllowed.current,
      visible: () => typeof document === "undefined" || document.visibilityState === "visible",
      online: () => typeof navigator === "undefined" || navigator.onLine !== false,
    });
    const wake = () => poll.wake();
    const reconnected = () => poll.wake("reconnected");
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("online", reconnected);
    return () => {
      poll.stop();
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("online", reconnected);
    };
  }, [dineIn]);
  // A refused start or details save because the cart moved: say what happened at the table.
  useEffect(() => {
    if (sessionState.status === "conflict" && dineIn) void checkTable.current().catch(() => false);
  }, [sessionState.status, dineIn]);
  const menu = usePublishedMenu(
    menuContext,
    menuClient,
    cart?.cart.items.some((item) => item.lineEstimate.status !== "Available") ?? false,
  );
  // Each line at a price that adds up to the quote's subtotal; a line that can't be priced that
  // way shows no amount while the quote's total is beside it, never a contradicting label.
  // WP-2423 M74: the quote's own line prices when it sends them (every line, adding up to its
  // subtotal), so no line is left blank after a re-price.
  const quoteLines = quotePricedLines(quote);
  const linePrices =
    cart === null
      ? null
      : quote?.lines !== undefined
        ? new Map(
            quoteLines.map(
              (line) =>
                [
                  line.cartItemReference,
                  { amountMinor: line.amountMinor, currency: line.currency },
                ] as const,
            ),
          )
        : quoteConsistentLinePrices(cart.cart.items, menu, quote?.subtotal ?? null);
  // WP-2423 M74: dishes whose price changed since the guest added them (first prices are kept).
  if (cart !== null && quote?.lines !== undefined)
    recordFirstSeenPrices(cart.cart.cartReference, quoteLines);
  const priceChanges =
    cart === null || quote?.lines === undefined
      ? []
      : seenPriceChanges(cart.cart.cartReference, quoteLines);
  const pricesNeedAcceptance =
    quote !== null &&
    (priceChangesNeedAcceptance(priceChanges) ||
      quote.priceChange?.requiresReconfirmation === true);
  // U1: the Store prices the order as soon as the cart is known (and again after a reconnect);
  // no "get a quote" tap. A failed attempt leaves a non-ready state, so this cannot loop.
  useEffect(() => {
    if (state.status !== "ready" || state.quote !== null) return;
    void controller.quote();
  }, [controller, state]);
  if (
    cart &&
    quote &&
    (quote.quoteVersion === 1 || quote.quoteVersion === 2) &&
    (cart.cart.orderType === "DineIn" || cart.cart.orderType === "Pickup") &&
    retained?.selection.quoteReference !== quote.quoteReference
  ) {
    setRetained({
      selection: {
        cartReference: cart.cart.cartReference,
        cartVersion: cart.cart.version,
        quoteReference: quote.quoteReference,
        quoteVersion: quote.quoteVersion,
        orderType: cart.cart.orderType,
        quoteExpiresAt: quote.expiresAt,
      },
      current: captureCustomerCsrfContext(),
    });
  }
  // The form stays mounted while the same cart is re-priced (pending) so an in-flight details
  // save and its retry survive a reconnect; a new quote reference remounts it on purpose, and the
  // contact typed but not yet saved is carried into the new form (`unsavedContact`).
  const detailsSelection =
    retained?.current() &&
    cart &&
    retained.selection.cartReference === cart.cart.cartReference &&
    retained.selection.cartVersion === cart.cart.version &&
    (state.status === "ready" || state.status === "offline" || state.status === "pending")
      ? retained.selection
      : null;
  const quoteExpired = quote !== null && Date.parse(quote.expiresAt) <= now();
  useEffect(() => {
    if (quote === null || quoteExpired) return;
    const remaining = Date.parse(quote.expiresAt) - now();
    const timer = window.setTimeout(
      () => setClockRevision((revision) => revision + 1),
      Math.min(remaining + 1, 2_147_483_647),
    );
    return () => window.clearTimeout(timer);
  }, [now, quote, quoteExpired]);
  // The Store's tip percentages; with tips off the guest is asked nothing and pays no tip.
  // WP-2423 M114: unknown until the order is priced; nothing about tips is shown before that.
  const tips = checkoutTips(quote);
  const tipPresets = tips === null ? [] : [0, ...tips.tierPercents];
  // Nothing in the cart (v15 live check): nothing to pay for, so no tip is asked either.
  const asksTip =
    !payLater && tips !== null && tips.enabled && cart !== null && cart.cart.items.length > 0;
  // WP-2423 live minor 22: a dish in the cart can't be ordered now (refused when pricing, or when
  // the checkout starts); the way on is the cart, so no tip is asked (a tip would read as what
  // unblocks it) and the main action is Change your cart, never a payment that is refused again.
  const refusedItem =
    state.status === "item-unavailable" ||
    sessionState.status === "item_unavailable" ||
    sessionState.status === "item_short";
  // A percentage the Store no longer offers (the quote was read again) is chosen again.
  useEffect(() => {
    if (
      tips !== null &&
      typeof tipChoice === "number" &&
      tipChoice !== 0 &&
      !tips.tierPercents.includes(tipChoice)
    )
      setTipChoice(null);
  }, [tipChoice, tips]);
  const tipAmount = !asksTip
    ? "0"
    : tipChoice === null
      ? null
      : tipChoice === "custom"
        ? parseTipAmount(customTip)
        : quote === null
          ? "0"
          : percentOfMinor(quote.subtotal.amountMinor, tipChoice);
  // WP-2423 M132: a typed tip above 30 % of the order is confirmed first; above the order, refused.
  const tipCheck =
    tipChoice === "custom" && tipAmount !== null && quote !== null
      ? customTipCheck(tipAmount, quote.subtotal.amountMinor)
      : "ok";
  const tipBlocked =
    tipCheck === "too_large" || (tipCheck === "confirm" && confirmedTip !== tipAmount);
  const detailsReady =
    readyDetails !== null &&
    detailsSelection !== null &&
    readyDetails.cartReference === detailsSelection.cartReference &&
    readyDetails.cartVersion === detailsSelection.cartVersion &&
    readyDetails.quoteReference === detailsSelection.quoteReference;
  // Everything payment needs apart from saved details; the details step is part of the same tap.
  const paymentOpen =
    sessionState.status === "idle" &&
    state.status === "ready" &&
    tipAmount !== null &&
    !tipBlocked &&
    !quoteExpired &&
    quote !== null &&
    quote.blockingReasons.length === 0 &&
    !(pricesNeedAcceptance && confirmedQuote !== quote.quoteReference) &&
    detailsSelection !== null;
  // WP-2423 store-service-controls (v15 M30/M34): past last orders, while this guest's service is
  // paused or when closed, no new checkout starts; the refusal says why in this service's words.
  // A checkout already started (a card offered) is never held here.
  const serviceChannel = cart?.cart.orderType === "Pickup" ? "Pickup" : "DineIn";
  const serviceText = storeServiceNoticeText(
    service.profile?.hours ?? null,
    service.phase,
    service.minutesLeft,
    serviceChannel,
  );
  const refusedText =
    serviceText === null || service.phase === "Soon"
      ? checkoutText.storeClosed
      : [serviceText.headline, serviceText.detail, checkoutText.notCharged]
          .filter((part) => part !== null)
          .join(" ");
  const sessionAlert =
    sessionState.status === "store_closed"
      ? refusedText
      : checkoutSessionAlert(sessionState, state.status === "offline", payLater);
  const canContinue =
    paymentOpen &&
    !detailsLocked &&
    (detailsReady || detailsSubmittable) &&
    tableChange === null &&
    // Only a checkout not started yet waits here (`paymentOpen` means none is).
    takesNewOrders(service.phase);
  const startPayment = () => {
    if (!detailsSelection || quoteExpired || tipAmount === null) return;
    // The guest has now seen (and, for a rise, accepted) these prices.
    acceptSeenPrices(detailsSelection.cartReference, quoteLines);
    selectedTip.current ??= { selectionReference: uuidv7(), amountMinor: tipAmount };
    void sessionController.start(detailsSelection);
  };
  // The continuation after an awaited save reads the latest render, not the tap's closure.
  const proceedAfterSave = useRef<(saved: CheckoutFormSelection) => void>(() => undefined);
  proceedAfterSave.current = (saved) => {
    if (
      paymentOpen &&
      detailsSelection.cartReference === saved.cartReference &&
      detailsSelection.cartVersion === saved.cartVersion &&
      detailsSelection.quoteReference === saved.quoteReference
    )
      startPayment();
  };
  // U1: one tap saves the details and then starts payment, in that order. A save that is not
  // acknowledged stops here; the details form shows why and offers its own retry.
  const requestContinue = async () => {
    if (!canContinue || continueRequested) return;
    if (detailsReady) {
      startPayment();
      return;
    }
    // WP-2423 M112: a field that would be refused is shown and focused; nothing is sent.
    if ((detailsForm.current?.validate() ?? null) !== null) return;
    setContinueRequested(true);
    try {
      const saved = (await detailsForm.current?.save()) ?? null;
      if (saved !== null) proceedAfterSave.current(saved);
    } finally {
      setContinueRequested(false);
    }
  };
  /** DEC-DINE-IN-PAY-LATER: send again, or — the table pays as it orders — pay with no tip. */
  const retrySend = (session: string) => {
    const selection = selectedTip.current?.selectionReference;
    if (selection === undefined) return;
    if (sendState !== "pay_first") {
      void sendRound(session, selection);
      return;
    }
    setTablePaymentTiming("PayFirst");
    setCheckoutSessionReference(session);
    setCheckoutTipSelection({
      checkoutSessionReference: session,
      selectionReference: selection,
      amountMinor: "0",
    });
    void navigate("/checkout/payment");
  };
  const resolvedStore: CustomerStoreContext | undefined =
    store ??
    (cart
      ? {
          storeName: cart.cart.context.storeName,
          brandName: cart.cart.context.brandName,
          serviceMode: cart.cart.orderType,
        }
      : undefined);
  // Owner #26 (DEC-PRICE-HOLD) / M125: how long the price is kept, every 30 s, then every second.
  const hold = quote === null ? null : priceHold(quote.expiresAt, now());
  useEffect(() => {
    if (hold?.nextUpdateMs == null) return;
    const timer = window.setTimeout(
      () => setClockRevision((revision) => revision + 1),
      Math.min(hold.nextUpdateMs + 20, 2_147_483_647),
    );
    return () => window.clearTimeout(timer);
  });
  // WP-2423 M03: these dishes are an order already (Back from the paid page, an old bookmark, a
  // second tab): open that order; there is nothing here to pay.
  if (state.status === "empty" && state.placedOrder)
    return (
      <CustomerPage step="checkout" store={resolvedStore} className="checkout-page">
        <PageHeading title={checkoutText.pageTitle} />
        <AlreadyOrdered placedOrder={state.placedOrder} />
      </CustomerPage>
    );
  // WP-2423 M03 review: the server refused this checkout because these dishes are already in an
  // order (another tab ordered them, or the page was stale): open that order, never a conflict
  // that loops back to the same cart.
  if (sessionState.status === "already_ordered")
    return (
      <CustomerPage step="checkout" store={resolvedStore} className="checkout-page">
        <PageHeading title={checkoutText.pageTitle} />
        <AlreadyOrdered placedOrder={sessionState.placedOrder} />
      </CustomerPage>
    );
  // WP-2423 M03 review: the cart still holds dishes already in an order (filled before pickup
  // carts were emptied on ordering); their checkout is refused, so nothing here offers it.
  if (cart !== null && cart.cart.items.length > 0 && cart.cart.placedOrder)
    return (
      <CustomerPage step="checkout" store={resolvedStore} className="checkout-page">
        <PageHeading title={checkoutText.pageTitle} />
        <AlreadyOrdered placedOrder={cart.cart.placedOrder} dishesInCart cartLink />
      </CustomerPage>
    );
  // WP-2423 (same-table-ordering): these dishes left in a round someone at the table sent:
  // nothing here to pay, and no tip asked.
  if (tableChange?.kind === "sent")
    return (
      <CustomerPage step="checkout" store={resolvedStore} className="checkout-page">
        <PageHeading title={checkoutText.pageTitle} />
        <section role="status" className="checkout-attention">
          <p>
            {checkoutText.tableCartSent(
              tableChange.roundNumber,
              tableChange.byThisPhone,
              payLater,
              tableChange.paymentState,
            )}
          </p>
          {tableChange.cartHasDishes ? <p>{checkoutText.tableCartSentMore}</p> : null}
          <div className="cart-state__actions">
            <Link className="checkout-continue__button" to="/dine-in/session">
              {checkoutText.seeYourTable}
            </Link>
            {tableChange.cartHasDishes ? <Link to="/cart">{checkoutText.goToYourCart}</Link> : null}
          </div>
        </section>
      </CustomerPage>
    );
  return (
    <CustomerPage step="checkout" store={resolvedStore} className="checkout-page">
      <PageHeading title={payLater ? checkoutText.placeOrder : checkoutText.pageTitle} />
      {payLater ? null : (
        <ol className="checkout-progress" aria-label={checkoutText.progressLabel}>
          <li aria-current="step">{checkoutText.progressReview}</li>
          <li>{checkoutText.progressPay}</li>
          <li>{checkoutText.progressDone}</li>
        </ol>
      )}
      {(() => {
        const payer = readPayer === undefined ? (cart?.cart.tablePay?.payer ?? null) : readPayer;
        return payer?.thisPhone === true && sessionState.status === "idle" ? (
          <ScopeExpiryWarning
            payer={payer}
            onBack={() => void navigate("/cart", { replace: true })}
            onEnded={() => void checkTable.current().catch(() => false)}
          />
        ) : null;
      })()}
      {state.status === "loading" ? (
        <section role="status">
          <h2>{checkoutText.loadingHeading}</h2>
          <p>{commonText.checkingYourCart}</p>
        </section>
      ) : null}
      {state.status === "empty" ? (
        <section>
          <h2>{commonText.emptyCartHeading}</h2>
          <p>{checkoutText.emptyCartBody}</p>
          <Link to="/menu">{commonText.browseMenu}</Link>
        </section>
      ) : null}
      {/* Wide screens: the guest's details on the left, the order, its total and the payment
          action on the right. Phones read top to bottom: order, total, details, tip, pay. */}
      <div className="checkout-layout">
        <div className="checkout-layout__aside">
          {cart ? (
            <section className="checkout-summary" aria-labelledby="checkout-items">
              <h2 id="checkout-items">{checkoutText.orderHeading}</h2>
              <ul className="checkout-items">
                {cart.cart.items.map((item) => (
                  <li key={item.cartItemReference}>
                    <span className="checkout-items__quantity">{item.quantity} ×</span>
                    <span className="checkout-items__name">
                      {item.displayName}
                      {describeConfiguration(item) ? (
                        <span className="checkout-items__options">
                          {describeConfiguration(item)}
                        </span>
                      ) : null}
                      {item.customerNote ? (
                        <span className="checkout-items__note">
                          {commonText.notePrefix} {item.customerNote}
                        </span>
                      ) : null}
                    </span>
                    <span className="checkout-items__amount">
                      {(() => {
                        const price = linePrices?.get(item.cartItemReference) ?? null;
                        if (price !== null) return formatMoney(price.amountMinor, price.currency);
                        if (quote !== null) return null;
                        return item.lineEstimate.status === "Available"
                          ? formatCartMoney(item.lineEstimate.total)
                          : lineEstimateLabel(item.lineEstimate.reasonCode);
                      })()}
                    </span>
                  </li>
                ))}
              </ul>
              <Link className="checkout-edit-link" to="/cart">
                {checkoutText.editCart}
              </Link>
            </section>
          ) : null}
          {state.status === "pending" ? <p role="status">{checkoutText.calculatingTotal}</p> : null}
          {quote ? (
            <section className="checkout-summary checkout-totals" aria-labelledby="quote-heading">
              {/* Figma v1: the totals block speaks for itself; its heading is for screen readers. */}
              <h2 id="quote-heading" className="sr-only">
                {commonText.total}
              </h2>
              <dl>
                <div>
                  <dt>{commonText.subtotal}</dt>
                  <dd>{formatCartMoney(quote.subtotal)}</dd>
                </div>
                {quote.discount.amountMinor !== "0" ? (
                  <div>
                    <dt>{commonText.discount}</dt>
                    <dd>{formatCartMoney(quote.discount)}</dd>
                  </div>
                ) : null}
                <div>
                  <dt>{commonText.tax}</dt>
                  <dd>{formatCartMoney(quote.tax)}</dd>
                </div>
                {quote.fee.amountMinor !== "0" ? (
                  <div>
                    <dt>{commonText.fees}</dt>
                    <dd>{formatCartMoney(quote.fee)}</dd>
                  </div>
                ) : null}
                {tipAmount !== null && tipAmount !== "0" ? (
                  <div>
                    <dt>{checkoutText.tip}</dt>
                    <dd>{formatMoney(tipAmount, quote.total.currency)}</dd>
                  </div>
                ) : null}
                <div className="checkout-totals__total">
                  <dt>{commonText.total}</dt>
                  <dd>
                    {tipAmount === null
                      ? formatCartMoney(quote.total)
                      : formatMoney(
                          (BigInt(quote.total.amountMinor) + BigInt(tipAmount)).toString(),
                          quote.total.currency,
                        )}
                  </dd>
                </div>
              </dl>
              {quoteExpired ? (
                <div role="alert">
                  <p>{checkoutText.pricesExpired}</p>
                  <button
                    type="button"
                    disabled={detailsLocked || sessionState.status !== "idle"}
                    onClick={() => void controller.quote()}
                  >
                    {checkoutText.refreshPrices}
                  </button>
                </div>
              ) : payLater ? null : (
                <>
                  <p className="checkout-totals__validity">
                    {hold === null ? "" : checkoutText.priceKeptFor(hold.left)}
                  </p>
                  {hold?.phase === "last-minute" ? (
                    <p role="alert">{commonText.priceKeptLastMinute}</p>
                  ) : null}
                </>
              )}
              {priceChanges.length > 0 && cart !== null ? (
                <div role="alert" className="checkout-price-change">
                  <PriceChangeList changes={priceChanges} items={cart.cart.items} />
                  <p>{checkoutText.newTotal(formatCartMoney(quote.total))}</p>
                  {pricesNeedAcceptance ? (
                    <label>
                      <input
                        type="checkbox"
                        checked={confirmedQuote === quote.quoteReference}
                        disabled={sessionState.status !== "idle"}
                        onChange={(event) =>
                          setConfirmedQuote(event.target.checked ? quote.quoteReference : null)
                        }
                      />{" "}
                      {checkoutText.acceptNewPrices}
                    </label>
                  ) : null}
                </div>
              ) : quote.priceChange?.requiresReconfirmation ? (
                <div role="alert">
                  <p>{checkoutText.priceChanged}</p>
                  <label>
                    <input
                      type="checkbox"
                      checked={confirmedQuote === quote.quoteReference}
                      disabled={sessionState.status !== "idle"}
                      onChange={(event) =>
                        setConfirmedQuote(event.target.checked ? quote.quoteReference : null)
                      }
                    />{" "}
                    {checkoutText.confirmChangedPrice}
                  </label>
                </div>
              ) : null}
              {[
                ...quote.blockingReasons.map((code) => quoteIssueMessage(code, true)),
                ...quote.warnings.map((code) => quoteIssueMessage(code, false)),
              ].map((message, index) => (
                <p className="cart-warning" key={`${index}:${message}`}>
                  {message}
                </p>
              ))}
            </section>
          ) : null}
        </div>
        <div className="checkout-layout__main">
          {cart &&
          quote === null &&
          ["conflict", "validation", "unavailable", "quote-expired"].includes(state.status) ? (
            <section role="alert" className="checkout-attention">
              <h2>{checkoutText.pricesNeedRefreshHeading}</h2>
              <p>
                {state.status === "quote-expired"
                  ? checkoutText.previousPricesExpired
                  : state.status === "conflict"
                    ? checkoutText.cartChanged
                    : state.status === "validation"
                      ? checkoutText.cartValidation
                      : checkoutText.pricingUnavailable}
              </p>
              <button
                ref={quoteAction}
                disabled={detailsLocked || sessionState.status !== "idle"}
                type="button"
                onClick={() => void controller.quote()}
              >
                {checkoutText.refreshPrices}
              </button>
            </section>
          ) : null}
          {state.status === "item-unavailable" ? (
            // WP-2423 (guest-cart-503): the dish is named; the cart's own Remove clears it.
            <section role="alert" className="checkout-attention">
              <p>{checkoutItemRefusalMessage(state.refusal, state.line, state.cart.cart.items)}</p>
              <Link to="/cart">{checkoutText.changeYourCart}</Link>
            </section>
          ) : null}
          {state.status === "order-processing" || state.status === "checkout-in-progress" ? (
            <section role="alert" className="checkout-attention">
              <h2>
                {state.status === "order-processing"
                  ? commonText.orderProcessingHeading
                  : commonText.checkoutInProgressHeading}
              </h2>
              <p>
                {state.status === "order-processing"
                  ? orderProcessingMessage(state.retryAfterSeconds)
                  : checkoutInProgressMessage(state.retryAfterSeconds)}
              </p>
              <button
                disabled={detailsLocked || sessionState.status !== "idle"}
                type="button"
                onClick={() => void controller.retry()}
              >
                {commonText.tryAgain}
              </button>
            </section>
          ) : null}
          {[
            "offline",
            "session-expired",
            "outcome-unknown",
            "table-checking-out",
            "participation-ended",
          ].includes(state.status) ? (
            <section role="alert" className="checkout-attention">
              <h2>{checkoutText.attentionHeading}</h2>
              <p>
                {state.status === "offline"
                  ? checkoutText.offline
                  : state.status === "outcome-unknown"
                    ? checkoutText.pricingOutcomeUnknown
                    : state.status === "table-checking-out"
                      ? cartText.failure.tableCheckingOut[1]
                      : state.status === "participation-ended"
                        ? cartText.failure.participationEnded.join(" ")
                        : checkoutText.sessionEnded}
              </p>
              {state.status === "participation-ended" ? (
                <Link to="/dine-in/session">{cartText.failure.yourTable}</Link>
              ) : null}
              {"canRetry" in state && state.canRetry ? (
                <button
                  type="button"
                  disabled={state.status === "offline"}
                  onClick={() => void controller.retry()}
                >
                  {checkoutText.retryPricing}
                </button>
              ) : null}
            </section>
          ) : null}
          {detailsSelection ? (
            <CheckoutDetailsForm
              key={
                detailsSelection.cartReference +
                ":" +
                detailsSelection.cartVersion +
                ":" +
                detailsSelection.quoteReference
              }
              ref={detailsForm}
              now={now}
              selection={detailsSelection}
              // WP-2423 live minor 24: the cart moved (another tab ordered it): read it again.
              onCheckoutChanged={() => {
                // WP-2423 (same-table-ordering): at a table, say what someone there did first.
                if (!dineIn) {
                  void controller.load();
                  return;
                }
                void checkTable.current().then(
                  () => undefined,
                  () => void controller.load(),
                );
              }}
              payLater={payLater}
              unsavedContact={
                unsavedContact?.cartReference === detailsSelection.cartReference
                  ? unsavedContact.contact
                  : null
              }
              onUnsavedContactChange={(contact) =>
                setUnsavedContact(
                  contact === null
                    ? null
                    : { cartReference: detailsSelection.cartReference, contact },
                )
              }
              onBusyChange={setDetailsLocked}
              onReadyChange={setReadyDetails}
              onSubmittableChange={setDetailsSubmittable}
            />
          ) : null}
          {!asksTip || refusedItem ? null : (
            <section
              className="checkout-boundary checkout-tip"
              aria-labelledby="checkout-tip-heading"
            >
              <h2 id="checkout-tip-heading">{checkoutText.tip}</h2>
              <div
                className="checkout-tip__choices"
                role="group"
                aria-label={checkoutText.tipAmountLabel}
              >
                {tipPresets.map((percent) => {
                  const amount =
                    quote === null ? null : percentOfMinor(quote.subtotal.amountMinor, percent);
                  return (
                    <button
                      key={percent}
                      type="button"
                      aria-pressed={tipChoice === percent}
                      disabled={sessionState.status !== "idle" || state.status !== "ready"}
                      onClick={() => setTipChoice(percent)}
                    >
                      {percent === 0 ? checkoutText.noTip : checkoutText.tipPercent(percent)}
                      {amount !== null && percent !== 0 ? (
                        <span>{formatMoney(amount, quote?.subtotal.currency ?? "CAD")}</span>
                      ) : null}
                    </button>
                  );
                })}
                <button
                  type="button"
                  aria-pressed={tipChoice === "custom"}
                  disabled={sessionState.status !== "idle" || state.status !== "ready"}
                  onClick={() => {
                    setTipChoice("custom");
                    if (customTip === "" && quote !== null && typeof tipChoice === "number")
                      setCustomTip(
                        minorToText(percentOfMinor(quote.subtotal.amountMinor, tipChoice) ?? "0"),
                      );
                  }}
                >
                  {checkoutText.tipOther}
                </button>
              </div>
              <label htmlFor="checkout-tip" className={tipChoice === "custom" ? "" : "sr-only"}>
                {checkoutText.tipCustomLabel(currencySymbol(quote?.subtotal.currency ?? "CAD"))}
              </label>
              <input
                id="checkout-tip"
                className={tipChoice === "custom" ? "" : "sr-only"}
                inputMode="decimal"
                autoComplete="off"
                value={tipChoice === "custom" ? customTip : ""}
                disabled={sessionState.status !== "idle" || state.status !== "ready"}
                onChange={(event) => {
                  setTipChoice("custom");
                  setCustomTip(event.target.value);
                }}
                aria-invalid={tipChoice === "custom" && customTip !== "" && tipAmount === null}
                aria-describedby="checkout-tip-help"
              />
              <p id="checkout-tip-help" className={tipChoice === "custom" ? "" : "sr-only"}>
                {tipChoice === "custom" && customTip !== "" && tipAmount === null
                  ? checkoutText.tipInvalid
                  : checkoutText.tipHelp}
              </p>
              {tipCheck === "too_large" && quote !== null ? (
                <p role="alert">{checkoutText.tipTooLarge(formatCartMoney(quote.subtotal))}</p>
              ) : null}
              {tipCheck === "confirm" && quote !== null && tipAmount !== null ? (
                <div role="alert" className="checkout-tip__confirm">
                  <p>
                    {checkoutText.confirmLargeTip(
                      formatMoney(tipAmount, quote.subtotal.currency),
                      formatCartMoney(quote.subtotal),
                    )}
                  </p>
                  <button
                    type="button"
                    aria-pressed={confirmedTip === tipAmount}
                    onClick={() => setConfirmedTip(tipAmount)}
                  >
                    {checkoutText.yesTip(formatMoney(tipAmount, quote.subtotal.currency))}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setConfirmedTip(null);
                      document.getElementById("checkout-tip")?.focus();
                    }}
                  >
                    {checkoutText.changeTip}
                  </button>
                </div>
              ) : null}
            </section>
          )}
        </div>
        <section className="checkout-continue" aria-label={checkoutText.paymentLabel}>
          {continueRequested ? <p role="status">{checkoutText.savingYourDetails}</p> : null}
          {sessionState.status === "pending" ? (
            <p role="status">
              {payLater ? checkoutText.placingOrder : checkoutText.preparingPayment}
            </p>
          ) : null}
          {sendState === "sending" ? <p role="status">{checkoutText.placingOrder}</p> : null}
          {tableChange?.kind === "changed" ? (
            // WP-2423 (same-table-ordering): beside the action, where the guest is looking.
            // v15 batch 7: what staff took out is said as staff's, never someone at the table's.
            <p role="status">
              {[
                ...(tableChange.byStaff === undefined
                  ? []
                  : [
                      checkoutText.tableCartStaffRemoved(tableCartAddedDishes(tableChange.byStaff)),
                    ]),
                ...(tableChange.byStaff !== undefined &&
                tableChange.added.length +
                  tableChange.removed.length +
                  tableChange.reduced.length ===
                  0
                  ? []
                  : [checkoutText.tableCartChangedBy(tableCartChangedDishes(tableChange))]),
              ].join(" ")}
            </p>
          ) : null}
          {tableChange?.kind === "choiceEnded" ? (
            <p role="alert">
              {checkoutText.tableChoiceEnded(tableCartAddedDishes(tableChange.byStaff))}
            </p>
          ) : null}
          {menuUpdated && sessionState.status === "idle" && sendState === "idle" ? (
            <p role="status">{checkoutText.menuUpdatedPricedAgain}</p>
          ) : null}
          {sendState === "failed" ? <p role="alert">{checkoutText.orderUnconfirmed}</p> : null}
          {sendState === "pay_first" ? (
            <p role="alert">{checkoutText.tablePaysAsItOrders}</p>
          ) : null}
          {/* Sending again can't help with these: say why and offer what can. */}
          {sendState === "store_closed" ? <p role="alert">{refusedText}</p> : null}
          {sendState === "items_short" ? (
            <p role="alert">
              {checkoutItemRefusalMessage("item_short", null, cart?.cart.items ?? [])}{" "}
              <Link to="/cart">{checkoutText.changeYourCart}</Link>
            </p>
          ) : null}
          {serviceText !== null &&
          sessionState.status === "idle" &&
          sendState !== "store_closed" ? (
            <p role={service.phase === "Soon" ? "status" : "alert"} className="checkout-service">
              <strong>{serviceText.headline}</strong>
              {serviceText.detail === null ? null : <> {serviceText.detail}</>}
            </p>
          ) : null}
          {sessionState.status === "item_short" || sessionState.status === "item_unavailable" ? (
            <p role="alert">
              {checkoutItemRefusalMessage(
                sessionState.status,
                sessionState.line,
                cart?.cart.items ?? [],
              )}{" "}
              <Link to="/cart">{checkoutText.changeYourCart}</Link>
            </p>
          ) : sessionAlert !== null ? (
            <p role="alert">
              {sessionAlert}
              {sessionState.status === "conflict" ? (
                <>
                  {" "}
                  <Link to="/cart">{checkoutText.changeYourCart}</Link>
                </>
              ) : null}
            </p>
          ) : null}
          {tableChange?.kind === "choiceEnded" && sessionState.status === "idle" ? (
            // v15 batch 7: the old choice is over; the cart asks which dishes to pay again.
            <Link className="checkout-continue__button" to="/cart" replace>
              {checkoutText.chooseAgain}
            </Link>
          ) : tableChange?.kind === "changed" && sessionState.status === "idle" ? (
            <button
              type="button"
              className="checkout-continue__button"
              onClick={() => {
                setTableChange(null);
                void controller.load();
              }}
            >
              {checkoutText.checkOutWithNewTotal}
            </button>
          ) : (sendState === "failed" || sendState === "pay_first") &&
            sessionState.status === "ready" &&
            selectedTip.current !== null ? (
            <button
              type="button"
              className="checkout-continue__button"
              onClick={() => retrySend(sessionState.session.checkoutSessionReference)}
            >
              {sendState === "pay_first" ? checkoutText.continueToPayment : checkoutText.placeOrder}
            </button>
          ) : refusedItem ? (
            <Link className="checkout-continue__button" to="/cart">
              {checkoutText.changeYourCart}
            </Link>
          ) : sessionState.status === "store_closed" || sendState === "store_closed" ? (
            // WP-2423 item 8 ⑦ s1: closed or past last orders: retrying does not help now.
            <Link className="checkout-continue__button" to={dineIn ? "/dine-in/session" : "/menu"}>
              {dineIn ? checkoutText.backToYourTable : checkoutText.backToTheMenu}
            </Link>
          ) : "canRetry" in sessionState && sessionState.canRetry ? (
            <button
              type="button"
              onClick={() => void sessionController.retry()}
              disabled={state.status === "offline"}
            >
              {payLater ? checkoutText.placeOrderAgain : checkoutText.retryCheckout}
            </button>
          ) : (
            <button
              type="button"
              className="checkout-continue__button"
              disabled={
                !canContinue ||
                continueRequested ||
                sendState === "sending" ||
                sendState === "items_short"
              }
              onClick={() => void requestContinue()}
            >
              {quote === null && (state.status === "loading" || state.status === "pending")
                ? checkoutText.gettingYourTotal
                : payLater
                  ? quote
                    ? checkoutText.placeOrderWithTotal(
                        formatMoney(quote.total.amountMinor, quote.total.currency),
                      )
                    : checkoutText.placeOrder
                  : asksTip && tipChoice === null
                    ? checkoutText.chooseTipToContinue
                    : quote && tipAmount !== null
                      ? checkoutText.continueToPaymentWithTotal(
                          formatMoney(
                            (BigInt(quote.total.amountMinor) + BigInt(tipAmount)).toString(),
                            quote.total.currency,
                          ),
                        )
                      : checkoutText.continueToPayment}
            </button>
          )}
          <p className="checkout-continue__note">
            {payLater
              ? checkoutText.sendToKitchenNote
              : paymentConfiguration()?.mode === "simulation"
                ? checkoutText.continueNoteSimulated
                : checkoutText.continueNote}
          </p>
        </section>
      </div>
    </CustomerPage>
  );
}
