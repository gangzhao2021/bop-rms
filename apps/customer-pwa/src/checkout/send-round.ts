import { v7 as uuidv7 } from "uuid";
import { createBrowserCustomerCartClient } from "../cart/cart-client.js";
import { CartClientError, type CartMoney, type CartView } from "../cart/types.js";
import { createTablePaymentClient } from "../dining/table-payment-client.js";
import { quoteIssueMessage } from "../journey/messages.js";
import {
  createSessionPaymentClient,
  SessionPaymentClientError,
} from "../payment/session-payment-client.js";
import {
  captureCustomerCsrfContext,
  setTablePaymentTiming,
} from "../session/customer-transaction-context.js";
import {
  createCheckoutClient,
  manualRetryBusyTotalMs,
  type CheckoutMutationOptions,
} from "./checkout-client.js";
import {
  CheckoutDetailsClientError,
  createCheckoutDetailsClient,
  type CheckoutDetailsAcknowledgement,
  type CheckoutDetailsDraft,
} from "./details-client.js";
import {
  createCheckoutDetailsReadClient,
  type CheckoutDetailsCurrentView,
  type CheckoutDetailsReadSelection,
} from "./details-read-client.js";
import {
  CheckoutSessionClientError,
  createCheckoutSessionClient,
  type CheckoutRefusedLine,
  type CheckoutSessionSelection,
  type CheckoutSessionView,
} from "./session-client.js";
import type { CheckoutQuote } from "./types.js";

/**
 * WP-2423 item 6 (DEC-DINE-IN-PAY-LATER): placing a round from the cart in one tap at a table that
 * pays at the end. The server's send needs a quote, details, a checkout session and the send; none of
 * them needs a decision from a guest at such a table, so this runs them in that order, each with its
 * own idempotency key:
 *
 * - The quote's price is checked against what the guest saw; a total that went up, any fee or a total
 *   never shown stops before anything is saved, and the second tap continues with the same quote.
 * - A lost answer is never a failure the guest pays for: each step repeats with the same key and the
 *   same body, and the server returns what it already did.
 * - Nothing can be placed before the send. So before one was attempted, a plan only means something
 *   for the cart it was made for: a read showing another version or another guest's quote ends it, and
 *   the guest is free to change the cart. After one was attempted the plan outlives the cart (the send
 *   empties it), and a retry repeats that send whatever the cart says.
 * - Reconnection never sends anything; a retry is always a guest's tap.
 * - Leaving the page doesn't stop the steps, and no navigation happens from a page that is gone.
 */
export interface SendRoundPorts {
  /** What the cart holds now, read fresh. A failed read decides nothing. */
  readCart(): Promise<CartView | null>;
  /** Whether the table is checking out (staff started it). A failed read decides nothing. */
  readTable(): Promise<{ readonly checkingOut: boolean }>;
  readDetails(selection: CheckoutDetailsReadSelection): Promise<CheckoutDetailsCurrentView>;
  quote(
    cart: CartView,
    operationReference: string,
    options?: CheckoutMutationOptions,
  ): Promise<CheckoutQuote>;
  saveDetails(
    draft: CheckoutDetailsDraft,
    operationReference: string,
    options?: CheckoutMutationOptions,
  ): Promise<CheckoutDetailsAcknowledgement>;
  createSession(
    selection: CheckoutSessionSelection,
    operationReference: string,
    options?: CheckoutMutationOptions,
  ): Promise<CheckoutSessionView>;
  send(
    session: string,
    selection: string,
    options?: CheckoutMutationOptions,
  ): Promise<{ readonly status: "Sent" | "AlreadySent" | "Held" }>;
}

export type SendRoundState =
  | { readonly status: "idle" | "sending" }
  /**
   * The round is placed. Held: it waits for staff before the kitchen. More: a retry finished it and
   * the cart holds other dishes (or couldn't be read), so "placed" doesn't cover what's on screen.
   */
  | { readonly status: "sent"; readonly held: boolean; readonly more?: true }
  /** Something only the checkout page can ask (the Store's documents, a quote's warnings). */
  | { readonly status: "needs-page" }
  /** The table pays as it orders after all: the checkout page and payment follow. */
  | { readonly status: "pay-first" }
  | {
      readonly status: "confirm-total";
      readonly total: CartMoney;
      /** changed: more than the guest saw; fees: a fee was added; shown: no price was shown yet. */
      readonly reason: "changed" | "fees" | "shown";
    }
  | { readonly status: "blocked"; readonly messages: readonly string[] }
  | {
      readonly status: "refused";
      readonly refusal: "item_short" | "item_unavailable" | "item_options_changed";
      readonly line: CheckoutRefusedLine | null;
    }
  | {
      readonly status:
        | "store-closed"
        | "table-checking-out"
        | "session-ended"
        | "cart-changed"
        /** M126 I.2: this phone's place at the table ended (why: getParticipationEnded). */
        | "participation-ended";
    }
  | {
      readonly status: "busy";
      readonly wait: "order-processing" | "checkout-in-progress";
      readonly retryAfterSeconds: number | null;
    }
  /**
   * The answer got lost: trying again repeats the same step and can't place it twice. mayBePlaced: a
   * send was attempted, so the round may exist. Otherwise nothing was placed and the cart stays free.
   */
  | { readonly status: "unconfirmed"; readonly mayBePlaced: boolean };

/** What the guest saw for the cart before tax, when every line had a price. */
export interface SeenSubtotal {
  readonly amountMinor: bigint;
  readonly currency: string;
}

interface Plan {
  readonly cart: CartView;
  /** What the guest saw when they tapped; a retry from a lost answer has nothing newer. */
  seen: SeenSubtotal | null;
  quoteOperation: string;
  quote: CheckoutQuote | null;
  /** Read once: a details draft is frozen with its operation, so a retry replays it exactly. */
  priorDetails: CheckoutDetailsCurrentView["details"] | undefined;
  draft: CheckoutDetailsDraft | null;
  readonly detailsOperation: string;
  detailsSaved: boolean;
  sessionOperation: string;
  sessionAttempted: boolean;
  session: CheckoutSessionView | null;
  readonly selection: string;
  sendAttempted: boolean;
  confirmedQuote: string | null;
  confirmedTotalMinor: bigint | null;
  /** A whole new plan was already started once for this tap. */
  readonly restarted: boolean;
  quoteRenewed: boolean;
}

const asBig = (money: CartMoney) => BigInt(money.amountMinor);

/** The cart isn't the one this plan was made for: another version, or another guest's quote on it. */
function movedOn(active: Plan, cart: CartView | null): boolean {
  if (
    cart === null ||
    cart.cart.items.length === 0 ||
    cart.cart.cartReference !== active.cart.cart.cartReference ||
    cart.cart.version !== active.cart.cart.version
  )
    return true;
  const attached = cart.cart.quote;
  return (
    active.quote !== null &&
    attached !== null &&
    attached.quoteReference !== active.quote.quoteReference
  );
}

/** What a total the guest is asked to confirm says, or null when the price stands as seen. */
function priceCheck(quote: CheckoutQuote, seen: SeenSubtotal | null) {
  if (asBig(quote.fee) !== 0n) return "fees" as const;
  if (quote.priceChange?.requiresReconfirmation === true) return "changed" as const;
  if (seen === null || seen.currency !== quote.subtotal.currency) return "shown" as const;
  return asBig(quote.subtotal) - asBig(quote.discount) + asBig(quote.fee) > seen.amountMinor
    ? ("changed" as const)
    : null;
}

export interface SendRoundController {
  getState(): SendRoundState;
  subscribe(listener: () => void): () => void;
  /**
   * The guest's tap: place the round, or carry on after a stop. Only ever called from a tap.
   * `shown`: the Store's price for this cart as the cart showed it (price-hold-dish-changes); the
   * round goes on that quote while it lasts, rather than pricing the cart a second time.
   */
  send(
    cart: CartView | null,
    seen: SeenSubtotal | null,
    shown?: CheckoutQuote | null,
  ): Promise<void>;
  /** The page acted on the state (opened the table, the checkout page), or the guest left. */
  reset(): void;
}

export function createSendRoundController(
  ports: SendRoundPorts,
  keyFactory: () => string = uuidv7,
  now: () => number = Date.now,
): SendRoundController {
  let state: SendRoundState = { status: "idle" };
  let plan: Plan | null = null;
  let flight: Promise<void> | null = null;
  const listeners = new Set<() => void>();
  const publish = (next: SendRoundState) => {
    state = Object.freeze(next);
    listeners.forEach((listener) => listener());
  };
  const unconfirmed = (): SendRoundState => ({
    status: "unconfirmed",
    mayBePlaced: plan?.sendAttempted === true,
  });
  /** undefined: the read failed, which decides nothing. */
  const readCart = () =>
    ports.readCart().then(
      (cart) => cart,
      () => undefined,
    );
  const newPlan = (cart: CartView, carried?: Plan): Plan => ({
    cart,
    seen: carried?.seen ?? null,
    quoteOperation: keyFactory(),
    quote: null,
    priorDetails: undefined,
    draft: null,
    detailsOperation: keyFactory(),
    detailsSaved: false,
    sessionOperation: keyFactory(),
    sessionAttempted: false,
    session: null,
    selection: keyFactory(),
    sendAttempted: false,
    confirmedQuote: null,
    confirmedTotalMinor: carried?.confirmedTotalMinor ?? null,
    restarted: carried !== undefined,
    quoteRenewed: false,
  });
  /** Conflict: a whole new plan with new keys, once; after that the guest decides to try again. */
  const restart = (active: Plan, options: CheckoutMutationOptions) => {
    if (active.restarted) {
      plan = null;
      return Promise.resolve(unconfirmed());
    }
    plan = newPlan(active.cart, active);
    return advance(plan, options);
  };
  const quoteStep = async (
    active: Plan,
    options: CheckoutMutationOptions,
  ): Promise<SendRoundState | null> => {
    try {
      active.quote = await ports.quote(active.cart, active.quoteOperation, options);
      return null;
    } catch (error) {
      const code = error instanceof CartClientError ? error.code : "network_unknown";
      switch (code) {
        case "cart_version_conflict":
        case "cart_idempotency_conflict":
          plan = null;
          return { status: "cart-changed" };
        case "cart_order_processing":
        case "cart_checkout_in_progress":
          active.quoteOperation = keyFactory();
          return {
            status: "busy",
            wait: code === "cart_order_processing" ? "order-processing" : "checkout-in-progress",
            retryAfterSeconds: (error as CartClientError).retryAfterSeconds,
          };
        case "cart_session_expired":
          plan = null;
          return { status: "session-ended" };
        case "cart_table_checking_out":
          plan = null;
          return { status: "table-checking-out" };
        case "cart_participant_ended":
          plan = null;
          return { status: "participation-ended" };
        case "quote_operation_expired":
          if (active.quoteRenewed) return unconfirmed();
          active.quoteRenewed = true;
          active.quoteOperation = keyFactory();
          return quoteStep(active, options);
        case "cart_selection_invalid":
        case "cart_request_invalid":
          plan = null;
          return { status: "needs-page" };
        // WP-2423 (guest-cart-503): the Store names the line it can't sell now. Nothing was sent;
        // the answer is final until the guest removes it (no retry, no background send).
        case "cart_item_unavailable":
        case "cart_item_options_changed": {
          plan = null;
          const cartItemReference = (error as CartClientError).cartItemReference;
          return {
            status: "refused",
            refusal: code === "cart_item_unavailable" ? "item_unavailable" : "item_options_changed",
            line:
              cartItemReference === null
                ? null
                : { cartItemReference, available: null, sharedStock: false },
          };
        }
        default:
          return unconfirmed();
      }
    }
  };
  const detailsStep = async (
    active: Plan,
    quote: CheckoutQuote,
    options: CheckoutMutationOptions,
  ): Promise<SendRoundState | null | "restart"> => {
    if (active.draft === null) {
      const prior = active.priorDetails ?? null;
      active.draft = Object.freeze({
        detailsReference: prior?.detailsReference ?? keyFactory(),
        expectedVersion: prior?.detailsVersion ?? 0,
        cartReference: active.cart.cart.cartReference,
        cartVersion: active.cart.cart.version,
        quoteReference: quote.quoteReference,
        quoteVersion: quote.quoteVersion as 1 | 2,
        orderType: active.cart.cart.orderType,
        pickupContact: null,
        receipt: prior?.receipt ?? Object.freeze({ choice: "InSession", email: null }),
        policies: Object.freeze([]),
      });
    }
    try {
      await ports.saveDetails(active.draft, active.detailsOperation, options);
      active.detailsSaved = true;
      return null;
    } catch (error) {
      const code = error instanceof CheckoutDetailsClientError ? error.code : "unknown";
      switch (code) {
        case "conflict":
        case "requote":
          return "restart";
        case "policy":
        case "invalid":
          // Required documents answer here: the checkout page asks for the agreement.
          plan = null;
          return { status: "needs-page" };
        case "denied":
          plan = null;
          return { status: "session-ended" };
        default:
          return unconfirmed();
      }
    }
  };
  const sessionStep = async (
    active: Plan,
    quote: CheckoutQuote,
    options: CheckoutMutationOptions,
  ): Promise<SendRoundState | null | "restart"> => {
    active.sessionAttempted = true;
    try {
      active.session = await ports.createSession(
        {
          cartReference: active.cart.cart.cartReference,
          cartVersion: active.cart.cart.version,
          quoteReference: quote.quoteReference,
          quoteVersion: quote.quoteVersion as 1 | 2,
        },
        active.sessionOperation,
        options,
      );
      return null;
    } catch (error) {
      const code = error instanceof CheckoutSessionClientError ? error.code : "unknown";
      switch (code) {
        case "item_short":
        case "item_unavailable":
          plan = null;
          return {
            status: "refused",
            refusal: code,
            line: (error as CheckoutSessionClientError).line,
          };
        case "store_closed":
          plan = null;
          return { status: "store-closed" };
        // The restaurant updated its menu since this round was priced: no checkout was opened and
        // nothing placed, so it is priced again once (a changed total asks the guest first).
        case "requote_required":
          return "restart";
        case "checkout_in_progress":
          // Nothing was created: the retry after the wait is a new operation.
          active.sessionOperation = keyFactory();
          active.sessionAttempted = false;
          return {
            status: "busy",
            wait: "checkout-in-progress",
            retryAfterSeconds: (error as CheckoutSessionClientError).retryAfterSeconds,
          };
        case "denied":
          plan = null;
          return { status: "session-ended" };
        case "conflict":
        case "invalid":
          plan = null;
          return { status: "cart-changed" };
        default:
          return unconfirmed();
      }
    }
  };
  const sendStep = async (
    active: Plan,
    session: CheckoutSessionView,
    options: CheckoutMutationOptions,
  ): Promise<SendRoundState | "restart"> => {
    active.sendAttempted = true;
    try {
      const sent = await ports.send(session.checkoutSessionReference, active.selection, options);
      plan = null;
      return { status: "sent", held: sent.status === "Held" };
    } catch (error) {
      const code = error instanceof SessionPaymentClientError ? error.code : "unknown";
      switch (code) {
        case "pay_first_table":
          plan = null;
          setTablePaymentTiming("PayFirst");
          return { status: "pay-first" };
        case "store_closed":
          plan = null;
          return { status: "store-closed" };
        case "items_short":
          plan = null;
          return { status: "refused", refusal: "item_short", line: null };
        // The restaurant updated its menu since this round was priced, or staff moved the table
        // while it was being sent: nothing was placed or charged, so it is priced and sent again
        // once, from the table the party sits at now (a changed total asks the guest first).
        case "not_ready":
        case "requote_required":
        case "table_moved":
          return "restart";
        case "denied":
          plan = null;
          return { status: "session-ended" };
        case "conflict":
          plan = null;
          return { status: "cart-changed" };
        default:
          return unconfirmed();
      }
    }
  };
  const advance = async (
    active: Plan,
    options: CheckoutMutationOptions,
  ): Promise<SendRoundState> => {
    // A send may already have happened: finish it first, whatever the cart or table say now.
    if (!active.sendAttempted) {
      // Read together: each is a round trip a guest waits for, and neither depends on the other.
      const [table, details] = await Promise.allSettled([
        ports.readTable(),
        active.draft !== null || active.priorDetails !== undefined
          ? Promise.resolve(null)
          : ports.readDetails({
              cartReference: active.cart.cart.cartReference,
              cartVersion: active.cart.cart.version,
              orderType: active.cart.cart.orderType,
            }),
      ]);
      if (table.status === "fulfilled" && table.value.checkingOut) {
        plan = null;
        return { status: "table-checking-out" };
      }
      if (details.status === "rejected") {
        const code =
          details.reason instanceof CheckoutDetailsClientError ? details.reason.code : "unknown";
        if (code === "denied") {
          plan = null;
          return { status: "session-ended" };
        }
        if (code === "conflict") {
          plan = null;
          return { status: "cart-changed" };
        }
        return unconfirmed();
      }
      if (details.value !== null) active.priorDetails = details.value.details;
      if (!active.sessionAttempted) {
        // Prices that ran out while the guest looked are read again, before anything is sent.
        if (active.quote !== null && Date.parse(active.quote.expiresAt) <= now()) {
          if (active.draft !== null) return restart(active, options);
          active.quote = null;
          active.quoteOperation = keyFactory();
        }
        if (active.quote === null) {
          const failure = await quoteStep(active, options);
          if (failure !== null) return failure;
        }
      }
    }
    const quote = active.quote;
    if (active.session === null) {
      if (quote === null) return unconfirmed();
      if (!active.sessionAttempted) {
        if (quote.blockingReasons.length > 0) {
          plan = null;
          return {
            status: "blocked",
            messages: Object.freeze(quote.blockingReasons.map((c) => quoteIssueMessage(c, true))),
          };
        }
        if (quote.warnings.length > 0 || (quote.quoteVersion !== 1 && quote.quoteVersion !== 2)) {
          plan = null;
          return { status: "needs-page" };
        }
        const difference = priceCheck(quote, active.seen);
        if (
          difference !== null &&
          active.confirmedQuote !== quote.quoteReference &&
          !(active.confirmedTotalMinor !== null && asBig(quote.total) <= active.confirmedTotalMinor)
        )
          return { status: "confirm-total", total: quote.total, reason: difference };
        if (!active.detailsSaved) {
          const saved = await detailsStep(active, quote, options);
          if (saved === "restart") return restart(active, options);
          if (saved !== null) return saved;
        }
      }
      const created = await sessionStep(active, quote, options);
      if (created === "restart") return restart(active, options);
      if (created !== null) return created;
    }
    const session = active.session;
    if (session === null) return unconfirmed();
    const sent = await sendStep(active, session, options);
    return sent === "restart" ? restart(active, options) : sent;
  };
  const run = async (
    cart: CartView | null,
    seen: SeenSubtotal | null,
    shown: CheckoutQuote | null,
  ) => {
    const manual = state.status === "unconfirmed" || state.status === "busy";
    // The second tap on a total: this quote is what the guest agreed to.
    if (state.status === "confirm-total" && plan?.quote) {
      plan.confirmedQuote = plan.quote.quoteReference;
      plan.confirmedTotalMinor = asBig(plan.quote.total);
      // WP-2423 price-hold-dish-changes (DEC-PRICE-HOLD §2): the round is priced once more before
      // it goes on. Inside the hold the Store answers the same price, or a lower one when the
      // restaurant cut it meanwhile (the guest never pays more than the menu says); a higher
      // total than the one just confirmed stops again.
      if (!plan.detailsSaved && !plan.sessionAttempted && !plan.sendAttempted) {
        plan.quote = null;
        plan.quoteOperation = keyFactory();
      }
    }
    publish({ status: "sending" });
    const hadPlan = plan !== null;
    if (plan !== null && !plan.sendAttempted) {
      // A tap about the cart on screen starts over if it changed. A retry is about the old cart: what
      // it holds now is read first, and if that isn't it, the guest gets to see it before anything.
      const fresh = manual ? await readCart() : undefined;
      if (fresh === undefined ? cart !== null && movedOn(plan, cart) : movedOn(plan, fresh)) {
        plan = null;
        if (manual) {
          publish({ status: "cart-changed" });
          return;
        }
      }
    }
    if (plan === null) {
      if (cart === null || cart.cart.items.length === 0) {
        // The cart emptied under an unfinished plan: someone at the table placed it.
        publish({ status: hadPlan ? "cart-changed" : "idle" });
        return;
      }
      plan = newPlan(cart);
      // The price the cart on screen was given for this very cart version, while it lasts.
      if (
        shown != null &&
        shown.cartVersion === cart.cart.version &&
        Date.parse(shown.expiresAt) > now()
      )
        plan.quote = shown;
    }
    if (seen !== null) plan.seen = seen;
    const options: CheckoutMutationOptions = manual ? { busyTotalMs: manualRetryBusyTotalMs } : {};
    let outcome: SendRoundState;
    try {
      outcome = await advance(plan, options);
    } catch {
      outcome = unconfirmed();
    }
    if (outcome.status === "unconfirmed" && plan !== null && !plan.sendAttempted) {
      // Nothing was placed: this may just be a cart that moved on, with no outage behind it.
      const fresh = await readCart();
      if (fresh !== undefined && movedOn(plan, fresh)) {
        plan = null;
        outcome = { status: "cart-changed" };
      }
    } else if (outcome.status === "sent" && manual) {
      // An older round is finished; the cart may have gained dishes since.
      const fresh = await readCart();
      if (fresh === undefined || (fresh !== null && fresh.cart.items.length > 0))
        outcome = { ...outcome, more: true };
    }
    publish(outcome);
  };
  return Object.freeze({
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    send(cart: CartView | null, seen: SeenSubtotal | null, shown: CheckoutQuote | null = null) {
      if (flight !== null) return flight;
      const current = run(cart, seen, shown).finally(() => {
        flight = null;
      });
      flight = current;
      return current;
    },
    reset() {
      if (flight !== null) return;
      // Something a send may have done stays to be finished; anything else starts again next time.
      if (plan !== null && !plan.sendAttempted) plan = null;
      publish({ status: "idle" });
    },
  });
}

/** The real clients. Each already answers in the owners' terms. */
export function httpSendRoundPorts(): SendRoundPorts {
  const table = createTablePaymentClient();
  const quotes = createCheckoutClient(createBrowserCustomerCartClient());
  const reader = createCheckoutDetailsReadClient();
  const details = createCheckoutDetailsClient();
  const sessions = createCheckoutSessionClient();
  const payments = createSessionPaymentClient();
  return Object.freeze({
    readCart: () => quotes.loadCart(),
    readTable: () => table.read(),
    readDetails: (selection: CheckoutDetailsReadSelection) => reader.read(selection),
    quote: quotes.quote,
    saveDetails: details.save,
    createSession: sessions.create,
    send: payments.sendToKitchen,
  });
}

let shared: { readonly controller: SendRoundController; readonly current: () => boolean } | null =
  null;
/**
 * One controller for this guest's visit, so an answer still unknown survives leaving the cart page
 * (the menu and back): the guest can always finish that same round instead of ordering it again.
 */
export function sharedSendRoundController(): SendRoundController {
  if (shared === null || !shared.current())
    shared = {
      controller: createSendRoundController(httpSendRoundPorts()),
      current: captureCustomerCsrfContext(),
    };
  return shared.controller;
}

/** What the checkout page says when its own send to the kitchen fails. */
export function sendFailureState(
  error: unknown,
): "failed" | "pay_first" | "store_closed" | "items_short" {
  if (!(error instanceof SessionPaymentClientError)) return "failed";
  return error.code === "pay_first_table"
    ? "pay_first"
    : error.code === "store_closed" || error.code === "items_short"
      ? error.code
      : "failed";
}
