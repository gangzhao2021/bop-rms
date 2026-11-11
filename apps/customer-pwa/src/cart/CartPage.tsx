import { AlreadyOrdered } from "../checkout/AlreadyOrdered.js";
import { ClosedStoreNotice } from "../menu/ClosedStoreNotice.js";
import {
  CHINESE_LOCALE,
  currentLanguage,
  listSeparator,
  useReloadOnLanguageChange,
} from "../i18n/i18n.js";
import {
  getGuestTableStarter,
  isGuestTableQuestion,
  isUnseatedTableScan,
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
  OtherPayerWaits,
  PayerChoiceBanner,
  TablePayChooser,
  TableWaitingDishes,
  useWaitingReturn,
} from "./TablePayChoice.js";
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
import { startTableCartPoll, tableCartPollIntervalMs } from "./table-cart-poll.js";
import { createRoundWithdrawClient, type RoundWithdrawOutcome } from "./round-withdraw-client.js";
import {
  quoteConsistentLinePrices,
  cartLinesSubtotal,
  usePublishedMenuRead,
  type CartLinePrice,
} from "../menu/menu-line-prices.js";
import type { CustomerMenuClient, MenuJourneyContext, MenuView } from "../menu/types.js";
import {
  recordFirstSeenPrices,
  seenPriceChanges,
  type LinePriceChange,
  type PricedLine,
} from "./seen-prices.js";
import { PriceChangeList } from "../checkout/PriceChangeList.js";
import { comboLineAllergenText } from "../menu/combo-allergens.js";
import { storeServiceNoticeText, useStoreService } from "../store/StoreIdentity.js";
import { takesNewOrders } from "../store/store-service.js";
import {
  createStoreProfileClient,
  type StoreProfileLoader,
} from "../store/store-profile-client.js";

const browserCartStoreProfile: StoreProfileLoader = createStoreProfileClient();
import {
  cartIssueMessage,
  cartItemWarningMessage,
  cartText,
  checkoutText,
  commonText,
  lineEstimateLabel,
  quoteIssueMessage,
  specificCartIssues,
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
  // WP-2423 (guest-cart-503): a line that can't be sold now may be removed by anyone at the table.
  // WP-2423 (M154): its quantity can't change either (the Store would refuse it); only Remove.
  const unsellable = cartLineUnsellable(item);
  // WP-2423 (same-table-ordering, M36): the phone that added it has left the table; anyone may
  // change or remove it.
  const stranded = item.warnings.includes("ADDER_LEFT_TABLE");
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
          {stranded
            ? cartText.line.addedByPhoneThatLeft
            : unsellable
              ? cartText.line.addedByAnotherGuestRemovable
              : cartText.line.addedByAnotherGuest}
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
          disabled={
            readOnly || (foreign && !stranded) || pending || unsellable || item.quantity <= 1
          }
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
          disabled={
            readOnly || (foreign && !stranded) || pending || unsellable || item.quantity >= 100
          }
          aria-label={cartText.line.increaseLabel(item.displayName)}
          onClick={() => void updateQuantity(item.quantity + 1)}
        >
          +
        </button>
        <button
          className="cart-link-button"
          type="button"
          aria-describedby={foreign ? ownershipDescription : undefined}
          disabled={readOnly || (foreign && !unsellable && !stranded) || pending}
          onClick={() => void controller.removeItem(item.cartItemReference)}
        >
          {cartText.line.remove}
        </button>
      </div>
    </article>
  );
}

/** WP-2423 (same-table-ordering): the newest round from this cart, when another phone sent it. */
export const tableRoundSentByOther = (cart: CartView): number | null =>
  tableRoundByOther(cart)?.roundNumber ?? null;
/**
 * WP-2423 M38: that round, to say where its payment stands. The server lists rounds newest first,
 * so this is always the table's latest round, whatever older one is still open.
 */
const tableRoundByOther = (cart: CartView) => {
  const latest = cart.cart.recentRounds?.[0];
  return latest === undefined || latest.sentByThisPhone ? null : latest;
};
/**
 * WP-2423 M38: an older round another phone sent that is still open (being paid, not placed yet,
 * or waiting for staff), said on its own line so a later round never hides it.
 */
const tableOpenRoundByOther = (cart: CartView) => {
  const shown = tableRoundByOther(cart);
  return (
    cart.cart.recentRounds?.find(
      (round) =>
        round !== shown &&
        !round.sentByThisPhone &&
        (round.paymentState === "AwaitingPayment" || round.paymentState === "WaitingForStaff"),
    ) ?? null
  );
};
/**
 * WP-2423 M38: this phone's own newest round, when it is still open or will not be made, so the
 * sender is told on the cart (not only at checkout) that it is not placed, waiting for staff, or
 * was cancelled.
 */
const tableOwnRound = (cart: CartView, payLater: boolean) => {
  const own = cart.cart.recentRounds?.find((round) => round.sentByThisPhone);
  const text =
    own === undefined || own.paymentState === null
      ? null
      : cartText.line.roundSentByThisPhone(own.roundNumber, own.paymentState, payLater);
  return own === undefined || text === null ? null : { roundNumber: own.roundNumber, text };
};
/** WP-2423 (same-table-ordering, M38): what this table's rounds mean for this cart, newest first. */
function TableRoundNotes({
  cart,
  payLater,
  className,
}: {
  readonly cart: CartView;
  readonly payLater: boolean;
  readonly className?: string;
}) {
  const notes = [
    tableOwnRound(cart, payLater),
    ...[tableRoundByOther(cart), tableOpenRoundByOther(cart)].map((round) =>
      round === null
        ? null
        : {
            roundNumber: round.roundNumber,
            text: cartText.line.roundSentByTable(round.roundNumber, round.paymentState, payLater),
          },
    ),
  ]
    .filter((note) => note !== null)
    .sort((a, b) => b.roundNumber - a.roundNumber);
  return (
    <>
      {notes.map((note) => (
        <p key={note.roundNumber} className={className} role="status">
          {note.text}
        </p>
      ))}
    </>
  );
}

/**
 * WP-2423 M38: this phone's round still being paid at a table that pays as it orders (the guest
 * pressed "Continue to payment" and has not paid): the guest may stop and put the dishes back.
 */
export const withdrawableOwnRound = (cart: CartView, payLater: boolean) => {
  if (payLater) return null;
  const own = cart.cart.recentRounds?.find((round) => round.sentByThisPhone);
  return own !== undefined && own.paymentState === "AwaitingPayment" ? own : null;
};
/**
 * WP-2423 M38: "Don't pay. Put the dishes back". The store first makes sure nothing was charged,
 * so a payment that went through (or may still) is said as such and nothing changes. A lost answer
 * keeps the same operation, so tapping again never cancels twice.
 */
export function RoundWithdrawAction({
  roundNumber,
  onReturned,
  client = defaultRoundWithdrawClient,
}: {
  readonly roundNumber: number;
  readonly onReturned: () => void;
  readonly client?: ReturnType<typeof createRoundWithdrawClient>;
}) {
  const operation = useRef<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<RoundWithdrawOutcome | null>(null);
  const tap = async () => {
    operation.current ??= client.newOperationReference();
    setBusy(true);
    try {
      const result = await client.withdraw(operation.current, roundNumber);
      setOutcome(result);
      if (result !== "Unknown") operation.current = null;
      if (result === "Returned") onReturned();
    } finally {
      setBusy(false);
    }
  };
  const text = outcome === null ? null : cartText.line.roundWithdrawOutcome(outcome);
  return (
    <div className="cart-state__actions">
      <button type="button" disabled={busy} onClick={() => void tap()}>
        {cartText.line.roundWithdraw}
      </button>
      {text === null ? null : <p role="status">{text}</p>}
    </div>
  );
}
const defaultRoundWithdrawClient = createRoundWithdrawClient();

/**
 * WP-2423 shared-table-checkout (c): the dishes staff took out of this table's cart lately, named
 * in the guest's language (the menu language when there is no such name). A dish that is on no
 * current menu has no name: it is still told, as "a dish" (null here).
 */
export const staffRemovedDishes = (cart: CartView): readonly (string | null)[] =>
  (cart.cart.staffRemoved ?? []).map((removal) => {
    const names = removal.names;
    const chosen =
      currentLanguage() === "zh-Hans"
        ? (names[CHINESE_LOCALE] ?? Object.values(names)[0])
        : (Object.entries(names).find(([locale]) => locale.startsWith("en"))?.[1] ??
          Object.values(names)[0]);
    return chosen === undefined || chosen.trim() === "" ? null : chosen;
  });
const staffRemovedNotice = (dish: string | null) =>
  dish === null ? cartText.line.staffRemovedUnnamed : cartText.line.staffRemoved(dish);

/** WP-2423 (guest-cart-503): the Store marked this line as not sellable now (stable fact). */
const cartLineUnsellable = (item: CartView["cart"]["items"][number]) =>
  item.warnings.includes("ITEM_UNAVAILABLE") || item.warnings.includes("ITEM_OPTIONS_CHANGED");

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
  // Owner #26 (DEC-PRICE-HOLD), warn before timeouts: shown again when the hold's last minute
  // starts and when it ends.
  const [, setClock] = useState(0);
  const heldUntil = payLater ? null : (cart.cart.quote?.expiresAt ?? null);
  useEffect(() => {
    if (heldUntil === null) return;
    const left = Date.parse(heldUntil) - now();
    if (!Number.isFinite(left) || left <= 0) return;
    const timer = window.setTimeout(
      () => setClock((value) => value + 1),
      Math.min((left > 60_000 ? left - 60_000 : left) + 20, 2_147_483_647),
    );
    return () => window.clearTimeout(timer);
  });
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
          {remaining === null ? cartText.summary.pricesExpired : commonText.priceKeptFor(remaining)}
        </p>
      )}
      {!payLater && remaining !== null && Date.parse(quote.expiresAt) - now() <= 60_000 ? (
        <p role="alert">{commonText.priceKeptLastMinute}</p>
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
  );
}

/** WP-2423 (M154): the exact reason a change was refused ("This dish just sold out."), or null. */
function specificRefusal(state: CartState): string | null {
  if (state.status !== "validation" || !("issueCodes" in state)) return null;
  const code = state.issueCodes.find((issue) => specificCartIssues.includes(issue));
  return code === undefined ? null : cartIssueMessage(code);
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
    "participation-ended": failure.participationEnded,
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
  // WP-2423 (M154): a refusal that says exactly what happened ("This dish just sold out.") is the
  // headline; "This choice can't be ordered as selected" would send the guest to choices it lacks.
  const specific = specificRefusal(state);
  return (
    <StateMessage
      heading={specific ?? message[0]}
      tone={state.status === "conflict" ? "warning" : "error"}
    >
      {specific === null ? <p>{message[1]}</p> : null}
      {issues
        .filter((issue) => issue !== specific)
        .map((issue) => (
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
        {/* M126 I.2: the table page says what happened (moved, merged, settled) and what next. */}
        {state.status === "participation-ended" ? (
          <Link to="/dine-in/session">{cartText.failure.yourTable}</Link>
        ) : null}
        {state.status === "not-seated" && (isGuestTableQuestion() || getGuestTableStarter()) ? (
          <Link to="/">{failure.goToStart}</Link>
        ) : state.status === "not-seated" && !isUnseatedTableScan() ? (
          // WP-2423 M115: an open table this phone hasn't joined: the table's page joins it.
          <Link to="/">{failure.joinThisTable}</Link>
        ) : null}
      </div>
    </StateMessage>
  );
}

/**
 * WP-2423 item 6: what a stopped send says, under the button. Nothing here repeats an unknown answer:
 * that one has its own panel, above everything, because the cart it was about may be gone.
 */
function sendRoundMessage(round: SendRoundState, cart: CartView, onRetry: () => void) {
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
    case "participation-ended":
      return (
        <div role="alert">
          <p>{cartText.failure.participationEnded[0]}</p>
          <p>{cartText.failure.participationEnded[1]}</p>
          <Link to="/dine-in/session">{cartText.failure.yourTable}</Link>
        </div>
      );
    case "session-ended":
      return <p role="alert">{checkoutText.sessionEnded}</p>;
    case "cart-changed":
      return <p role="alert">{checkoutText.tableCartChanged}</p>;
    default:
      return null;
  }
}

/** The button can be at the bottom of a long cart: a stop is said where the guest is looking. */
function SendRoundMessage({
  round,
  cart,
  onRetry,
}: {
  readonly round: SendRoundState;
  readonly cart: CartView;
  readonly onRetry: () => void;
}) {
  const said = useRef<HTMLDivElement>(null);
  useEffect(() => {
    said.current?.scrollIntoView?.({ block: "nearest" });
  }, [round.status, cart.cart.version]);
  const message = sendRoundMessage(round, cart, onRetry);
  return message === null ? null : <div ref={said}>{message}</div>;
}

/**
 * The answer got lost. A send was attempted: it may or may not have been placed, and asking again is
 * safe. Otherwise nothing was placed, and the guest can try again or change the cart.
 */
function UnconfirmedOrder({
  online,
  mayBePlaced,
  onRetry,
}: {
  readonly online: boolean;
  readonly mayBePlaced: boolean;
  readonly onRetry: () => void;
}) {
  const said = useRef<HTMLElement>(null);
  useEffect(() => {
    said.current?.scrollIntoView?.({ block: "nearest" });
  }, []);
  return (
    <>
      <section className="checkout-attention" role="alert" ref={said}>
        <p>{mayBePlaced ? cartText.orderUnconfirmed : cartText.orderNotPlaced}</p>
        <button type="button" disabled={!online} onClick={onRetry}>
          {commonText.tryAgain}
        </button>
        {mayBePlaced ? <Link to="/dine-in/session">{cartText.checkYourTable}</Link> : null}
      </section>
      <DiningStaffCallPanel />
    </>
  );
}

/** A round placed that this page didn't send the guest away for: said once, and what it doesn't cover. */
function LastOrderPlaced({
  held,
  cartHoldsMore,
}: {
  readonly held: boolean;
  readonly cartHoldsMore: boolean;
}) {
  return (
    <section className="cart-last-order" role="status">
      <p>{held ? cartText.lastOrderPlacedHeld : cartText.lastOrderPlaced}</p>
      {cartHoldsMore ? <p>{cartText.stillInYourCart}</p> : null}
      <Link to="/dine-in/session">{cartText.seeYourTable}</Link>
    </section>
  );
}

/**
 * WP-2423 M74: the cart's priced lines, recorded the first time the guest sees them, and the lines
 * whose price changed since. Showing a line again never replaces what the guest first saw.
 */
export function cartPriceChanges(
  cart: CartView["cart"],
  prices: ReadonlyMap<string, CartLinePrice | null>,
): readonly LinePriceChange[] {
  const lines: PricedLine[] = cart.items.flatMap((item) => {
    const price = prices.get(item.cartItemReference);
    return price == null
      ? []
      : [
          {
            cartItemReference: item.cartItemReference,
            quantity: item.quantity,
            amountMinor: price.amountMinor,
            currency: price.currency,
          },
        ];
  });
  recordFirstSeenPrices(cart.cartReference, lines);
  return seenPriceChanges(cart.cartReference, lines);
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
  service = null,
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
  /**
   * WP-2423 store-service-controls (v15 M30/M34): the Store's live answer. Past last orders, while
   * this guest's service is paused or when closed, no new order or round is offered (a bill or a
   * payment already started is paid elsewhere and is never held here).
   */
  readonly service?: ReturnType<typeof useStoreService> | null;
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
    return state.status === "ready" && state.cart.cart.placedOrder ? (
      <AlreadyOrdered
        placedOrder={state.cart.cart.placedOrder}
        onRestored={() => void controller.load()}
      />
    ) : round.status === "cart-changed" ? (
      // A second phone tapped after the first sent: without this she'd add it all again.
      <StateMessage heading={cartText.someonePlacedIt}>
        <div className="cart-state__actions">
          <Link className="cart-primary-link" to="/dine-in/session">
            {cartText.seeYourTable}
          </Link>
          <Link to="/menu">{commonText.browseMenu}</Link>
        </div>
      </StateMessage>
    ) : state.status === "ready" &&
      (tableRoundSentByOther(state.cart) !== null ||
        tableOpenRoundByOther(state.cart) !== null ||
        withdrawableOwnRound(state.cart, timing === "PayLater") !== null) ? (
      // WP-2423 (same-table-ordering): another phone's round took this cart's dishes, or (M38)
      // this phone is paying for the round that did.
      <StateMessage heading={commonText.emptyCartHeading}>
        {/* v15 batch-5: a phone whose only dish staff took out is told so here too. */}
        {staffRemovedDishes(state.cart).map((dish, index) => (
          <p key={"staff-removed:" + String(index)} role="status">
            {staffRemovedNotice(dish)}
          </p>
        ))}
        <TableRoundNotes cart={state.cart} payLater={timing === "PayLater"} />
        {(() => {
          const own = withdrawableOwnRound(state.cart, timing === "PayLater");
          return own === null ? null : (
            <RoundWithdrawAction
              roundNumber={own.roundNumber}
              onReturned={() => void controller.load()}
            />
          );
        })()}
        <div className="cart-state__actions">
          <Link className="cart-primary-link" to="/dine-in/session">
            {cartText.seeYourTable}
          </Link>
          <Link to="/menu">{commonText.browseMenu}</Link>
        </div>
      </StateMessage>
    ) : (
      <StateMessage heading={commonText.emptyCartHeading}>
        {state.status === "ready"
          ? staffRemovedDishes(state.cart).map((dish, index) => (
              <p key={"staff-removed:" + String(index)} role="status">
                {staffRemovedNotice(dish)}
              </p>
            ))
          : null}
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
        // Said as it works: the cart reads again by itself once back online (e48a3616); the
        // actions wrap whole at 320px rather than splitting the menu link around the button.
        <StateMessage heading={commonText.offlineHeading} tone="warning">
          <p>{cartText.offline.reconnectToLoad}</p>
          <div className="shell-actions">
            <button type="button" onClick={() => void controller.load()}>
              {commonText.tryAgain}
            </button>
            <Link to="/menu">{commonText.returnToMenu}</Link>
          </div>
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
  const serviceChannel = cart.cart.orderType === "Pickup" ? "Pickup" : "DineIn";
  const stopped = service !== null && !takesNewOrders(service.phase);
  const stoppedText =
    service === null
      ? null
      : storeServiceNoticeText(
          service.profile?.hours ?? null,
          service.phase,
          service.minutesLeft,
          serviceChannel,
        );
  // WP-2423 item 6: while a round is on its way the cart holds still: a change now would refuse the
  // round, and leaving would hide what it answers. So does a send whose answer got lost: the cart it
  // was about may have just been emptied by it.
  const sending = round.status === "sending";
  const held = sending || (round.status === "unconfirmed" && round.mayBePlaced);
  // WP-2423 (guest-cart-503): ordering waits until no line that can't be sold now is left.
  const unsellableLines = cart.cart.items.some(cartLineUnsellable);
  const othersItems = cart.cart.items
    .filter((item) => item.warnings.includes("OTHER_PARTICIPANT_ITEM"))
    .reduce((total, item) => total + item.quantity, 0);
  const currentQuote =
    cart.cart.quote !== null && cart.cart.quote.cartVersion === cart.cart.version
      ? cart.cart.quote.subtotal
      : null;
  const prices = quoteConsistentLinePrices(cart.cart.items, menu, currentQuote);
  const priceChanges = cartPriceChanges(cart.cart, prices);
  // WP-2423 M03 review: these dishes are already in an order (a cart filled before pickup carts
  // were emptied on ordering); their checkout is refused, so say so instead of offering it.
  const alreadyOrdered =
    cart.cart.items.length > 0 && cart.cart.placedOrder ? cart.cart.placedOrder : null;
  return (
    <>
      {alreadyOrdered !== null ? (
        <AlreadyOrdered placedOrder={alreadyOrdered} dishesInCart />
      ) : null}
      {priceChanges.length > 0 && !terminal ? (
        <section className="cart-price-changes" role="status">
          <PriceChangeList changes={priceChanges} items={cart.cart.items} />
          <p>{cartText.acceptAtCheckout}</p>
        </section>
      ) : null}
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
      <TableRoundNotes cart={cart} payLater={payLater} className="cart-stale" />
      {(() => {
        const own = withdrawableOwnRound(cart, payLater);
        return own === null ? null : (
          <RoundWithdrawAction
            roundNumber={own.roundNumber}
            onReturned={() => void controller.load()}
          />
        );
      })()}
      {staffRemovedDishes(cart).map((dish, index) => (
        <p key={"staff-removed:" + String(index)} className="cart-stale" role="status">
          {staffRemovedNotice(dish)}
        </p>
      ))}
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
                // WP-2423 shared-table-checkout (a): a phone is paying for dishes it chose.
                (cart.cart.tablePay?.payer ?? null) !== null ||
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
      {stoppedText === null ? null : (
        <p className="cart-next-actions__stopped" role="alert" id="cart-store-stopped">
          <strong>{stoppedText.headline}</strong>
          {stoppedText.detail === null ? null : <> {stoppedText.detail}</>}
        </p>
      )}
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
                stopped ||
                unsellableLines ||
                state.status !== "ready" ||
                !menuSettled ||
                cart.cart.warnings.includes("PROJECTION_STALE")
              }
              aria-describedby={unsellableLines ? "cart-remove-unavailable" : undefined}
              onClick={() => onPlace(cart, cartLinesSubtotal(prices))}
            >
              {sending
                ? cartText.placingOrder
                : round.status === "confirm-total"
                  ? cartText.placeOrderWithTotal(formatCartMoney(round.total))
                  : cartText.placeOrder}
            </button>
            {unsellableLines ? (
              <p className="cart-next-actions__note" id="cart-remove-unavailable">
                {cartText.line.removeUnavailableFirst}
              </p>
            ) : null}
            <SlowWaitNote active={sending}>{cartText.placedSlowly}</SlowWaitNote>
            <SendRoundMessage
              round={round}
              cart={cart}
              onRetry={() => onPlace(cart, cartLinesSubtotal(prices))}
            />
            <p className="cart-next-actions__note">{checkoutText.sendToKitchenNote}</p>
          </div>
        ) : alreadyOrdered !== null ? null : stopped ? (
          <div className="cart-next-actions__place">
            <button
              className="cart-checkout-link"
              type="button"
              disabled
              aria-describedby="cart-store-stopped"
            >
              {cartText.checkout}
            </button>
          </div>
        ) : unsellableLines ? (
          <div className="cart-next-actions__place">
            <button
              className="cart-checkout-link"
              type="button"
              disabled
              aria-describedby="cart-remove-unavailable"
            >
              {cartText.checkout}
            </button>
            <p className="cart-next-actions__note" id="cart-remove-unavailable">
              {cartText.line.removeUnavailableBeforeCheckout}
            </p>
          </div>
        ) : cart.cart.tablePay?.payer?.thisPhone === true ? (
          // WP-2423 shared-table-checkout (a): this phone chose this round's dishes.
          <PayerChoiceBanner
            payer={cart.cart.tablePay.payer}
            onCancelled={() => void controller.refresh()}
          />
        ) : cart.cart.tablePay?.payer != null ? (
          <OtherPayerWaits />
        ) : cart.cart.tablePay !== undefined && othersItems > 0 ? (
          <TablePayChooser
            cart={cart}
            prices={prices}
            onChanged={() => void controller.refresh()}
          />
        ) : (
          <Link className="cart-checkout-link" to="/checkout">
            {cartText.checkout}
          </Link>
        )}
      </section>
    </>
  );
}

/**
 * WP-2423 (guest-cart-503, same-table-ordering): how often an open table cart re-reads while on
 * screen, so a dish another phone adds shows here within seconds (`table-cart-poll.ts`: never
 * hidden or offline, slower after a failure). A pickup cart doesn't poll.
 */
export const cartPollIntervalMs = tableCartPollIntervalMs;
/**
 * Whether the open table cart re-reads now: only on screen, with the cart shown as it stands or
 * stuck after a failed read or a lost network (reading is how those recover, never a dead end),
 * and never while a change or a round is on its way (the cart holds still for those).
 */
export function cartPollShouldRead(
  visibility: DocumentVisibilityState,
  round: SendRoundState,
  cart: CartState,
): boolean {
  return (
    visibility === "visible" &&
    (cart.status === "ready" ||
      cart.status === "offline-readonly" ||
      ("fromRead" in cart && cart.fromRead === true)) &&
    round.status !== "sending" &&
    !(round.status === "unconfirmed" && round.mayBePlaced)
  );
}

/** Cart prices come from a full menu read; an ordinary guest gets one tap once it's in. */
const menuPriceWaitMs = 2_000;

/** What a stop says holds for the cart as it stood: any later change to the cart ends it. */
const aboutThisCart = (round: SendRoundState) =>
  round.status === "confirm-total" ||
  round.status === "refused" ||
  round.status === "busy" ||
  round.status === "blocked" ||
  round.status === "cart-changed" ||
  (round.status === "unconfirmed" && !round.mayBePlaced);

const cartVersionOf = (state: CartState) =>
  "cart" in state && state.cart !== null ? state.cart.cart.version : null;

type CartPageProps = Parameters<typeof OpenCartPage>[0];

/**
 * M116: a guest only looking at a closed (or paused) Store's menu has no visit and no cart there,
 * so the cart says the Store isn't taking orders and when it opens, instead of reading a cart
 * that doesn't exist and calling that a failure.
 */
export function CartPage(props: CartPageProps) {
  const closed = props.controller === undefined ? props.menuContext?.closed : undefined;
  if (closed !== undefined && props.menuContext !== undefined)
    return (
      <CustomerPage step="cart" store={props.store} className="cart-page" browseOnly>
        <PageHeading title={cartText.pageHeading} />
        <section className="menu-readonly-boundary menu-closed-notice" role="status">
          <h2>{cartText.storeNotTakingOrders(props.menuContext.storeDisplayName)}</h2>
          <ClosedStoreNotice
            closed={closed}
            primary={
              <Link className="cart-primary-link" to="/menu">
                {cartText.backToMenu}
              </Link>
            }
          />
        </section>
      </CustomerPage>
    );
  return <OpenCartPage {...props} />;
}

function OpenCartPage({
  controller: provided,
  store,
  now = Date.now,
  menuContext,
  menuClient,
  sendRound,
  diningClient,
  storeProfile,
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
  /** The Store's live service answer (tests inject; null reads nothing). */
  readonly storeProfile?: StoreProfileLoader | null | undefined;
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
  const cartShowsPriceChanges =
    cart !== null &&
    cartPriceChanges(
      cart,
      quoteConsistentLinePrices(
        cart.items,
        menu,
        cart.quote !== null && cart.quote.cartVersion === cart.version ? cart.quote.subtotal : null,
      ),
    ).length > 0;
  const [menuWaitOver, setMenuWaitOver] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setMenuWaitOver(true), menuPriceWaitMs);
    return () => window.clearTimeout(timer);
  }, []);
  const timing = useTablePaymentTiming(cart?.orderType === "DineIn", diningClient);
  // WP-2423 shared-table-checkout (a): dishes that waited for another phone's round come back to
  // the cart as soon as nobody pays for them.
  useWaitingReturn("cart" in state ? state.cart : null, () => void controller.refresh());
  // WP-2423 (guest-cart-503): an open table cart re-reads while it is on screen, so it learns
  // within one interval that staff started checkout, or that another phone changed it. Never
  // while a change or a round is on its way; one read per interval per visible phone.
  const dineIn = cart?.orderType === "DineIn";
  useEffect(() => {
    if (!dineIn) return;
    const poll = startTableCartPoll({
      read: () => controller.refresh(),
      shouldRead: () =>
        cartPollShouldRead(
          typeof document === "undefined" ? "visible" : document.visibilityState,
          round.getState(),
          controller.getState(),
        ),
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
  }, [dineIn, controller, round]);
  // Leaving forgets a stop; a send that may have happened stays, to be finished when the guest is back.
  useEffect(
    () => () => {
      const left = round.getState();
      if (left.status !== "sending" && !(left.status === "unconfirmed" && left.mayBePlaced))
        round.reset();
    },
    [round],
  );
  const [lastOrder, setLastOrder] = useState<{
    readonly held: boolean;
    /** The cart was read after it: what it holds is what's left. */
    readonly cartRead: boolean;
  } | null>(null);
  // A send's answer is only acted on by the page that sent it: the guest may have changed the cart
  // since, and another page instance doesn't know what they're looking at.
  const startedHere = useRef(false);
  const place = (placed: CartView | null, seen: SeenSubtotal | null) => {
    startedHere.current = true;
    setLastOrder(null);
    void round.send(placed, seen);
  };
  // What the send's answer means for this page, once.
  const acted = useRef<SendRoundState | null>(null);
  /** The cart as read right after a stop: the stop is about that one. */
  const stoppedAt = useRef<{ readonly version: number | null } | null>(null);
  useEffect(() => {
    if (acted.current === roundState) return;
    acted.current = roundState;
    stoppedAt.current = null;
    if (roundState.status === "sending") return;
    const mine = startedHere.current;
    startedHere.current = false;
    if (roundState.status === "idle") return;
    if (roundState.status === "sent") {
      round.reset();
      if (mine && roundState.more !== true) {
        void navigate("/dine-in/session", {
          replace: true,
          state: { placed: roundState.held ? "Held" : "Sent" },
        });
        return;
      }
      setLastOrder({ held: roundState.held, cartRead: false });
      void controller.refresh().then(() => {
        setLastOrder((note) => (note === null ? null : { ...note, cartRead: true }));
      });
      return;
    }
    if (roundState.status === "needs-page" || roundState.status === "pay-first") {
      round.reset();
      if (mine) void navigate("/checkout");
      return;
    }
    // A question or a wait nobody here asked for: the next tap asks again if it still applies.
    if (!mine && (roundState.status === "confirm-total" || roundState.status === "busy")) {
      round.reset();
      return;
    }
    // The summary shows the quote's total; a changed cart shows what it holds now.
    void controller.refresh().then(() => {
      if (acted.current === roundState)
        stoppedAt.current = { version: cartVersionOf(controller.getState()) };
    });
  }, [controller, navigate, round, roundState]);
  useEffect(() => {
    if (
      stoppedAt.current !== null &&
      aboutThisCart(roundState) &&
      state.status !== "loading" &&
      cartVersionOf(state) !== stoppedAt.current.version
    )
      round.reset();
  }, [round, roundState, state]);
  const service = useStoreService(
    storeProfile === undefined ? browserCartStoreProfile : storeProfile,
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
    <CustomerPage
      step="cart"
      store={resolvedStore}
      className="cart-page"
      navigationHeld={roundState.status === "sending"}
    >
      <PageHeading title={cartText.pageHeading} />
      <div id="cart-content">
        {roundState.status === "unconfirmed" ? (
          <UnconfirmedOrder
            online={online}
            mayBePlaced={roundState.mayBePlaced}
            onRetry={() => place("cart" in state ? state.cart : null, null)}
          />
        ) : null}
        {lastOrder === null ? null : (
          <LastOrderPlaced
            held={lastOrder.held}
            cartHoldsMore={lastOrder.cartRead && (cart?.items.length ?? 0) > 0}
          />
        )}
        {cart?.tablePay !== undefined && timing !== "PayLater" ? (
          <TableWaitingDishes tablePay={cart.tablePay} />
        ) : null}
        <CartContent
          state={state}
          controller={controller}
          now={now}
          menu={menu}
          timing={timing}
          round={roundState}
          menuSettled={settled || menuWaitOver}
          onPlace={place}
          service={service}
        />
      </div>
      <div className="sr-only" role="status" aria-live="polite">
        {roundState.status === "cart-changed" && cart !== null && cart.items.length === 0
          ? cartText.someonePlacedIt
          : roundState.status === "cart-changed" && state.status === "empty"
            ? cartText.someonePlacedIt
            : state.status === "ready" && cartShowsPriceChanges
              ? // WP-2423 M74: never "up to date" while a dish's price changed since it was added.
                cartText.pricesChangedSinceAdded
              : (specificRefusal(state) ?? cartText.stateAnnouncement[state.status])}
      </div>
    </CustomerPage>
  );
}
