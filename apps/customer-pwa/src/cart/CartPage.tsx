import { listSeparator, useReloadOnLanguageChange } from "../i18n/i18n.js";
import {
  getGuestTableStarter,
  isGuestTableQuestion,
} from "../session/customer-transaction-context.js";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Link, useNavigate } from "react-router";
import { createBrowserCustomerCartClient } from "./cart-client.js";
import {
  createCartStateController,
  type CartState,
  type CartStateController,
} from "./cart-state.js";
import {
  checkoutInProgressMessage,
  orderProcessingMessage,
  type CartItemView,
  type CartView,
} from "./types.js";
import { formatCartMoney } from "./format-money.js";
import {
  cartItemShortMessage,
  checkoutItemRefusalMessage,
} from "../checkout/item-refusal-message.js";
import {
  sharedSendRoundController,
  type SeenSubtotal,
  type SendRoundController,
  type SendRoundState,
} from "../checkout/send-round.js";
import { DiningStaffCallPanel } from "../dining/DiningStaffCallPanel.js";
import type { DiningSessionClient } from "../dining/dining-session-client.js";
import { useTablePaymentTiming, type TableTimingAnswer } from "../dining/table-timing.js";
import { CustomerPage, PageHeading, type CustomerStoreContext } from "../journey/CustomerPage.js";
import { formatMinutesUntil, formatMoney } from "../journey/format.js";
import { SlowWaitNote } from "../journey/SlowWaitNote.js";
import {
  quoteConsistentLinePrices,
  cartLinesSubtotal,
  usePublishedMenuRead,
  type CartLinePrice,
} from "../menu/menu-line-prices.js";
import type { CustomerMenuClient, MenuJourneyContext, MenuView } from "../menu/types.js";
import { comboLineAllergenText } from "../menu/combo-allergens.js";
import {
  cartIssueMessage,
  cartItemWarningMessage,
  cartText,
  checkoutText,
  commonText,
  lineEstimateLabel,
  quoteIssueMessage,
} from "../journey/messages.js";

function StateMessage({
  heading,
  children,
  tone = "neutral",
}: {
  readonly heading: string;
  readonly children: React.ReactNode;
  readonly tone?: "neutral" | "warning" | "error";
}) {
  return (
    <section className={`cart-state cart-state--${tone}`} aria-labelledby="cart-state-heading">
      <h2 id="cart-state-heading" tabIndex={-1}>
        {heading}
      </h2>
      {children}
    </section>
  );
}

/** "Oat milk, Extra shot × 2" or nothing for a standard item. */
export function describeConfiguration(item: CartItemView): string | null {
  if (item.configuration.length === 0) return null;
  return item.configuration
    .map((option) =>
      option.quantity === 1 ? option.displayName : `${option.displayName} × ${option.quantity}`,
    )
    .join(listSeparator());
}

function CartItem({
  item,
  pending,
  readOnly,
  controller,
  price,
  allergens,
  payLater,
}: {
  readonly item: CartItemView;
  /** WP-2423 item 6: a table that pays at the end has no checkout to promise a price at. */
  readonly payLater: boolean;
  /** WP-2423 item 8 ⑥ part 4: a combo's chosen dishes' allergens (null for other lines). */
  readonly allergens: string | null;
  /** The line's price before tax when it can be stated (the Store's, or the published one). */
  readonly price: CartLinePrice | null;
  readonly pending: boolean;
  readonly readOnly: boolean;
  readonly controller: CartStateController;
}) {
  const foreign = item.warnings.includes("OTHER_PARTICIPANT_ITEM");
  const ownershipDescription = `cart-item-ownership-${item.cartItemReference}`;
  const configuration = describeConfiguration(item);
  const updateQuantity = (quantity: number) =>
    controller.updateItem(item.cartItemReference, {
      quantity,
      optionSelections: item.configuration.map((option) => ({
        optionReference: option.optionReference,
        quantity: option.quantity,
      })),
      customerNote: item.customerNote,
    });
  const warnings = item.warnings
    .map(cartItemWarningMessage)
    .filter((message): message is string => message !== null);
  return (
    <article className="cart-item" aria-labelledby={`cart-item-${item.cartItemReference}`}>
      <div className="cart-item__heading">
        <div>
          <h3 id={`cart-item-${item.cartItemReference}`}>{item.displayName}</h3>
          {configuration ? <p className="cart-item__configuration">{configuration}</p> : null}
          {allergens === null ? null : <p className="cart-item__allergens">{allergens}</p>}
          {item.customerNote === null || foreign ? null : (
            <p className="cart-item__note">
              {commonText.notePrefix} {item.customerNote}
            </p>
          )}
        </div>
        <p className="cart-item__estimate">
          {price !== null
            ? formatMoney(price.amountMinor, price.currency)
            : item.lineEstimate.status !== "Unavailable"
              ? formatCartMoney(item.lineEstimate.total)
              : payLater
                ? null
                : lineEstimateLabel(item.lineEstimate.reasonCode)}
        </p>
      </div>
      {foreign ? (
        <p className="cart-warning" id={ownershipDescription}>
          {cartText.line.addedByAnotherGuest}
        </p>
      ) : null}
      {warnings.map((warning) => (
        <p className="cart-warning" key={warning}>
          {warning}
        </p>
      ))}
      <div
        className="cart-item__actions"
        aria-label={cartText.line.quantityGroupLabel(item.displayName)}
      >
        <button
          type="button"
          aria-describedby={foreign ? ownershipDescription : undefined}
          disabled={readOnly || foreign || pending || item.quantity <= 1}
          aria-label={cartText.line.decreaseLabel(item.displayName)}
          onClick={() => void updateQuantity(item.quantity - 1)}
        >
          −
        </button>
        <output aria-live="off" aria-label={cartText.line.quantityLabel(item.displayName)}>
          {item.quantity}
        </output>
        <button
          type="button"
          aria-describedby={foreign ? ownershipDescription : undefined}
          disabled={readOnly || foreign || pending || item.quantity >= 100}
          aria-label={cartText.line.increaseLabel(item.displayName)}
          onClick={() => void updateQuantity(item.quantity + 1)}
        >
          +
        </button>
        <button
          className="cart-link-button"
          type="button"
          aria-describedby={foreign ? ownershipDescription : undefined}
          disabled={readOnly || foreign || pending}
          onClick={() => void controller.removeItem(item.cartItemReference)}
        >
          {cartText.line.remove}
        </button>
      </div>
    </article>
  );
}

function CartSummary({
  cart,
  now,
  subtotal,
  payLater,
}: {
  readonly cart: CartView;
  readonly now: () => number;
  /** Every line's price before tax added up, when each one can be stated; null otherwise. */
  readonly subtotal: CartLinePrice | null;
  /** WP-2423 item 6: the table pays at the end: no checkout to point at, no prices to lock. */
  readonly payLater: boolean;
}) {
  if (cart.cart.lifecycle.status !== "Active")
    return (
      <section className="cart-summary" aria-labelledby="cart-summary-heading">
        <h2 id="cart-summary-heading">{cartText.summary.heading}</h2>
        <p>{cartText.summary.checkoutUnavailable}</p>
      </section>
    );
  const quote = cart.cart.quote;
  if (quote === null || quote.cartVersion !== cart.cart.version)
    return (
      <section className="cart-summary" aria-labelledby="cart-summary-heading">
        <h2 id="cart-summary-heading">{cartText.summary.heading}</h2>
        {subtotal === null ? null : (
          <dl>
            <div className="cart-summary__total">
              <dt>{cartText.summary.subtotalBeforeTax}</dt>
              <dd>{formatMoney(subtotal.amountMinor, subtotal.currency)}</dd>
            </div>
          </dl>
        )}
        <p>
          {payLater
            ? subtotal === null
              ? cartText.summary.totalOnTableBill
              : cartText.summary.taxOnTableBill
            : subtotal === null
              ? cartText.summary.totalAtCheckout
              : cartText.summary.taxAtCheckout}
        </p>
      </section>
    );
  const remaining = formatMinutesUntil(quote.expiresAt, now());
  return (
    <section className="cart-summary" aria-labelledby="cart-summary-heading">
      <h2 id="cart-summary-heading">{cartText.summary.heading}</h2>
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
        <div className="cart-summary__total">
          <dt>{commonText.total}</dt>
          <dd>{formatCartMoney(quote.total)}</dd>
        </div>
      </dl>
      {payLater ? null : (
        <p className="cart-summary__validity">
          {remaining === null
            ? cartText.summary.pricesExpired
            : commonText.pricesConfirmedFor(remaining)}
        </p>
      )}
      {[
        ...quote.blockingReasons.map((code) => quoteIssueMessage(code, true)),
        ...quote.warnings.map((code) => quoteIssueMessage(code, false)),
      ].map((message, index) => (
        <p className="cart-warning" key={`${index}:${message}`}>
          {message}
        </p>
      ))}
    </section>
  );
}

function ErrorState({
  state,
  controller,
}: {
  readonly state: CartState;
  readonly controller: CartStateController;
}) {
  if (!("cart" in state) || !("issueCodes" in state)) return null;
  const retry = state.status === "command-failed" && state.canRetrySameOperation;
  const failure = cartText.failure;
  const messages = {
    "replacement-forbidden": failure.replacementForbidden,
    "session-expired": failure.sessionExpired,
    "not-found": failure.notFound,
    conflict: failure.conflict,
    validation: failure.validation,
    "rate-limited": [failure.rateLimitedHeading, failure.rateLimited(state.retryAfterSeconds)],
    expired: [
      failure.expiredHeading,
      state.cart?.cart.orderType === "DineIn" ? failure.expiredDineIn : failure.expiredOther,
    ],
    abandoned: failure.abandoned,
    "order-processing": [
      commonText.orderProcessingHeading,
      orderProcessingMessage(state.retryAfterSeconds),
    ],
    "checkout-in-progress": [
      commonText.checkoutInProgressHeading,
      checkoutInProgressMessage(state.retryAfterSeconds),
    ],
    "table-checking-out": failure.tableCheckingOut,
    "not-seated": failure.notSeated,
    "command-failed": failure.commandFailed,
    unavailable: failure.unavailable,
  } as const;
  const message = messages[state.status as keyof typeof messages];
  if (message === undefined) return null;
  // WP-2423: a quantity the store can't make names the item and how many it can.
  const short =
    state.shortItem === undefined || state.cart === null
      ? null
      : cartItemShortMessage(
          state.shortItem.cartItemReference,
          state.shortItem.available,
          state.cart.cart.items,
        );
  if (short !== null)
    return (
      <StateMessage heading={failure.notEnoughLeftHeading} tone="warning">
        <p>{short}</p>
      </StateMessage>
    );
  const issues = state.issueCodes
    .map(cartIssueMessage)
    .filter((issue): issue is string => issue !== null);
  return (
    <StateMessage heading={message[0]} tone={state.status === "conflict" ? "warning" : "error"}>
      <p>{message[1]}</p>
      {issues.map((issue) => (
        <p key={issue}>{issue}</p>
      ))}
      <div className="cart-state__actions">
        {retry ? (
          <button type="button" onClick={() => void controller.retry()}>
            {failure.retrySameOperation}
          </button>
        ) : (
          <button type="button" onClick={() => void controller.load()}>
            {failure.refreshCart}
          </button>
        )}
        <Link to="/menu">{commonText.returnToMenu}</Link>
        {state.status === "not-seated" && (isGuestTableQuestion() || getGuestTableStarter()) ? (
          <Link to="/">{failure.goToStart}</Link>
        ) : null}
      </div>
    </StateMessage>
  );
}

/**
 * WP-2423 item 6: what a stopped send says, under the button. Nothing here repeats an unknown answer:
 * that one has its own panel, above everything, because the cart it was about may be gone.
 */
function SendRoundMessage({
  round,
  cart,
  onRetry,
}: {
  readonly round: SendRoundState;
  readonly cart: CartView;
  readonly onRetry: () => void;
}) {
  switch (round.status) {
    case "confirm-total": {
      const total = formatCartMoney(round.total);
      return (
        <p role="alert">
          {round.reason === "changed"
            ? cartText.priceChangedTotal(total)
            : round.reason === "fees"
              ? cartText.orderComesToWithFees(total)
              : cartText.orderComesTo(total)}
        </p>
      );
    }
    case "blocked":
      return (
        <div role="alert">
          {round.messages.map((message) => (
            <p key={message}>{message}</p>
          ))}
        </div>
      );
    case "refused":
      return (
        <p role="alert">{checkoutItemRefusalMessage(round.refusal, round.line, cart.cart.items)}</p>
      );
    case "store-closed":
      return (
        <div role="alert">
          <p>{checkoutText.storeClosed}</p>
          <Link to="/dine-in/session">{checkoutText.backToYourTable}</Link>
        </div>
      );
    case "busy":
      return (
        <div role="alert">
          <p>
            {round.wait === "order-processing"
              ? orderProcessingMessage(round.retryAfterSeconds)
              : checkoutInProgressMessage(round.retryAfterSeconds)}
          </p>
          <button type="button" onClick={onRetry}>
            {commonText.tryAgain}
          </button>
        </div>
      );
    case "table-checking-out":
      return <p role="alert">{cartText.failure.tableCheckingOut[1]}</p>;
    case "session-ended":
      return <p role="alert">{checkoutText.sessionEnded}</p>;
    case "cart-changed":
      return <p role="alert">{cartText.failure.conflict[1]}</p>;
    default:
      return null;
  }
}

/** The answer to a send got lost: it may or may not have been placed, and asking again is safe. */
function UnconfirmedOrder({
  online,
  onRetry,
}: {
  readonly online: boolean;
  readonly onRetry: () => void;
}) {
  return (
    <>
      <section className="checkout-attention" role="alert">
        <p>{cartText.orderUnconfirmed}</p>
        <button type="button" disabled={!online} onClick={onRetry}>
          {commonText.tryAgain}
        </button>
        <Link to="/dine-in/session">{cartText.checkYourTable}</Link>
      </section>
      <DiningStaffCallPanel />
    </>
  );
}

function CartContent({
  state,
  controller,
  now,
  menu,
  timing,
  round,
  menuSettled,
  onPlace,
}: {
  readonly state: CartState;
  readonly controller: CartStateController;
  readonly now: () => number;
  readonly menu: MenuView | null;
  /** WP-2423 item 6: how this table pays, and where its one-tap order stands. */
  readonly timing: TableTimingAnswer;
  readonly round: SendRoundState;
  /** Prices have been read, or that read took too long to wait for. */
  readonly menuSettled: boolean;
  readonly onPlace: (cart: CartView, seen: SeenSubtotal | null) => void;
}) {
  if (state.status === "loading")
    return (
      <StateMessage heading={cartText.loadingHeading}>
        <p>{commonText.checkingYourCart}</p>
      </StateMessage>
    );
  if (
    state.status === "empty" ||
    (state.status === "ready" &&
      state.cart.cart.lifecycle.status === "Active" &&
      state.cart.cart.items.length === 0 &&
      state.cart.cart.warnings.length === 0)
  )
    return round.status === "cart-changed" ? (
      // A second phone tapped after the first sent: without this she'd add it all again.
      <StateMessage heading={cartText.someonePlacedIt}>
        <div className="cart-state__actions">
          <Link className="cart-primary-link" to="/dine-in/session">
            {cartText.seeYourTable}
          </Link>
          <Link to="/menu">{commonText.browseMenu}</Link>
        </div>
      </StateMessage>
    ) : (
      <StateMessage heading={commonText.emptyCartHeading}>
        <p>{cartText.emptyBody}</p>
        <Link className="cart-primary-link" to="/menu">
          {commonText.browseMenu}
        </Link>
      </StateMessage>
    );
  const cart = "cart" in state ? state.cart : null;
  if (cart === null) {
    if (state.status === "offline-readonly")
      return (
        <StateMessage heading={commonText.offlineHeading} tone="warning">
          <p>{cartText.offline.reconnectToLoad}</p>
          <button type="button" onClick={() => void controller.load()}>
            {cartText.offline.refreshAfterReconnecting}
          </button>
          <Link to="/menu">{commonText.returnToMenu}</Link>
        </StateMessage>
      );
    return <ErrorState state={state} controller={controller} />;
  }
  if (cart.cart.warnings.includes("FEATURE_DISABLED"))
    return (
      <StateMessage heading={cartText.featureDisabled.heading} tone="warning">
        <p>{cartText.featureDisabled.body}</p>
        <Link to="/menu">{commonText.returnToMenu}</Link>
      </StateMessage>
    );
  const readOnly = state.status === "offline-readonly";
  const pending = state.status === "command-pending";
  const terminal = cart.cart.lifecycle.status !== "Active";
  const count = cart.cart.items.reduce((total, item) => total + item.quantity, 0);
  const payLater = timing === "PayLater";
  // WP-2423 item 6: while a round is on its way the cart holds still: a change now would refuse the
  // round, and leaving would hide what it answers. An unknown answer holds it too.
  const sending = round.status === "sending";
  const held = sending || round.status === "unconfirmed";
  const othersItems = cart.cart.items
    .filter((item) => item.warnings.includes("OTHER_PARTICIPANT_ITEM"))
    .reduce((total, item) => total + item.quantity, 0);
  const currentQuote =
    cart.cart.quote !== null && cart.cart.quote.cartVersion === cart.cart.version
      ? cart.cart.quote.subtotal
      : null;
  const prices = quoteConsistentLinePrices(cart.cart.items, menu, currentQuote);
  return (
    <>
      {terminal ? (
        <StateMessage
          heading={
            cart.cart.lifecycle.status === "Expired"
              ? cartText.closed.expiredHeading
              : cartText.closed.closedHeading
          }
          tone="warning"
        >
          <p>{cartText.closed.body}</p>
          {cart.cart.orderType === "DineIn" && controller.replaceExpiredCart !== undefined ? (
            <>
              <p>
                {cart.cart.lifecycle.status === "Expired"
                  ? cartText.closed.anyoneCanRestart
                  : cartText.closed.starterCanRestart}
              </p>
              <button
                type="button"
                disabled={
                  readOnly ||
                  pending ||
                  state.status === "command-failed" ||
                  state.status === "replacement-forbidden" ||
                  cart.cart.warnings.includes("PROJECTION_STALE")
                }
                onClick={() => void controller.replaceExpiredCart?.()}
              >
                {cartText.closed.startEmptyCart}
              </button>
            </>
          ) : (
            <p>{cartText.closed.askStaff}</p>
          )}
        </StateMessage>
      ) : null}
      {readOnly ? (
        <div className="cart-offline" role="status">
          {cartText.offline.paused}
          <button type="button" onClick={() => void controller.load()}>
            {cartText.offline.refreshAfterReconnecting}
          </button>
        </div>
      ) : null}
      {state.status !== "ready" && state.status !== "command-pending" && !readOnly ? (
        <ErrorState state={state} controller={controller} />
      ) : null}
      {cart.cart.warnings.includes("PROJECTION_STALE") ? (
        <div className="cart-stale" role="status">
          {cartText.stale}
        </div>
      ) : null}
      {cart.cart.warnings.includes("QUOTE_EXPIRED") && !payLater ? (
        <div className="cart-stale" role="status">
          {cartText.quoteExpired}
        </div>
      ) : null}
      <div className="cart-layout" aria-busy={pending}>
        <section className="cart-items" aria-labelledby="cart-items-heading">
          <div className="cart-page__subheading">
            <h2 id="cart-items-heading">{cartText.itemsHeading}</h2>
            <span>{cartText.itemCount(count)}</span>
          </div>
          {cart.cart.items.map((item) => (
            <CartItem
              key={item.cartItemReference}
              item={item}
              allergens={comboLineAllergenText(
                menu,
                item.sellableReference,
                item.configuration.map((option) => option.optionReference),
              )}
              price={prices.get(item.cartItemReference) ?? null}
              payLater={payLater}
              pending={pending}
              readOnly={
                readOnly ||
                held ||
                state.status === "command-failed" ||
                terminal ||
                cart.cart.warnings.includes("PROJECTION_STALE")
              }
              controller={controller}
            />
          ))}
        </section>
        <CartSummary
          cart={cart}
          now={now}
          subtotal={cartLinesSubtotal(prices)}
          payLater={payLater}
        />
      </div>
      <section className="cart-next-actions" aria-label={cartText.actionsLabel}>
        {sending ? (
          <Link
            to="/menu"
            aria-disabled="true"
            tabIndex={-1}
            onClick={(event) => event.preventDefault()}
          >
            {cartText.continueShopping}
          </Link>
        ) : (
          <Link to="/menu">{terminal ? commonText.browseMenu : cartText.continueShopping}</Link>
        )}
        {terminal || readOnly ? null : timing === "Loading" ? (
          <button className="cart-checkout-link" type="button" disabled>
            {cartText.continueWaiting}
          </button>
        ) : payLater ? (
          <div className="cart-next-actions__place">
            {othersItems === 0 ? null : (
              <p className="cart-next-actions__note">{cartText.alsoPlacesOthers(othersItems)}</p>
            )}
            <p className="cart-next-actions__note">{cartText.allergiesBeforeOrdering}</p>
            <button
              className="cart-checkout-link"
              type="button"
              disabled={
                held ||
                state.status !== "ready" ||
                !menuSettled ||
                cart.cart.warnings.includes("PROJECTION_STALE")
              }
              onClick={() => onPlace(cart, cartLinesSubtotal(prices))}
            >
              {sending
                ? cartText.placingOrder
                : round.status === "confirm-total"
                  ? cartText.placeOrderWithTotal(formatCartMoney(round.total))
                  : cartText.placeOrder}
            </button>
            <SlowWaitNote active={sending}>{cartText.placedSlowly}</SlowWaitNote>
            <SendRoundMessage
              round={round}
              cart={cart}
              onRetry={() => onPlace(cart, cartLinesSubtotal(prices))}
            />
            <p className="cart-next-actions__note">{checkoutText.sendToKitchenNote}</p>
          </div>
        ) : (
          <Link className="cart-checkout-link" to="/checkout">
            {cartText.checkout}
          </Link>
        )}
      </section>
    </>
  );
}

/** Cart prices come from a full menu read; an ordinary guest gets one tap once it's in. */
const menuPriceWaitMs = 2_000;

export function CartPage({
  controller: provided,
  store,
  now = Date.now,
  menuContext,
  menuClient,
  sendRound,
  diningClient,
}: {
  readonly controller?: CartStateController;
  readonly store?: CustomerStoreContext | undefined;
  readonly now?: () => number;
  /** The published menu prices lines the Store hasn't priced yet (as shown on the item page). */
  readonly menuContext?: MenuJourneyContext | undefined;
  readonly menuClient?: CustomerMenuClient | undefined;
  /** WP-2423 item 6: the one-tap order at a table that pays at the end (tests inject). */
  readonly sendRound?: SendRoundController | undefined;
  /** How the table pays, when it isn't known yet (tests inject). */
  readonly diningClient?: DiningSessionClient | undefined;
}) {
  const [controller] = useState(
    () => provided ?? createCartStateController({ client: createBrowserCustomerCartClient() }),
  );
  const [round] = useState(() => sendRound ?? sharedSendRoundController());
  const navigate = useNavigate();
  const roundState = useSyncExternalStore(round.subscribe, round.getState, round.getState);
  const [online, setOnline] = useState(
    () => typeof navigator === "undefined" || navigator.onLine !== false,
  );
  useEffect(() => {
    const update = () => setOnline(navigator.onLine !== false);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getState,
    controller.getState,
  );
  // Owner 2026-10-23: item names come from the Store in the chosen language.
  useReloadOnLanguageChange(() => void controller.load());
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
  const cart = "cart" in state && state.cart !== null ? state.cart.cart : null;
  const { menu, settled } = usePublishedMenuRead(
    menuContext,
    menuClient,
    // Also for a line with choices: a combo's chosen dishes show their allergens.
    cart?.items.some(
      (item) => item.lineEstimate.status !== "Available" || item.configuration.length > 0,
    ) ?? false,
  );
  const [menuWaitOver, setMenuWaitOver] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setMenuWaitOver(true), menuPriceWaitMs);
    return () => window.clearTimeout(timer);
  }, []);
  const timing = useTablePaymentTiming(cart?.orderType === "DineIn", diningClient);
  // Leaving forgets a stop; an answer still unknown stays, to be finished when the guest is back.
  useEffect(
    () => () => {
      const left = round.getState().status;
      if (left !== "sending" && left !== "unconfirmed") round.reset();
    },
    [round],
  );
  // What the send's answer means for this page, once.
  const acted = useRef<SendRoundState | null>(null);
  useEffect(() => {
    if (acted.current === roundState) return;
    acted.current = roundState;
    if (roundState.status === "sent") {
      round.reset();
      void navigate("/dine-in/session", {
        replace: true,
        state: { placed: roundState.held ? "Held" : "Sent" },
      });
    } else if (roundState.status === "needs-page" || roundState.status === "pay-first") {
      round.reset();
      void navigate("/checkout");
    } else if (
      roundState.status === "confirm-total" ||
      roundState.status === "cart-changed" ||
      roundState.status === "refused"
    )
      // The summary shows the quote's total; a changed cart shows what it holds now.
      void controller.load();
  }, [controller, navigate, round, roundState]);
  const resolvedStore: CustomerStoreContext | undefined =
    store ??
    (cart
      ? {
          storeName: cart.context.storeName,
          brandName: cart.context.brandName,
          serviceMode: cart.orderType,
        }
      : undefined);
  return (
    <CustomerPage step="cart" store={resolvedStore} className="cart-page">
      <PageHeading title={cartText.pageHeading} />
      <div id="cart-content">
        {roundState.status === "unconfirmed" ? (
          <UnconfirmedOrder
            online={online}
            onRetry={() => void round.send("cart" in state ? state.cart : null, null)}
          />
        ) : null}
        <CartContent
          state={state}
          controller={controller}
          now={now}
          menu={menu}
          timing={timing}
          round={roundState}
          menuSettled={settled || menuWaitOver}
          onPlace={(placed, seen) => void round.send(placed, seen)}
        />
      </div>
      <div className="sr-only" role="status" aria-live="polite">
        {roundState.status === "cart-changed" && cart !== null && cart.items.length === 0
          ? cartText.someonePlacedIt
          : roundState.status === "cart-changed" && state.status === "empty"
            ? cartText.someonePlacedIt
            : cartText.stateAnnouncement[state.status]}
      </div>
    </CustomerPage>
  );
}
