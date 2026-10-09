import { useEffect, useState, useSyncExternalStore } from "react";
import { Link } from "react-router";
import { createBrowserCustomerCartClient } from "./cart-client.js";
import {
  createCartStateController,
  type CartState,
  type CartStateController,
} from "./cart-state.js";
import type { CartItemView, CartView } from "./types.js";
import { formatCartMoney } from "./format-money.js";
import { CustomerPage, PageHeading, type CustomerStoreContext } from "../journey/CustomerPage.js";
import { formatMinutesUntil } from "../journey/format.js";
import {
  cartIssueMessage,
  cartItemWarningMessage,
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
    .join(", ");
}

function CartItem({
  item,
  pending,
  readOnly,
  controller,
}: {
  readonly item: CartItemView;
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
            <p className="cart-item__note">Note: {item.customerNote}</p>
          )}
        </div>
        <p className="cart-item__estimate">
          {item.lineEstimate.status === "Unavailable"
            ? lineEstimateLabel(item.lineEstimate.reasonCode)
            : formatCartMoney(item.lineEstimate.total)}
        </p>
      </div>
      {foreign ? (
        <p className="cart-warning" id={ownershipDescription}>
          Added by another guest. Only they can change this item.
        </p>
      ) : null}
      {warnings.map((warning) => (
        <p className="cart-warning" key={warning}>
          {warning}
        </p>
      ))}
      <div className="cart-item__actions" aria-label={`Quantity for ${item.displayName}`}>
        <button
          type="button"
          aria-describedby={foreign ? ownershipDescription : undefined}
          disabled={readOnly || foreign || pending || item.quantity <= 1}
          aria-label={`Decrease ${item.displayName} quantity`}
          onClick={() => void updateQuantity(item.quantity - 1)}
        >
          −
        </button>
        <output aria-live="off" aria-label={`${item.displayName} quantity`}>
          {item.quantity}
        </output>
        <button
          type="button"
          aria-describedby={foreign ? ownershipDescription : undefined}
          disabled={readOnly || foreign || pending || item.quantity >= 100}
          aria-label={`Increase ${item.displayName} quantity`}
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
          Remove
        </button>
      </div>
    </article>
  );
}

function CartSummary({ cart, now }: { readonly cart: CartView; readonly now: () => number }) {
  if (cart.cart.lifecycle.status !== "Active")
    return (
      <section className="cart-summary" aria-labelledby="cart-summary-heading">
        <h2 id="cart-summary-heading">Order summary</h2>
        <p>Checkout is unavailable for this cart.</p>
      </section>
    );
  const quote = cart.cart.quote;
  if (quote === null || quote.cartVersion !== cart.cart.version)
    return (
      <section className="cart-summary" aria-labelledby="cart-summary-heading">
        <h2 id="cart-summary-heading">Order summary</h2>
        <p>Your total, including tax, is calculated at checkout.</p>
      </section>
    );
  const remaining = formatMinutesUntil(quote.expiresAt, now());
  return (
    <section className="cart-summary" aria-labelledby="cart-summary-heading">
      <h2 id="cart-summary-heading">Order summary</h2>
      <dl>
        <div>
          <dt>Subtotal</dt>
          <dd>{formatCartMoney(quote.subtotal)}</dd>
        </div>
        {quote.discount.amountMinor !== "0" ? (
          <div>
            <dt>Discount</dt>
            <dd>{formatCartMoney(quote.discount)}</dd>
          </div>
        ) : null}
        <div>
          <dt>Tax</dt>
          <dd>{formatCartMoney(quote.tax)}</dd>
        </div>
        {quote.fee.amountMinor !== "0" ? (
          <div>
            <dt>Fees</dt>
            <dd>{formatCartMoney(quote.fee)}</dd>
          </div>
        ) : null}
        <div className="cart-summary__total">
          <dt>Total</dt>
          <dd>{formatCartMoney(quote.total)}</dd>
        </div>
      </dl>
      <p className="cart-summary__validity">
        {remaining === null
          ? "These prices have expired. Checkout will price your order again."
          : `Prices confirmed for ${remaining}.`}
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
  const messages = {
    "replacement-forbidden": [
      "Cart replacement not permitted",
      "Ask the table host or staff to help you continue ordering.",
    ],
    "session-expired": [
      "Session expired",
      "Scan the location QR code again to continue your order.",
    ],
    "not-found": ["Cart unavailable", "This cart is not available in your current session."],
    conflict: [
      "Cart changed",
      "The latest cart was loaded. Review your change before submitting again.",
    ],
    validation: ["Review this item", "This choice can’t be ordered as selected."],
    "rate-limited": [
      "Please wait",
      `Try again${state.retryAfterSeconds === null ? " shortly" : ` in ${state.retryAfterSeconds} seconds`}.`,
    ],
    expired: [
      "Cart expired",
      "This cart cannot accept more items. Ask staff for help continuing your order.",
    ],
    abandoned: ["Cart closed", "This cart was abandoned and cannot be changed."],
    "command-failed": [
      "Outcome not confirmed",
      "The connection dropped before we could confirm your change.",
    ],
    unavailable: ["Cart temporarily unavailable", "Nothing was changed. Try loading it again."],
  } as const;
  const message = messages[state.status as keyof typeof messages];
  if (message === undefined) return null;
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
            Retry the same operation
          </button>
        ) : (
          <button type="button" onClick={() => void controller.load()}>
            Refresh cart
          </button>
        )}
        <Link to="/menu">Return to menu</Link>
      </div>
    </StateMessage>
  );
}

function CartContent({
  state,
  controller,
  now,
}: {
  readonly state: CartState;
  readonly controller: CartStateController;
  readonly now: () => number;
}) {
  if (state.status === "loading")
    return (
      <StateMessage heading="Loading cart">
        <p>Checking your cart…</p>
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
      <StateMessage heading="Your cart is empty">
        <p>Add something from the menu to get started.</p>
        <Link className="cart-primary-link" to="/menu">
          Browse menu
        </Link>
      </StateMessage>
    );
  const cart = "cart" in state ? state.cart : null;
  if (cart === null) {
    if (state.status === "offline-readonly")
      return (
        <StateMessage heading="You’re offline" tone="warning">
          <p>Reconnect to load your cart.</p>
          <button type="button" onClick={() => void controller.load()}>
            Refresh after reconnecting
          </button>
          <Link to="/menu">Return to menu</Link>
        </StateMessage>
      );
    return <ErrorState state={state} controller={controller} />;
  }
  if (cart.cart.warnings.includes("FEATURE_DISABLED"))
    return (
      <StateMessage heading="Cart unavailable" tone="warning">
        <p>Cart ordering is not enabled at this location right now.</p>
        <Link to="/menu">Return to menu</Link>
      </StateMessage>
    );
  const readOnly = state.status === "offline-readonly";
  const pending = state.status === "command-pending";
  const terminal = cart.cart.lifecycle.status !== "Active";
  const count = cart.cart.items.reduce((total, item) => total + item.quantity, 0);
  return (
    <>
      {terminal ? (
        <StateMessage
          heading={cart.cart.lifecycle.status === "Expired" ? "Cart expired" : "Cart closed"}
          tone="warning"
        >
          <p>This cart cannot accept more items. Your previously paid orders remain unchanged.</p>
          {cart.cart.orderType === "DineIn" && controller.replaceExpiredCart !== undefined ? (
            <>
              <p>
                The table host can start an empty cart to continue ordering. Previous items will not
                be copied.
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
                Start an empty cart
              </button>
            </>
          ) : (
            <p>Ask staff for help continuing your order.</p>
          )}
        </StateMessage>
      ) : null}
      {readOnly ? (
        <div className="cart-offline" role="status">
          You’re offline. Changes and checkout are paused; nothing will replay on reconnect.
          <button type="button" onClick={() => void controller.load()}>
            Refresh after reconnecting
          </button>
        </div>
      ) : null}
      {state.status !== "ready" && state.status !== "command-pending" && !readOnly ? (
        <ErrorState state={state} controller={controller} />
      ) : null}
      {cart.cart.warnings.includes("PROJECTION_STALE") ? (
        <div className="cart-stale" role="status">
          Your cart may be out of date. Refresh before making a change.
        </div>
      ) : null}
      {cart.cart.warnings.includes("QUOTE_EXPIRED") ? (
        <div className="cart-stale" role="status">
          Prices have expired. Checkout will price your order again.
        </div>
      ) : null}
      <div className="cart-layout" aria-busy={pending}>
        <section className="cart-items" aria-labelledby="cart-items-heading">
          <div className="cart-page__subheading">
            <h2 id="cart-items-heading">Items</h2>
            <span>{count === 1 ? "1 item" : `${count} items`}</span>
          </div>
          {cart.cart.items.map((item) => (
            <CartItem
              key={item.cartItemReference}
              item={item}
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
        <CartSummary cart={cart} now={now} />
      </div>
      <section className="cart-next-actions" aria-label="Cart actions">
        <Link to="/menu">{terminal ? "Browse menu" : "Continue shopping"}</Link>
        {!terminal && !readOnly ? (
          <Link className="cart-checkout-link" to="/checkout">
            Checkout
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
}: {
  readonly controller?: CartStateController;
  readonly store?: CustomerStoreContext | undefined;
  readonly now?: () => number;
}) {
  const [controller] = useState(
    () => provided ?? createCartStateController({ client: createBrowserCustomerCartClient() }),
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
  const cart = "cart" in state && state.cart !== null ? state.cart.cart : null;
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
      <PageHeading title="Your cart" />
      <div id="cart-content">
        <CartContent state={state} controller={controller} now={now} />
      </div>
      <div className="sr-only" role="status" aria-live="polite">
        {state.status === "command-pending" ? "Cart change pending" : `Cart state ${state.status}`}
      </div>
    </CustomerPage>
  );
}
