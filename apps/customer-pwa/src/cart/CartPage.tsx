import { useEffect, useState, useSyncExternalStore } from "react";
import { createBrowserCustomerCartClient } from "./cart-client.js";
import {
  createCartStateController,
  type CartState,
  type CartStateController,
} from "./cart-state.js";
import type { CartItemView, CartMoney, CartView } from "./types.js";

function exactMoney(value: CartMoney): string {
  return `${value.currency} ${value.amountMinor} minor units`;
}

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

function CartItem({
  cart,
  item,
  pending,
  readOnly,
  controller,
}: {
  readonly cart: CartView;
  readonly item: CartItemView;
  readonly pending: boolean;
  readonly readOnly: boolean;
  readonly controller: CartStateController;
}) {
  const unavailable = item.lineEstimate.status === "Unavailable";
  const updateQuantity = (quantity: number) =>
    controller.updateItem(item.cartItemReference, {
      quantity,
      optionSelections: item.configuration.map((option) => ({
        optionReference: option.optionReference,
        quantity: option.quantity,
      })),
      customerNote: item.customerNote,
    });
  return (
    <article className="cart-item" aria-labelledby={`cart-item-${item.cartItemReference}`}>
      <div className="cart-item__heading">
        <div>
          <h3 id={`cart-item-${item.cartItemReference}`}>{item.displayName}</h3>
          <p className="cart-item__configuration">
            {item.configuration.length === 0
              ? "Standard configuration"
              : item.configuration
                  .map((option) =>
                    option.quantity === 1
                      ? option.displayName
                      : `${option.displayName} × ${option.quantity}`,
                  )
                  .join(", ")}
          </p>
        </div>
        <p className="cart-item__estimate">
          {unavailable
            ? `Estimate unavailable: ${item.lineEstimate.reasonCode}`
            : exactMoney(item.lineEstimate.total)}
        </p>
      </div>
      {item.customerNote === null ? null : (
        <p className="cart-item__note">Note: {item.customerNote}</p>
      )}
      {item.warnings.map((warning) => (
        <p className="cart-warning" key={warning}>
          Warning: {warning}
        </p>
      ))}
      <div className="cart-item__actions" aria-label={`Quantity for ${item.displayName}`}>
        <button
          type="button"
          disabled={readOnly || pending || item.quantity <= 1}
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
          disabled={readOnly || pending || item.quantity >= 100}
          aria-label={`Increase ${item.displayName} quantity`}
          onClick={() => void updateQuantity(item.quantity + 1)}
        >
          +
        </button>
        <button
          className="cart-link-button"
          type="button"
          disabled={readOnly || pending}
          onClick={() => void controller.removeItem(item.cartItemReference)}
        >
          Remove
        </button>
      </div>
      <p className="sr-only">Cart version {cart.cart.version}</p>
    </article>
  );
}

function CartSummary({ cart }: { readonly cart: CartView }) {
  const quote = cart.cart.quote;
  if (quote === null || quote.cartVersion !== cart.cart.version)
    return (
      <section className="cart-summary" aria-labelledby="cart-summary-heading">
        <h2 id="cart-summary-heading">Order summary</h2>
        <p>No current quote is attached. Requote is required before checkout.</p>
        <button type="button" disabled aria-describedby="requote-boundary">
          Requote
        </button>
        <p id="requote-boundary" className="cart-boundary">
          Requote becomes available when the Customer Quote session adapter is composed.
        </p>
      </section>
    );
  return (
    <section className="cart-summary" aria-labelledby="cart-summary-heading">
      <div className="cart-summary__heading">
        <h2 id="cart-summary-heading">Order summary</h2>
        <span>Quote v{quote.quoteVersion}</span>
      </div>
      <dl>
        <div>
          <dt>Subtotal</dt>
          <dd>{exactMoney(quote.subtotal)}</dd>
        </div>
        <div>
          <dt>Discount</dt>
          <dd>{exactMoney(quote.discount)}</dd>
        </div>
        <div>
          <dt>Tax</dt>
          <dd>{exactMoney(quote.tax)}</dd>
        </div>
        <div>
          <dt>Fee</dt>
          <dd>{exactMoney(quote.fee)}</dd>
        </div>
        <div className="cart-summary__total">
          <dt>Total</dt>
          <dd>{exactMoney(quote.total)}</dd>
        </div>
      </dl>
      <p>
        Quote expires <time dateTime={quote.expiresAt}>{quote.expiresAt}</time>.
      </p>
      {[...quote.warnings, ...quote.blockingReasons].map((warning) => (
        <p className="cart-warning" key={warning}>
          {warning}
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
    "session-expired": ["Session expired", "Resume your Store session before opening this cart."],
    "not-found": ["Cart unavailable", "This cart is not available in the current Store session."],
    conflict: [
      "Cart changed",
      "The latest cart was loaded. Review your change before submitting again.",
    ],
    validation: [
      "Review this item",
      "The server rejected this configuration. Update the highlighted selection.",
    ],
    "rate-limited": [
      "Please wait",
      `Try again${state.retryAfterSeconds === null ? " shortly" : ` in ${state.retryAfterSeconds} seconds`}.`,
    ],
    expired: ["Cart expired", "Return to the menu to start a current cart."],
    abandoned: ["Cart closed", "This cart was abandoned and cannot be changed."],
    "command-failed": [
      "Outcome not confirmed",
      "The network ended before the server outcome was confirmed.",
    ],
    unavailable: [
      "Cart temporarily unavailable",
      "No change was assumed. Try loading the current cart again.",
    ],
  } as const;
  const message = messages[state.status as keyof typeof messages];
  if (message === undefined) return null;
  return (
    <StateMessage heading={message[0]} tone={state.status === "conflict" ? "warning" : "error"}>
      <p>{message[1]}</p>
      {state.issueCodes.map((issue) => (
        <p key={issue}>Issue: {issue}</p>
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
        <a href="/menu">Return to menu</a>
      </div>
    </StateMessage>
  );
}

function CartContent({
  state,
  controller,
}: {
  readonly state: CartState;
  readonly controller: CartStateController;
}) {
  if (state.status === "loading")
    return (
      <StateMessage heading="Loading cart">
        <p>Checking the latest server cart…</p>
      </StateMessage>
    );
  if (state.status === "empty")
    return (
      <StateMessage heading="Your cart is empty">
        <p>Add an available item from the current Store menu.</p>
        <a className="cart-primary-link" href="/menu">
          Browse menu
        </a>
      </StateMessage>
    );
  const cart = "cart" in state ? state.cart : null;
  if (cart === null) {
    if (state.status === "offline-readonly")
      return (
        <StateMessage heading="Offline" tone="warning">
          <p>No private cart is cached. Reconnect to load your cart.</p>
          <a href="/menu">Return to menu</a>
        </StateMessage>
      );
    return <ErrorState state={state} controller={controller} />;
  }
  if (cart.cart.warnings.includes("FEATURE_DISABLED"))
    return (
      <StateMessage heading="Cart unavailable" tone="warning">
        <p>Cart ordering is not enabled for the current Store context.</p>
        <a href="/menu">Return to menu</a>
      </StateMessage>
    );
  const readOnly = state.status === "offline-readonly";
  const pending = state.status === "command-pending";
  const terminal = cart.cart.lifecycle.status !== "Active";
  return (
    <>
      {readOnly ? (
        <div className="cart-offline" role="status">
          Offline read-only. Changes and checkout are disabled; nothing will replay on reconnect.
        </div>
      ) : null}
      {state.status !== "ready" && state.status !== "command-pending" && !readOnly ? (
        <ErrorState state={state} controller={controller} />
      ) : null}
      {cart.cart.warnings.includes("PROJECTION_STALE") ? (
        <div className="cart-stale" role="status">
          Cart summary is stale. Refresh before making a change.
        </div>
      ) : null}
      {cart.cart.warnings.includes("QUOTE_EXPIRED") ? (
        <div className="cart-stale" role="status">
          Quote expired. Server requote is required before checkout.
        </div>
      ) : null}
      <div className="cart-layout" aria-busy={pending}>
        <section className="cart-items" aria-labelledby="cart-items-heading">
          <div className="cart-page__subheading">
            <h2 id="cart-items-heading">Items</h2>
            <span>{cart.cart.items.length} item lines</span>
          </div>
          {cart.cart.items.map((item) => (
            <CartItem
              key={item.cartItemReference}
              cart={cart}
              item={item}
              pending={pending}
              readOnly={readOnly || terminal || cart.cart.warnings.includes("PROJECTION_STALE")}
              controller={controller}
            />
          ))}
        </section>
        <CartSummary cart={cart} />
      </div>
      <section className="cart-next-actions" aria-label="Cart actions">
        <a href="/menu">Continue shopping</a>
        <button type="button" disabled aria-describedby="clear-boundary">
          Clear cart
        </button>
        <button type="button" disabled aria-describedby="checkout-boundary">
          Checkout
        </button>
      </section>
      <div className="cart-boundaries">
        <p id="clear-boundary">Clear cart requires an atomic server command and is unavailable.</p>
        <p id="checkout-boundary">Checkout is implemented by WP-1220 and later packages.</p>
      </div>
      <p className="cart-version">
        Cart version {cart.cart.version} · {cart.cart.serviceMode}
      </p>
    </>
  );
}

export function CartPage({ controller: provided }: { readonly controller?: CartStateController }) {
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
    const online = () => {
      controller.setOnline(true);
      void controller.load();
    };
    window.addEventListener("offline", offline);
    window.addEventListener("online", online);
    return () => {
      window.removeEventListener("offline", offline);
      window.removeEventListener("online", online);
    };
  }, [controller]);
  return (
    <main id="main-content" className="cart-page">
      <header className="cart-page__header">
        <a className="cart-skip-link" href="#cart-content">
          Skip to cart content
        </a>
        <div>
          <p className="cart-page__eyebrow">Customer cart</p>
          <h1>Your cart</h1>
          {"cart" in state && state.cart !== null ? (
            <p>
              {state.cart.cart.context.brandName} · {state.cart.cart.context.storeName} ·
              server-calculated totals only
            </p>
          ) : (
            <p>Current Store · server-calculated totals only</p>
          )}
        </div>
        {"cart" in state && state.cart !== null ? (
          <div className="cart-page__context" aria-label="Service context">
            <span>{state.cart.cart.orderType}</span>
            <span>{state.cart.cart.lifecycle.status}</span>
          </div>
        ) : null}
      </header>
      <div id="cart-content">
        <CartContent state={state} controller={controller} />
      </div>
      <div className="sr-only" role="status" aria-live="polite">
        {state.status === "command-pending" ? "Cart change pending" : `Cart state ${state.status}`}
      </div>
    </main>
  );
}
