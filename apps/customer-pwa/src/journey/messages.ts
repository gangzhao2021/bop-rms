import { t } from "../i18n/i18n.js";
import type { CartState } from "../cart/cart-state.js";

/** Customer sentences for server codes. Raw codes never reach the page; unknown codes get one safe sentence. */

const cartItemWarnings: Readonly<Record<string, string>> = Object.freeze({
  get TRAINING_DATA_ONLY() {
    return t("Training data only.");
  },
  get SOLD_OUT() {
    return t("This item is sold out right now.");
  },
  get ITEM_UNAVAILABLE() {
    return t("This item is no longer on the menu.");
  },
  get OPTION_UNAVAILABLE() {
    return t("One of the choices for this item is no longer available.");
  },
  get PRICE_CHANGED() {
    return t("The price of this item changed since you added it.");
  },
  get QUANTITY_LIMITED() {
    return t("Fewer of this item are available than you chose.");
  },
});

const quoteIssues: Readonly<Record<string, string>> = Object.freeze({
  get TRAINING_DATA_ONLY() {
    return t("Training data only.");
  },
  get PRICE_COVERAGE_MISSING() {
    return t("An item in your order has no current price. Ask staff for help.");
  },
  get PRICE_BOOK_NOT_PUBLISHED() {
    return t("Prices are being updated. Please try again in a moment.");
  },
  get OPTION_PRICE_MISSING() {
    return t("One of your choices has no current price. Ask staff for help.");
  },
  get STOCK_RESERVATION_INSUFFICIENT() {
    return t("An item is no longer available in the quantity you chose.");
  },
  get CATALOG_SELECTION_REJECTED() {
    return t("An item or choice in your order is no longer available.");
  },
  get TAX_CONFIGURATION_NOT_EFFECTIVE() {
    return t("Tax can’t be calculated right now. Ask staff for help.");
  },
  get PROMOTION_STACKING_CONFLICT() {
    return t("Two discounts can’t be combined on this order.");
  },
});

const lineEstimateReasons: Readonly<Record<string, string>> = Object.freeze({
  get QUOTE_REQUIRED() {
    return t("Priced at checkout");
  },
  get PRICE_UNAVAILABLE() {
    return t("Price unavailable");
  },
});

/** Sentence for a cart line warning, or null when the code carries nothing a customer can act on. */
export function cartItemWarningMessage(code: string): string | null {
  if (code === "OTHER_PARTICIPANT_ITEM") return null;
  return cartItemWarnings[code] ?? t("Please check this item with staff before paying.");
}

/** Sentence for a quote warning or blocking reason. */
export function quoteIssueMessage(code: string, blocking: boolean): string {
  return (
    quoteIssues[code] ??
    (blocking
      ? t("This order can’t be paid yet. Ask staff for help.")
      : t("Please review your order before paying."))
  );
}

/** Short label when a line has no estimate. */
export function lineEstimateLabel(reasonCode: string): string {
  return lineEstimateReasons[reasonCode] ?? t("Priced at checkout");
}

/** Reasons the cart service gives for a rejected change, in customer words. */
export function cartIssueMessage(code: string): string | null {
  const known: Readonly<Record<string, string>> = {
    QUANTITY_OUT_OF_RANGE: t("Choose between 1 and 100 of an item."),
    OPTION_REQUIRED: t("A required choice is missing for this item."),
    OPTION_CONFLICT: t("Two of the chosen options can’t be combined."),
    OPTION_UNAVAILABLE: t("One of the chosen options is no longer available."),
    SELLABLE_UNAVAILABLE: t("This item is no longer available."),
    SOLD_OUT: t("This item is sold out right now."),
    // WP-2423: the store's stock can't make the quantity asked.
    ITEM_SHORT: t("We can’t make that many right now. Choose fewer."),
    NOTE_TOO_LONG: t("Your note is too long."),
  };
  return known[code] ?? null;
}

/*
 * WP-2423 C5 text catalog. Every sentence a guest reads on the cart, checkout and order status
 * pages lives here under a stable key, so a second language is one more catalog of the same shape
 * (the components only read keys). Wording that needs a value is a function of that value. One
 * voice throughout: plain words with contractions ("You’re offline", "We couldn’t") and the
 * typographic apostrophe. Guarded by `inline-text-guard.test.ts`.
 */

/** Words shared by the order summaries and navigation of several pages. */
export const commonText = Object.freeze({
  get subtotal() {
    return t("Subtotal");
  },
  get discount() {
    return t("Discount");
  },
  get tax() {
    return t("Tax");
  },
  get tip() {
    return t("Tip");
  },
  get fees() {
    return t("Fees");
  },
  get total() {
    return t("Total");
  },
  get notePrefix() {
    return t("Note:");
  },
  get browseMenu() {
    return t("Browse menu");
  },
  get returnToMenu() {
    return t("Return to menu");
  },
  get checkingYourCart() {
    return t("Checking your cart…");
  },
  get emptyCartHeading() {
    return t("Your cart is empty");
  },
  get offlineHeading() {
    return t("You’re offline");
  },
  get tryAgain() {
    return t("Try again");
  },
  get orderProcessingHeading() {
    return t("Order still processing");
  },
  get checkoutInProgressHeading() {
    return t("Another guest is checking out");
  },
  pricesConfirmedFor: (remaining: string) => t("Prices confirmed for {remaining}.", { remaining }),
});

// --- cart page (cart/CartPage.tsx) ---

/** The cart page, its lines, summary and recovery states. */
export const cartText = Object.freeze({
  get pageHeading() {
    return t("Your cart");
  },
  get loadingHeading() {
    return t("Loading cart");
  },
  get emptyBody() {
    return t("Add something from the menu to get started.");
  },
  get itemsHeading() {
    return t("Items");
  },
  itemCount: (count: number) => (count === 1 ? t("1 item") : t("{count} items", { count })),
  get actionsLabel() {
    return t("Cart actions");
  },
  get continueShopping() {
    return t("Continue shopping");
  },
  get checkout() {
    return t("Checkout");
  },
  /** What a screen reader hears when the cart changes state; never the state's internal name. */
  stateAnnouncement: Object.freeze({
    get loading() {
      return t("Loading your cart…");
    },
    get empty() {
      return t("Your cart is empty.");
    },
    get ready() {
      return t("Your cart is up to date.");
    },
    get "command-pending"() {
      return t("Updating your cart…");
    },
    get "offline-readonly"() {
      return t("You’re offline. Your cart can’t be changed until you reconnect.");
    },
    get "replacement-forbidden"() {
      return t("Your cart can’t be changed from this session. See the message on this page.");
    },
    get "session-expired"() {
      return t("Your session ended. Scan the location QR code again to continue.");
    },
    get "not-found"() {
      return t("This cart isn’t available. See the message on this page.");
    },
    get conflict() {
      return t("Your cart changed. Review it before trying again.");
    },
    get validation() {
      return t("Couldn’t update your cart. Review this item and try again.");
    },
    get "rate-limited"() {
      return t("Couldn’t update your cart. Wait a moment, then try again.");
    },
    get "order-processing"() {
      return t("Your order is still processing.");
    },
    get "checkout-in-progress"() {
      return t("Another guest is checking out.");
    },
    get "table-checking-out"() {
      return t("Your table is checking out.");
    },
    get expired() {
      return t("Your cart expired. See the message on this page.");
    },
    get abandoned() {
      return t("Your cart is closed. See the message on this page.");
    },
    get "command-failed"() {
      return t("Couldn’t confirm your change. Try again.");
    },
    get unavailable() {
      return t("Couldn’t update your cart. Try again.");
    },
  } satisfies Readonly<Record<CartState["status"], string>>),
  line: Object.freeze({
    get addedByAnotherGuest() {
      return t("Added by another guest. Only they can change this item.");
    },
    quantityGroupLabel: (item: string) => t("Quantity for {item}", { item }),
    decreaseLabel: (item: string) => t("Decrease {item} quantity", { item }),
    quantityLabel: (item: string) => t("{item} quantity", { item }),
    increaseLabel: (item: string) => t("Increase {item} quantity", { item }),
    get remove() {
      return t("Remove");
    },
  }),
  summary: Object.freeze({
    get heading() {
      return t("Order summary");
    },
    get checkoutUnavailable() {
      return t("This cart can’t be checked out right now.");
    },
    get totalAtCheckout() {
      return t("Your total, including tax, is calculated at checkout.");
    },
    get subtotalBeforeTax() {
      return t("Subtotal before tax");
    },
    get taxAtCheckout() {
      return t("Tax is added at checkout.");
    },
    get pricesExpired() {
      return t("These prices have expired. Checkout will price your order again.");
    },
  }),
  /** Heading and sentence for each recoverable cart failure. */
  failure: Object.freeze({
    get replacementForbidden() {
      return [
        t("Cart replacement not permitted"),
        t(
          "This session isn’t part of the table any more, or only the person who started the table can restart this cart. Scan the table QR code again or ask staff for help.",
        ),
      ] as const;
    },
    get tableCheckingOut() {
      return [
        t("Your table is checking out"),
        t(
          "New dishes can’t be sent while the bill is being settled. To add more, ask a staff member.",
        ),
      ] as const;
    },
    get sessionExpired() {
      return [
        t("Session expired"),
        t("Scan the location QR code again to continue your order."),
      ] as const;
    },
    get notFound() {
      return [
        t("Cart not found"),
        t("This cart isn’t available in your current session."),
      ] as const;
    },
    get conflict() {
      return [
        t("Cart changed"),
        t("The latest cart was loaded. Review your change before submitting again."),
      ] as const;
    },
    get validation() {
      return [t("Review this item"), t("This choice can’t be ordered as selected.")] as const;
    },
    get rateLimitedHeading() {
      return t("Please wait");
    },
    rateLimited: (retryAfterSeconds: number | null) =>
      retryAfterSeconds === null
        ? t("Try again shortly.")
        : t("Try again in {seconds} seconds.", { seconds: retryAfterSeconds }),
    get expiredHeading() {
      return t("Cart expired");
    },
    get expiredDineIn() {
      return t(
        "This cart timed out. Return to the menu and add an item; your table continues with a new cart.",
      );
    },
    get expiredOther() {
      return t("This cart can’t accept more items. Ask staff for help continuing your order.");
    },
    get abandoned() {
      return [t("Cart closed"), t("This cart was abandoned and can’t be changed.")] as const;
    },
    get commandFailed() {
      return [
        t("Outcome not confirmed"),
        t("The connection dropped before we could confirm your change."),
      ] as const;
    },
    get unavailable() {
      return [
        t("We couldn’t load your cart"),
        t("Nothing was changed. Try loading it again."),
      ] as const;
    },
    get notEnoughLeftHeading() {
      return t("Not enough left");
    },
    get retrySameOperation() {
      return t("Retry the same operation");
    },
    get refreshCart() {
      return t("Refresh cart");
    },
  }),
  offline: Object.freeze({
    get reconnectToLoad() {
      return t("Reconnect to load your cart.");
    },
    get refreshAfterReconnecting() {
      return t("Refresh after reconnecting");
    },
    get paused() {
      return t(
        "You’re offline. Changes and checkout are paused; nothing will replay on reconnect.",
      );
    },
  }),
  featureDisabled: Object.freeze({
    get heading() {
      return t("Ordering is paused");
    },
    get body() {
      return t("Cart ordering isn’t enabled at this location right now.");
    },
  }),
  closed: Object.freeze({
    get expiredHeading() {
      return t("Cart expired");
    },
    get closedHeading() {
      return t("Cart closed");
    },
    get body() {
      return t("This cart can’t accept more items. Your previously paid orders remain unchanged.");
    },
    get anyoneCanRestart() {
      return t(
        "Anyone at your table can start an empty cart to keep ordering. Items that weren’t ordered aren’t copied.",
      );
    },
    get starterCanRestart() {
      return t(
        "The person who started the table can start an empty cart to continue ordering. Previous items won’t be copied.",
      );
    },
    get startEmptyCart() {
      return t("Start an empty cart");
    },
    get askStaff() {
      return t("Ask staff for help continuing your order.");
    },
  }),
  get stale() {
    return t("Your cart may be out of date. Refresh before making a change.");
  },
  get quoteExpired() {
    return t("Prices have expired. Checkout will price your order again.");
  },
});
// --- end cart page ---

// --- checkout page (checkout/CheckoutPage.tsx, checkout/CheckoutDetailsForm.tsx) ---
/** Checkout review page and the details form inside it. */
export const checkoutText = Object.freeze({
  get pageTitle() {
    return t("Checkout");
  },
  get progressLabel() {
    return t("Checkout progress");
  },
  get progressReview() {
    return t("Review");
  },
  get progressPay() {
    return t("Pay");
  },
  get progressDone() {
    return t("Done");
  },
  get loadingHeading() {
    return t("Loading checkout");
  },
  get emptyCartBody() {
    return t("Add something from the menu before checking out.");
  },
  get orderHeading() {
    return t("Your order");
  },
  get editCart() {
    return t("Edit cart");
  },
  get calculatingTotal() {
    return t("Calculating your total…");
  },
  get tip() {
    return t("Tip");
  },
  get pricesExpired() {
    return t("These prices expired. Refresh to price your order again.");
  },
  get refreshPrices() {
    return t("Refresh prices");
  },
  get priceChanged() {
    return t("Price changed. Confirm the new total before continuing.");
  },
  get confirmChangedPrice() {
    return t("I confirm the changed price");
  },
  get pricesNeedRefreshHeading() {
    return t("Prices need a refresh");
  },
  get previousPricesExpired() {
    return t("Your previous prices expired. Refresh to price your order again.");
  },
  get cartChanged() {
    return t("Your cart changed. Refresh to price the current cart.");
  },
  get cartValidation() {
    return t(
      "Something in your cart can’t be ordered as selected. Review your cart, then refresh.",
    );
  },
  get pricingUnavailable() {
    return t(
      "We couldn’t price your order just now. Try again in a moment; if it still doesn’t work, ask staff to take your order.",
    );
  },
  get attentionHeading() {
    return t("Checkout needs attention");
  },
  get offline() {
    return t("You’re offline. Reconnect to continue; nothing will be submitted automatically.");
  },
  get pricingOutcomeUnknown() {
    return t("We couldn’t confirm your prices. Retry to continue without creating a second order.");
  },
  get sessionEnded() {
    return t("Your session ended. Scan the location QR code again to continue.");
  },
  get retryPricing() {
    return t("Retry pricing");
  },
  get tipAmountLabel() {
    return t("Tip amount");
  },
  get noTip() {
    return t("No tip");
  },
  tipPercent: (percent: number) => `${percent}%`,
  get tipOther() {
    return t("Other");
  },
  tipCustomLabel: (symbol: string) => t("Tip ({symbol})", { symbol }),
  get tipInvalid() {
    return t("Enter a valid amount with up to two decimal places.");
  },
  get tipHelp() {
    return t("Enter an amount in dollars. Your tip is fixed when you continue to payment.");
  },
  get paymentLabel() {
    return t("Payment");
  },
  get savingYourDetails() {
    return t("Saving your details…");
  },
  get preparingPayment() {
    return t("Preparing secure payment…");
  },
  get changeYourCart() {
    return t("Change your cart");
  },
  get storeClosed() {
    return t(
      "The store isn’t taking new orders right now — it’s closed, or the kitchen has stopped taking orders for today — so you haven’t been charged. To add something, ask a staff member.",
    );
  },
  get checkoutUnconfirmed() {
    return t("We couldn’t confirm checkout. Retry to recover the same checkout.");
  },
  get checkoutRefused() {
    return t(
      "We couldn’t continue this checkout. Review your cart and scan the QR code again if needed.",
    );
  },
  get retryCheckout() {
    return t("Retry checkout");
  },
  get continueToPayment() {
    return t("Continue to payment");
  },
  continueToPaymentWithTotal: (total: string) => t("Continue to payment · {total}", { total }),
  /** DEC-DINE-IN-PAY-LATER: a table that pays once at the end. */
  sendToKitchenWithTotal: (total: string) => t("Send to the kitchen · {total}", { total }),
  get sendToKitchen() {
    return t("Send to the kitchen");
  },
  get sendToKitchenNote() {
    return t(
      "Nothing is charged now. Your table pays once at the end, and you choose any tip then.",
    );
  },
  get progressSend() {
    return t("Send");
  },
  get sendingToKitchen() {
    return t("Sending your order to the kitchen…");
  },
  get sendToKitchenFailed() {
    return t(
      "We couldn’t confirm your order reached the kitchen. Send it again — it is never sent twice.",
    );
  },
  get tablePaysAsItOrders() {
    return t("This table pays for each round as it orders. Continue to payment instead.");
  },
  get continueNote() {
    return t("You’ll enter your card on the next step. Nothing is charged until you confirm.");
  },
  /** Internal testing with the simulated payment: no card is asked for and nothing is charged. */
  get continueNoteSimulated() {
    return t(
      "Next you’ll confirm a test payment. This is internal testing: no card is needed and no real money is charged.",
    );
  },
  // Details form (checkout/CheckoutDetailsForm.tsx)
  get detailsLabel() {
    return t("Checkout details");
  },
  get detailsLoading() {
    return t("Loading checkout details…");
  },
  get detailsLoadFailed() {
    return t("We couldn’t load your checkout details. Refresh your checkout to try again.");
  },
  get reloadDetails() {
    return t("Reload checkout details");
  },
  get detailsHeadingPickup() {
    return t("Your details");
  },
  get receipt() {
    return t("Receipt");
  },
  get pickupContactLegend() {
    return t("Pickup contact");
  },
  get pickupContactPurpose() {
    return t(
      "The store uses this only to contact you about this order, for example if an item sold out. It’s deleted 30 days after your order, and you can remove it sooner from your order page.",
    );
  },
  get pickupName() {
    return t("Pickup name");
  },
  get contactMethod() {
    return t("Contact method");
  },
  get contactMethodPhone() {
    return t("Phone");
  },
  get contactMethodEmail() {
    return t("Email");
  },
  get mobileNumber() {
    return t("Mobile number");
  },
  get pickupEmail() {
    return t("Pickup email");
  },
  get dineInNoContact() {
    return t("No contact details are required for your dine-in order.");
  },
  get receiptOnOrderPage() {
    return t("Your receipt appears on your order page, where you can print or save it.");
  },
  /** DEC-PILOT-NOTIFICATIONS: shown only when the store can actually send that message. */
  get orderTextsPhone() {
    return t("We’ll also text you when the store has your order and when it’s ready.");
  },
  get orderTextsEmail() {
    return t("We’ll also email you when the store has your order and when it’s ready.");
  },
  get emailReceipt() {
    return t("Email my receipt");
  },
  get receiptEmail() {
    return t("Receipt email");
  },
  get receiptEmailPurpose() {
    return t(
      "We send your receipt to this address once. It’s deleted 30 days after your order, and you can remove it sooner from your order page.",
    );
  },
  get agreePolicies() {
    return t("I’ve read and agree to the policies above");
  },
  get detailsExpired() {
    return t("Checkout information expired. Get a current quote and reload details before saving.");
  },
  get savingDetails() {
    return t("Saving checkout details…");
  },
  get detailsSaved() {
    return t("Checkout details saved.");
  },
  get detailsInvalid() {
    return t(
      "Check your contact and receipt fields. Enter a mobile number such as 416 555 0123, or include the country code for numbers outside North America.",
    );
  },
  get detailsCheckoutChanged() {
    return t("Your checkout changed. Reload details before trying again.");
  },
  get detailsSaveUnconfirmed() {
    return t("We couldn’t confirm your details were saved. Retry saving before changing them.");
  },
  get retrySavingDetails() {
    return t("Retry saving details");
  },
  get saveDetails() {
    return t("Save details");
  },
});
// --- end checkout page ---

// --- order status page (order-status/OrderStatusPage.tsx, order-status/ContactDetailsSection.tsx) ---
/** Order status page and its contact details section. */
export const orderStatusText = Object.freeze({
  get pageEyebrow() {
    return t("Order status");
  },
  get pageHeading() {
    return t("Track your order");
  },
  /** Figma v1: a pickup order's steps, and whether each is done or happening now. */
  timeline: Object.freeze({
    get label() {
      return t("Order progress");
    },
    get steps() {
      return [
        // The order page says "Payment received", never "Paid" (it would read as the amount).
        t("Payment received"),
        t("Accepted by the store"),
        t("Being made"),
        t("Ready for pickup"),
        t("Picked up"),
      ] as const;
    },
    get done() {
      return t("Done");
    },
    get now() {
      return t("Now");
    },
  }),
  /** Why the store cancelled, keyed by the server's reason code. */
  cancelReason: Object.freeze({
    get CustomerRequest() {
      return t("The store cancelled it at your request.");
    },
    get SoldOut() {
      return t("An item you ordered sold out.");
    },
    get StoreError() {
      return t("The store couldn’t prepare it.");
    },
    get DuplicateOrder() {
      return t("It was a duplicate of another order.");
    },
    get GuestLeft() {
      return t("The table was closed after your party left, before this was made.");
    },
  }),
  get staffRefunded() {
    return t("Your payment was refunded in full.");
  },
  get staffRefundPending() {
    return t("Refund pending — your payment is being returned in full.");
  },
  itemCancelled: (refund: string, amount: string) =>
    t("Cancelled · {refund}{amount}", { refund, amount }),
  get itemRefunded() {
    return t("Refunded");
  },
  get itemRefundPending() {
    return t("Refund pending");
  },
  cancelledItemsRefunded: (amount: string) =>
    t(
      "Cancelled items: {amount} refunded to your original payment (tax and their share of any tip included).",
      { amount },
    ),
  cancelledItemsRefundedWithTip: (amount: string, tip: string) =>
    t("Cancelled items: {amount} refunded to your original payment, including {tip} of the tip.", {
      amount,
      tip,
    }),
  cancelledItemsRefundedNoTip: (amount: string) =>
    t("Cancelled items: {amount} refunded to your original payment (tax included).", { amount }),
  cancelledItemsRefundPending: (amount: string) =>
    t(
      "Cancelled items: a refund of {amount} to your original payment is pending (tax and their share of any tip included).",
      { amount },
    ),
  /** The order's progress heading and sentence, per situation. */
  progress: Object.freeze({
    get storeCancelledHeading() {
      return t("Order cancelled by the store");
    },
    get notAcceptedHeading() {
      return t("Order not accepted");
    },
    get notAcceptedRefunded() {
      return t(
        "The store couldn’t accept your order, so your payment was refunded to your original payment method.",
      );
    },
    get notAcceptedRefunding() {
      return t(
        "The store couldn’t accept your order, so your payment is being refunded to your original payment method.",
      );
    },
    get awaitingStoreHeading() {
      return t("Waiting for the store");
    },
    get awaitingStore() {
      return t("The store hasn’t confirmed your order yet. Please wait or contact the store.");
    },
    get cancelledHeading() {
      return t("Order cancelled");
    },
    get unpaidPickupCancelled() {
      return t(
        "Payment wasn’t completed within 30 minutes, so this order was cancelled. If a payment still goes through, it will be refunded automatically.",
      );
    },
    get collectedHeading() {
      return t("Order collected");
    },
    get collected() {
      return t("Your order has been collected. Enjoy!");
    },
    get notCollectedHeading() {
      return t("Not collected");
    },
    get notCollected() {
      return t(
        "The store closed this pickup after the pickup time ended. Contact the store about your order or a refund.",
      );
    },
    get cancelled() {
      return t("Your order has been cancelled.");
    },
    get rejected() {
      return t("Your order wasn’t accepted.");
    },
    get remakingPickupHeading() {
      return t("Remaking part of your order");
    },
    get remakingPickup() {
      return t(
        "We’re remaking part of your order. We’ll have it ready shortly — please wait before collecting it.",
      );
    },
    get remakingDineInHeading() {
      return t("Remaking an item");
    },
    get remakingDineIn() {
      return t("We’re remaking an item for you. It will be brought to your table shortly.");
    },
    get servedHeading() {
      return t("Items served");
    },
    get served() {
      return t("All listed items have been served.");
    },
    get completeHeading() {
      return t("Order complete");
    },
    get complete() {
      return t("Your order is complete. Thank you for visiting!");
    },
    get awaitingPaymentHeading() {
      return t("Waiting for payment");
    },
    get awaitingPaymentSomeServed() {
      return t(
        "Everything paid for has been served. The kitchen starts the next round once it’s paid.",
      );
    },
    get awaitingPayment() {
      return t("The kitchen starts your order once it’s paid.");
    },
    get servingHeading() {
      return t("Serving your order");
    },
    get serving() {
      return t("Some items have been served. Check the remaining items below.");
    },
    get readyPickupHeading() {
      return t("Ready for pickup");
    },
    get readyPickup() {
      return t("Your order is ready. Collect it at the counter.");
    },
    get readyDineInHeading() {
      return t("Your order is ready");
    },
    get readyDineIn() {
      return t("Your food is ready and will be brought to your table shortly.");
    },
    get preparingHeading() {
      return t("Preparing your order");
    },
    get preparing() {
      return t("The kitchen is preparing your order.");
    },
    get acceptedHeading() {
      return t("Order accepted");
    },
    get acceptedPickup() {
      return t("The store has your order and will start preparing it soon.");
    },
    get acceptedDineIn() {
      return t("The kitchen has your order and will start preparing it soon.");
    },
    get submittedHeading() {
      return t("Order submitted");
    },
    get submitted() {
      return t("We have your order. The store will confirm it shortly.");
    },
  }),
  /** The payment row of the order summary. */
  payment: Object.freeze({
    refunded: (amount: string) => t("Refunded {amount}", { amount }),
    refundPending: (amount: string) => t("Refund pending · {amount}", { amount }),
    received: (amount: string) => t("Payment received {amount}", { amount }),
    /** WP-2423 (v15 3cd0f8dd H1): a table that paid some rounds online and some with staff. */
    receivedBoth: (amount: string, online: string, machine: string) =>
      t("Payment received {amount} ({online} online, {machine} on the store’s card machine)", {
        amount,
        online,
        machine,
      }),
    receivedMachine: (amount: string) =>
      t("Payment received {amount} on the store’s card machine", { amount }),
    get notPaid() {
      return t("Not paid");
    },
    get attemptFailed() {
      return t("Payment attempt failed");
    },
    get pending() {
      return t("Payment pending");
    },
  }),
  /** The kitchen status row of the order summary and each round's kitchen line. */
  kitchen: Object.freeze({
    get cancelled() {
      return t("Cancelled");
    },
    get remaking() {
      return t("Remaking an item");
    },
    get ready() {
      return t("Ready");
    },
    get preparing() {
      return t("Preparing");
    },
    get notStarted() {
      return t("Not started yet");
    },
    get inQueue() {
      return t("In the queue");
    },
    get awaitingPayment() {
      return t("Waiting for payment");
    },
    get done() {
      return t("Done");
    },
  }),
  orderEyebrow: (orderNumber: string) => t("Order {orderNumber}", { orderNumber }),
  get orderTypeLabel() {
    return t("Order type");
  },
  get orderTypeDineIn() {
    return t("Dine in");
  },
  get orderTypePickup() {
    return t("Pickup");
  },
  get kitchenStatusLabel() {
    return t("Kitchen status");
  },
  get paymentLabel() {
    return t("Payment");
  },
  /** WP-2423 (v15 3cd0f8dd M3): confirmed refunds on the order. */
  get refundedLabel() {
    return t("Refunded");
  },
  get itemRefundedTag() {
    return t("Refunded");
  },
  refundReturned: (amount: string) =>
    t("Refund: {amount} returned to your original payment.", { amount }),
  refundReturnedWithTip: (amount: string, tip: string) =>
    t("Refund: {amount} returned to your original payment, including {tip} of the tip.", {
      amount,
      tip,
    }),
  get paymentDelayedHeading() {
    return t("Payment update may be delayed");
  },
  get paymentDelayed() {
    return t("This payment update may be out of date. Refresh to check again.");
  },
  get statusDelayedHeading() {
    return t("Status may be delayed");
  },
  get statusRebuilding() {
    return t("We’re updating your order status. Check again shortly.");
  },
  get statusFailed() {
    return t("We couldn’t update your order status. The details below may be out of date.");
  },
  get statusStale() {
    return t("The details below may be out of date. Refresh to check for an update.");
  },
  get itemsHeading() {
    return t("Your items");
  },
  /** WP-2423 (v15 8c4480dd M1): a dine-in table shares one order across its guests' rounds. */
  get tableItemsHeading() {
    return t("Ordered at your table");
  },
  get tableItemsNote() {
    return t("Every round at your table, from you and the other guests.");
  },
  roundHeading: (round: number) => t("Round {round}", { round }),
  get roundCancelledByStoreUnpaid() {
    return t("This round was cancelled by the store. Nobody was charged for it.");
  },
  get orderCancelledByStoreUnpaid() {
    return t("This order was cancelled by the store. Nobody was charged for it.");
  },
  get roundCancelledUnpaid() {
    return t(
      "This round was cancelled because its payment didn’t go through. You weren’t charged for it.",
    );
  },
  get orderCancelledUnpaid() {
    return t(
      "This order was cancelled because its payment didn’t go through. You weren’t charged for it.",
    );
  },
  get roundPaymentFailed() {
    return t("Payment for this round didn’t go through. ");
  },
  get orderPaymentFailed() {
    return t("Payment for your order didn’t go through. ");
  },
  cancelsAt: (time: string) =>
    t("It will be cancelled at {time} Ask a staff member if you need help.", { time }),
  get roundCancelledByStore() {
    return t("This round was cancelled by the store. ");
  },
  get orderCancelledByStore() {
    return t("Cancelled by the store. ");
  },
  get roundAwaitingPayment() {
    return t("Waiting for payment");
  },
  get roundServed() {
    return t("Served");
  },
  get roundPartlyServed() {
    return t("Partly served");
  },
  get itemCancelledLabel() {
    return t("Cancelled");
  },
  get itemNotPaid() {
    return t("Not paid");
  },
  get itemBeingRemade() {
    return t("Being remade");
  },
  itemServedOf: (served: number | undefined, quantity: number) =>
    t("Served {value1} of {quantity}", { value1: served ?? "", quantity }),
  get discountsAndFees() {
    return t("Discounts and fees");
  },
  get totalIncludingTax() {
    return t("Total including tax");
  },
  get totalIncludingTaxAndTip() {
    return t("Total including tax and tip");
  },
  get unpaidRoundsExcluded() {
    return t("Rounds that weren’t paid aren’t included.");
  },
  /** The visit on this browser has ended. */
  visitEnded: Object.freeze({
    get heading() {
      return t("Your visit on this phone has ended");
    },
    /** WP-2423 (v15 3cd0f8dd M5): a guest who left still gets their receipt. */
    get receipt() {
      return t(
        "You can still view and save your receipt on this phone for 24 hours after your visit started.",
      );
    },
    get viewReceipt() {
      return t("View your receipt");
    },
    get atTable() {
      return t(
        "Still at your table and want to order more? Scan the table QR code again. If it asks for a table code, a staff member can give it to you.",
      );
    },
    get pickup() {
      return t(
        "For a pickup order: the store still has your order. Give your name or order number at the counter.",
      );
    },
    get start() {
      return t("Go to the start");
    },
  }),
  /** WP-2423 (46940b76 L5): this browser never placed the order (or its receipt time ended). */
  notThisPhone: Object.freeze({
    get heading() {
      return t("This order isn’t available on this phone");
    },
    get body() {
      return t(
        "An order opens only on the phone or browser that placed it. If it’s your order, give your order number to a staff member.",
      );
    },
    get start() {
      return t("Go to the start");
    },
  }),
  /** WP-2423 (46940b76 L5): another guest at the same open table placed the order. */
  tableOrder: Object.freeze({
    get heading() {
      return t("Another guest at your table placed this order");
    },
    get body() {
      return t(
        "You can follow your table’s order, and what has been served, on your table’s page.",
      );
    },
    get seeTable() {
      return t("See your table");
    },
  }),
  get loadingHeading() {
    return t("Loading order status");
  },
  get receivedHeading() {
    return t("Order received");
  },
  received: (orderNumber: string) =>
    t(
      "Order {orderNumber} is in. Its progress will show here in a few seconds — this page updates by itself.",
      { orderNumber },
    ),
  get receivedNoChange() {
    return t("If nothing changes after a minute, give your order number to a staff member.");
  },
  get invalidHeading() {
    return t("Order link is invalid");
  },
  get invalid() {
    return t("Use the exact link provided after checkout.");
  },
  get disabledHeading() {
    return t("Order tracking is disabled");
  },
  get unavailableHeading() {
    return t("Order status isn’t available");
  },
  get unavailable() {
    return t("We couldn’t load your order status. Please try again.");
  },
  get tryLoadingStatus() {
    return t("Try loading status");
  },
  get offlineShowingLast() {
    return t("Showing the last status loaded on this page.");
  },
  get offlineConnect() {
    return t("Connect to the internet to load your order status.");
  },
  get offlineReconnect() {
    return t("Reconnect and refresh to check again.");
  },
  get updatesLabel() {
    return t("Updates");
  },
  get liveUpdatesOn() {
    return t("Live updates are on.");
  },
  get orderComplete() {
    return t("This order is complete.");
  },
  get checksEveryFewSeconds() {
    return t("This page checks for updates every few seconds.");
  },
  get refreshing() {
    return t("Refreshing…");
  },
  get refreshNow() {
    return t("Refresh now");
  },
  get seeTableOrders() {
    return t("See everything your table ordered");
  },
  get viewReceipt() {
    return t("View receipt and support");
  },
  get backToMenu() {
    return t("Back to menu");
  },
  /** The guest's own contact details section. */
  contact: Object.freeze({
    /** What this page's removal request found, keyed by the server's result code. */
    outcome: Object.freeze({
      get Removed() {
        return t("Your contact details have been removed from this order.");
      },
      get AlreadyRemoved() {
        return t(
          "Your contact details had already been removed from this order. There is nothing more to remove.",
        );
      },
      get NotGiven() {
        return t("There were no contact details on this order.");
      },
    }),
    get visitEnded() {
      return t(
        "Your visit on this phone has ended, so this can’t be changed here. Ask a staff member to remove your contact details.",
      );
    },
    get removalFailed() {
      return t(
        "Your contact details couldn’t be removed right now. Check your connection and try again.",
      );
    },
    get defaultStoreName() {
      return t("The store");
    },
    get heading() {
      return t("Your contact details");
    },
    storeKeeps: (store: string) =>
      t(
        "{store} keeps the phone number or email you gave only to contact you about this order, and deletes it 30 days after your order.",
        { store },
      ),
    get remove() {
      return t("Remove my contact details");
    },
    get confirmLabel() {
      return t("Confirm removal");
    },
    get confirm() {
      return t(
        "Remove them now? The store won’t be able to call or email you about this order. You can still collect it by showing your order number.",
      );
    },
    get removing() {
      return t("Removing…");
    },
    get removeNow() {
      return t("Remove now");
    },
    get keep() {
      return t("Keep them");
    },
    get removed() {
      return t("Your contact details have been removed from this order.");
    },
  }),
});
// --- end order status page ---

/** DEC-PILOT-NOTIFICATIONS R1: the page a one-time order link opens (IDR-0031). */
export const orderRecoveryText = Object.freeze({
  get openingHeading() {
    return t("Opening your order");
  },
  get opening() {
    return t("Opening your order on this phone…");
  },
  get expiredHeading() {
    return t("This link can’t open your order");
  },
  get expired() {
    return t("The link has expired or was already used. Each link works once, for 30 minutes.");
  },
  get tooManyTries() {
    return t("There were too many tries with this link. Please wait an hour or ask the store.");
  },
  get staff() {
    return t("The store still has your order. Give your name or order number to a staff member.");
  },
  get start() {
    return t("Go to the start");
  },
  get tryAgainHeading() {
    return t("We couldn’t reach the store");
  },
  get tryAgain() {
    return t("Check your connection, then try again.");
  },
  get tryAgainButton() {
    return t("Try again");
  },
});
