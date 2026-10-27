import { listSeparator, useReloadOnLanguageChange } from "../i18n/i18n.js";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Link } from "react-router";
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
import { cartItemShortMessage } from "../checkout/item-refusal-message.js";
import { CustomerPage, PageHeading, type CustomerStoreContext } from "../journey/CustomerPage.js";
import { formatMinutesUntil, formatMoney } from "../journey/format.js";
import {
  quoteConsistentLinePrices,
  cartLinesSubtotal,
  usePublishedMenu,
  type CartLinePrice,
} from "../menu/menu-line-prices.js";
import type { CustomerMenuClient, MenuJourneyContext, MenuView } from "../menu/types.js";
import {
  cartIssueMessage,
  cartItemWarningMessage,
  cartText,
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
}: {
  readonly item: CartItemView;
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
          {item.customerNote === null || foreign ? null : (
            <p className="cart-item__note">
              {commonText.notePrefix} {item.customerNote}
            </p>
          )}
        </div>
        <p className="cart-item__estimate">
          {price !== null
            ? formatMoney(price.amountMinor, price.currency)
            : item.lineEstimate.status === "Unavailable"
              ? lineEstimateLabel(item.lineEstimate.reasonCode)
              : formatCartMoney(item.lineEstimate.total)}
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
}: {
  readonly cart: CartView;
  readonly now: () => number;
  /** Every line's price before tax added up, when each one can be stated; null otherwise. */
  readonly subtotal: CartLinePrice | null;
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
          {subtotal === null ? cartText.summary.totalAtCheckout : cartText.summary.taxAtCheckout}
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
      <p className="cart-summary__validity">
        {remaining === null
          ? cartText.summary.pricesExpired
          : commonText.pricesConfirmedFor(remaining)}
      </p>
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
      </div>
    </StateMessage>
  );
}

function CartContent({
  state,
  controller,
  now,
  menu,
}: {
  readonly state: CartState;
  readonly controller: CartStateController;
  readonly now: () => number;
  readonly menu: MenuView | null;
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
    return (
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
      {cart.cart.warnings.includes("QUOTE_EXPIRED") ? (
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
              price={prices.get(item.cartItemReference) ?? null}
              pending={pending}
              readOnly={
                readOnly ||
                state.status === "command-failed" ||
                terminal ||
                cart.cart.warnings.includes("PROJECTION_STALE")
              }
              controller={controller}
            />
          ))}
        </section>
        <CartSummary cart={cart} now={now} subtotal={cartLinesSubtotal(prices)} />
      </div>
      <section className="cart-next-actions" aria-label={cartText.actionsLabel}>
        <Link to="/menu">{terminal ? commonText.browseMenu : cartText.continueShopping}</Link>
        {!terminal && !readOnly ? (
          <Link className="cart-checkout-link" to="/checkout">
            {cartText.checkout}
          </Link>
        ) : null}
      </section>
    </>
  );
}

export function CartPage({
  controller: provided,
  store,
  now = Date.now,
  menuContext,
  menuClient,
}: {
  readonly controller?: CartStateController;
  readonly store?: CustomerStoreContext | undefined;
  readonly now?: () => number;
  /** The published menu prices lines the Store hasn't priced yet (as shown on the item page). */
  readonly menuContext?: MenuJourneyContext | undefined;
  readonly menuClient?: CustomerMenuClient | undefined;
}) {
  const [controller] = useState(
    () => provided ?? createCartStateController({ client: createBrowserCustomerCartClient() }),
  );
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
  const menu = usePublishedMenu(
    menuContext,
    menuClient,
    cart?.items.some((item) => item.lineEstimate.status !== "Available") ?? false,
  );
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
        <CartContent state={state} controller={controller} now={now} menu={menu} />
      </div>
      <div className="sr-only" role="status" aria-live="polite">
        {cartText.stateAnnouncement[state.status]}
      </div>
    </CustomerPage>
  );
}
