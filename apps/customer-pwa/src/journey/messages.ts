import type { CartState } from "../cart/cart-state.js";

/** Customer sentences for server codes. Raw codes never reach the page; unknown codes get one safe sentence. */

const cartItemWarnings: Readonly<Record<string, string>> = Object.freeze({
  TRAINING_DATA_ONLY: "Training data only.",
  SOLD_OUT: "This item is sold out right now.",
  ITEM_UNAVAILABLE: "This item is no longer on the menu.",
  OPTION_UNAVAILABLE: "One of the choices for this item is no longer available.",
  PRICE_CHANGED: "The price of this item changed since you added it.",
  QUANTITY_LIMITED: "Fewer of this item are available than you chose.",
});

const quoteIssues: Readonly<Record<string, string>> = Object.freeze({
  TRAINING_DATA_ONLY: "Training data only.",
  PRICE_COVERAGE_MISSING: "An item in your order has no current price. Ask staff for help.",
  PRICE_BOOK_NOT_PUBLISHED: "Prices are being updated. Please try again in a moment.",
  OPTION_PRICE_MISSING: "One of your choices has no current price. Ask staff for help.",
  STOCK_RESERVATION_INSUFFICIENT: "An item is no longer available in the quantity you chose.",
  CATALOG_SELECTION_REJECTED: "An item or choice in your order is no longer available.",
  TAX_CONFIGURATION_NOT_EFFECTIVE: "Tax can’t be calculated right now. Ask staff for help.",
  PROMOTION_STACKING_CONFLICT: "Two discounts can’t be combined on this order.",
});

const lineEstimateReasons: Readonly<Record<string, string>> = Object.freeze({
  QUOTE_REQUIRED: "Priced at checkout",
  PRICE_UNAVAILABLE: "Price unavailable",
});

/** Sentence for a cart line warning, or null when the code carries nothing a customer can act on. */
export function cartItemWarningMessage(code: string): string | null {
  if (code === "OTHER_PARTICIPANT_ITEM") return null;
  return cartItemWarnings[code] ?? "Please check this item with staff before paying.";
}

/** Sentence for a quote warning or blocking reason. */
export function quoteIssueMessage(code: string, blocking: boolean): string {
  return (
    quoteIssues[code] ??
    (blocking
      ? "This order can’t be paid yet. Ask staff for help."
      : "Please review your order before paying.")
  );
}

/** Short label when a line has no estimate. */
export function lineEstimateLabel(reasonCode: string): string {
  return lineEstimateReasons[reasonCode] ?? "Priced at checkout";
}

/** Reasons the cart service gives for a rejected change, in customer words. */
export function cartIssueMessage(code: string): string | null {
  const known: Readonly<Record<string, string>> = {
    QUANTITY_OUT_OF_RANGE: "Choose between 1 and 100 of an item.",
    OPTION_REQUIRED: "A required choice is missing for this item.",
    OPTION_CONFLICT: "Two of the chosen options can’t be combined.",
    OPTION_UNAVAILABLE: "One of the chosen options is no longer available.",
    SELLABLE_UNAVAILABLE: "This item is no longer available.",
    SOLD_OUT: "This item is sold out right now.",
    // WP-2423: the store's stock can't make the quantity asked.
    ITEM_SHORT: "We can’t make that many right now. Choose fewer.",
    NOTE_TOO_LONG: "Your note is too long.",
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
  subtotal: "Subtotal",
  discount: "Discount",
  tax: "Tax",
  tip: "Tip",
  fees: "Fees",
  total: "Total",
  notePrefix: "Note:",
  browseMenu: "Browse menu",
  returnToMenu: "Return to menu",
  checkingYourCart: "Checking your cart…",
  emptyCartHeading: "Your cart is empty",
  offlineHeading: "You’re offline",
  tryAgain: "Try again",
  orderProcessingHeading: "Order still processing",
  checkoutInProgressHeading: "Another guest is checking out",
  pricesConfirmedFor: (remaining: string) => `Prices confirmed for ${remaining}.`,
});

// --- cart page (cart/CartPage.tsx) ---

/** The cart page, its lines, summary and recovery states. */
export const cartText = Object.freeze({
  pageHeading: "Your cart",
  loadingHeading: "Loading cart",
  emptyBody: "Add something from the menu to get started.",
  itemsHeading: "Items",
  itemCount: (count: number) => (count === 1 ? "1 item" : `${count} items`),
  actionsLabel: "Cart actions",
  continueShopping: "Continue shopping",
  checkout: "Checkout",
  /** What a screen reader hears when the cart changes state; never the state's internal name. */
  stateAnnouncement: Object.freeze({
    loading: "Loading your cart…",
    empty: "Your cart is empty.",
    ready: "Your cart is up to date.",
    "command-pending": "Updating your cart…",
    "offline-readonly": "You’re offline. Your cart can’t be changed until you reconnect.",
    "replacement-forbidden":
      "Your cart can’t be changed from this session. See the message on this page.",
    "session-expired": "Your session ended. Scan the location QR code again to continue.",
    "not-found": "This cart isn’t available. See the message on this page.",
    conflict: "Your cart changed. Review it before trying again.",
    validation: "Couldn’t update your cart. Review this item and try again.",
    "rate-limited": "Couldn’t update your cart. Wait a moment, then try again.",
    "order-processing": "Your order is still processing.",
    "checkout-in-progress": "Another guest is checking out.",
    expired: "Your cart expired. See the message on this page.",
    abandoned: "Your cart is closed. See the message on this page.",
    "command-failed": "Couldn’t confirm your change. Try again.",
    unavailable: "Couldn’t update your cart. Try again.",
  } satisfies Readonly<Record<CartState["status"], string>>),
  line: Object.freeze({
    addedByAnotherGuest: "Added by another guest. Only they can change this item.",
    quantityGroupLabel: (item: string) => `Quantity for ${item}`,
    decreaseLabel: (item: string) => `Decrease ${item} quantity`,
    quantityLabel: (item: string) => `${item} quantity`,
    increaseLabel: (item: string) => `Increase ${item} quantity`,
    remove: "Remove",
  }),
  summary: Object.freeze({
    heading: "Order summary",
    checkoutUnavailable: "This cart can’t be checked out right now.",
    totalAtCheckout: "Your total, including tax, is calculated at checkout.",
    pricesExpired: "These prices have expired. Checkout will price your order again.",
  }),
  /** Heading and sentence for each recoverable cart failure. */
  failure: Object.freeze({
    replacementForbidden: [
      "Cart replacement not permitted",
      "This session isn’t part of the table any more, or only the person who started the table can restart this cart. Scan the table QR code again or ask staff for help.",
    ] as const,
    sessionExpired: [
      "Session expired",
      "Scan the location QR code again to continue your order.",
    ] as const,
    notFound: ["Cart not found", "This cart isn’t available in your current session."] as const,
    conflict: [
      "Cart changed",
      "The latest cart was loaded. Review your change before submitting again.",
    ] as const,
    validation: ["Review this item", "This choice can’t be ordered as selected."] as const,
    rateLimitedHeading: "Please wait",
    rateLimited: (retryAfterSeconds: number | null) =>
      `Try again${retryAfterSeconds === null ? " shortly" : ` in ${retryAfterSeconds} seconds`}.`,
    expiredHeading: "Cart expired",
    expiredDineIn:
      "This cart timed out. Return to the menu and add an item; your table continues with a new cart.",
    expiredOther: "This cart can’t accept more items. Ask staff for help continuing your order.",
    abandoned: ["Cart closed", "This cart was abandoned and can’t be changed."] as const,
    commandFailed: [
      "Outcome not confirmed",
      "The connection dropped before we could confirm your change.",
    ] as const,
    unavailable: [
      "We couldn’t load your cart",
      "Nothing was changed. Try loading it again.",
    ] as const,
    notEnoughLeftHeading: "Not enough left",
    retrySameOperation: "Retry the same operation",
    refreshCart: "Refresh cart",
  }),
  offline: Object.freeze({
    reconnectToLoad: "Reconnect to load your cart.",
    refreshAfterReconnecting: "Refresh after reconnecting",
    paused: "You’re offline. Changes and checkout are paused; nothing will replay on reconnect.",
  }),
  featureDisabled: Object.freeze({
    heading: "Ordering is paused",
    body: "Cart ordering isn’t enabled at this location right now.",
  }),
  closed: Object.freeze({
    expiredHeading: "Cart expired",
    closedHeading: "Cart closed",
    body: "This cart can’t accept more items. Your previously paid orders remain unchanged.",
    anyoneCanRestart:
      "Anyone at your table can start an empty cart to keep ordering. Items that weren’t ordered aren’t copied.",
    starterCanRestart:
      "The person who started the table can start an empty cart to continue ordering. Previous items won’t be copied.",
    startEmptyCart: "Start an empty cart",
    askStaff: "Ask staff for help continuing your order.",
  }),
  stale: "Your cart may be out of date. Refresh before making a change.",
  quoteExpired: "Prices have expired. Checkout will price your order again.",
});
// --- end cart page ---

// --- checkout page (checkout/CheckoutPage.tsx, checkout/CheckoutDetailsForm.tsx) ---
/** Checkout review page and the details form inside it. */
export const checkoutText = Object.freeze({
  pageTitle: "Checkout",
  progressLabel: "Checkout progress",
  progressReview: "1 Review",
  progressPay: "2 Pay",
  progressDone: "3 Done",
  loadingHeading: "Loading checkout",
  emptyCartBody: "Add something from the menu before checking out.",
  orderHeading: "Your order",
  editCart: "Edit cart",
  calculatingTotal: "Calculating your total…",
  tip: "Tip",
  pricesExpired: "These prices expired. Refresh to price your order again.",
  refreshPrices: "Refresh prices",
  priceChanged: "Price changed. Confirm the new total before continuing.",
  confirmChangedPrice: "I confirm the changed price",
  pricesNeedRefreshHeading: "Prices need a refresh",
  previousPricesExpired: "Your previous prices expired. Refresh to price your order again.",
  cartChanged: "Your cart changed. Refresh to price the current cart.",
  cartValidation:
    "Something in your cart can’t be ordered as selected. Review your cart, then refresh.",
  pricingUnavailable: "We couldn’t price your order just now. Try again in a moment.",
  attentionHeading: "Checkout needs attention",
  offline: "You’re offline. Reconnect to continue; nothing will be submitted automatically.",
  pricingOutcomeUnknown:
    "We couldn’t confirm your prices. Retry to continue without creating a second order.",
  sessionEnded: "Your session ended. Scan the location QR code again to continue.",
  retryPricing: "Retry pricing",
  tipAmountLabel: "Tip amount",
  noTip: "No tip",
  tipPercent: (percent: number) => `${percent}%`,
  tipOther: "Other",
  tipCustomLabel: (symbol: string) => `Tip (${symbol})`,
  tipInvalid: "Enter a valid amount with up to two decimal places.",
  tipHelp: "Enter an amount in dollars. Your tip is fixed when you continue to payment.",
  paymentLabel: "Payment",
  savingYourDetails: "Saving your details…",
  preparingPayment: "Preparing secure payment…",
  changeYourCart: "Change your cart",
  storeClosed:
    "The store isn’t taking orders right now, so you haven’t been charged. Try again when the store reopens, or ask staff.",
  checkoutUnconfirmed: "We couldn’t confirm checkout. Retry to recover the same checkout.",
  checkoutRefused:
    "We couldn’t continue this checkout. Review your cart and scan the QR code again if needed.",
  retryCheckout: "Retry checkout",
  continueToPayment: "Continue to payment",
  continueToPaymentWithTotal: (total: string) => `Continue to payment · ${total}`,
  continueNote: "You’ll enter your card on the next step. Nothing is charged until you confirm.",
  // Details form (checkout/CheckoutDetailsForm.tsx)
  detailsLabel: "Checkout details",
  detailsLoading: "Loading checkout details…",
  detailsLoadFailed: "We couldn’t load your checkout details. Refresh your checkout to try again.",
  reloadDetails: "Reload checkout details",
  detailsHeadingPickup: "Your details",
  receipt: "Receipt",
  pickupContactLegend: "Pickup contact",
  pickupContactPurpose:
    "The store uses this only to contact you about this order, for example if an item sold out. It’s deleted 30 days after your order, and you can remove it sooner from your order page.",
  pickupName: "Pickup name",
  contactMethod: "Contact method",
  contactMethodPhone: "Phone",
  contactMethodEmail: "Email",
  mobileNumber: "Mobile number",
  pickupEmail: "Pickup email",
  dineInNoContact: "No contact details are required for your dine-in order.",
  receiptOnOrderPage: "Your receipt appears on your order page, where you can print or save it.",
  agreePolicies: "I’ve read and agree to the policies above",
  detailsExpired:
    "Checkout information expired. Get a current quote and reload details before saving.",
  savingDetails: "Saving checkout details…",
  detailsSaved: "Checkout details saved.",
  detailsInvalid:
    "Check your contact and receipt fields. Enter a mobile number such as 416 555 0123, or include the country code for numbers outside North America.",
  detailsCheckoutChanged: "Your checkout changed. Reload details before trying again.",
  detailsSaveUnconfirmed:
    "We couldn’t confirm your details were saved. Retry saving before changing them.",
  retrySavingDetails: "Retry saving details",
  saveDetails: "Save details",
});
// --- end checkout page ---

// --- order status page (order-status/OrderStatusPage.tsx, order-status/ContactDetailsSection.tsx) ---
/** Order status page and its contact details section. */
export const orderStatusText = Object.freeze({
  pageEyebrow: "Order status",
  pageHeading: "Track your order",
  /** Why the store cancelled, keyed by the server's reason code. */
  cancelReason: Object.freeze({
    CustomerRequest: "The store cancelled it at your request.",
    SoldOut: "An item you ordered sold out.",
    StoreError: "The store couldn’t prepare it.",
    DuplicateOrder: "It was a duplicate of another order.",
    GuestLeft: "The table was closed after your party left, before this was made.",
  }),
  staffRefunded: "Your payment was refunded in full.",
  staffRefundPending: "Refund pending — your payment is being returned in full.",
  itemCancelled: (refund: string, amount: string) => `Cancelled · ${refund}${amount}`,
  itemRefunded: "Refunded",
  itemRefundPending: "Refund pending",
  cancelledItemsRefunded: (amount: string) =>
    `Cancelled items: ${amount} refunded to your original payment (tax included, tip not refunded).`,
  cancelledItemsRefundPending: (amount: string) =>
    `Cancelled items: a refund of ${amount} to your original payment is pending (tax included, tip not refunded).`,
  /** The order's progress heading and sentence, per situation. */
  progress: Object.freeze({
    storeCancelledHeading: "Order cancelled by the store",
    notAcceptedHeading: "Order not accepted",
    notAcceptedRefunded:
      "The store couldn’t accept your order, so your payment was refunded to your original payment method.",
    notAcceptedRefunding:
      "The store couldn’t accept your order, so your payment is being refunded to your original payment method.",
    awaitingStoreHeading: "Waiting for the store",
    awaitingStore: "The store hasn’t confirmed your order yet. Please wait or contact the store.",
    cancelledHeading: "Order cancelled",
    unpaidPickupCancelled:
      "Payment wasn’t completed within 30 minutes, so this order was cancelled. If a payment still goes through, it will be refunded automatically.",
    collectedHeading: "Order collected",
    collected: "Your order has been collected. Enjoy!",
    notCollectedHeading: "Not collected",
    notCollected:
      "The store closed this pickup after the pickup time ended. Contact the store about your order or a refund.",
    cancelled: "Your order has been cancelled.",
    rejected: "Your order wasn’t accepted.",
    remakingPickupHeading: "Remaking part of your order",
    remakingPickup:
      "We’re remaking part of your order. We’ll have it ready shortly — please wait before collecting it.",
    remakingDineInHeading: "Remaking an item",
    remakingDineIn: "We’re remaking an item for you. It will be brought to your table shortly.",
    servedHeading: "Items served",
    served: "All listed items have been served.",
    completeHeading: "Order complete",
    complete: "Your order is complete. Thank you for visiting!",
    awaitingPaymentHeading: "Waiting for payment",
    awaitingPaymentSomeServed:
      "Everything paid for has been served. The kitchen starts the next round once it’s paid.",
    awaitingPayment: "The kitchen starts your order once it’s paid.",
    servingHeading: "Serving your order",
    serving: "Some items have been served. Check the remaining items below.",
    readyPickupHeading: "Ready for pickup",
    readyPickup: "Your order is ready. Collect it at the counter.",
    readyDineInHeading: "Your order is ready",
    readyDineIn: "Your food is ready and will be brought to your table shortly.",
    preparingHeading: "Preparing your order",
    preparing: "The kitchen is preparing your order.",
    acceptedHeading: "Order accepted",
    acceptedPickup: "The store has your order and will start preparing it soon.",
    acceptedDineIn: "The kitchen has your order and will start preparing it soon.",
    submittedHeading: "Order submitted",
    submitted: "We have your order. The store will confirm it shortly.",
  }),
  /** The payment row of the order summary. */
  payment: Object.freeze({
    refunded: (amount: string) => `Refunded ${amount}`,
    refundPending: (amount: string) => `Refund pending · ${amount}`,
    received: (amount: string) => `Payment received ${amount}`,
    notPaid: "Not paid",
    attemptFailed: "Payment attempt failed",
    pending: "Payment pending",
  }),
  /** The kitchen status row of the order summary and each round's kitchen line. */
  kitchen: Object.freeze({
    cancelled: "Cancelled",
    remaking: "Remaking an item",
    ready: "Ready",
    preparing: "Preparing",
    notStarted: "Not started yet",
    inQueue: "In the queue",
    awaitingPayment: "Waiting for payment",
    done: "Done",
  }),
  orderEyebrow: (orderNumber: string) => `Order ${orderNumber}`,
  orderTypeLabel: "Order type",
  orderTypeDineIn: "Dine in",
  orderTypePickup: "Pickup",
  kitchenStatusLabel: "Kitchen status",
  paymentLabel: "Payment",
  paymentDelayedHeading: "Payment update may be delayed",
  paymentDelayed: "This payment update may be out of date. Refresh to check again.",
  statusDelayedHeading: "Status may be delayed",
  statusRebuilding: "We’re updating your order status. Check again shortly.",
  statusFailed: "We couldn’t update your order status. The details below may be out of date.",
  statusStale: "The details below may be out of date. Refresh to check for an update.",
  itemsHeading: "Your items",
  roundHeading: (round: number) => `Round ${round}`,
  roundCancelledByStoreUnpaid: "This round was cancelled by the store. Nobody was charged for it.",
  orderCancelledByStoreUnpaid: "This order was cancelled by the store. Nobody was charged for it.",
  roundCancelledUnpaid:
    "This round was cancelled because its payment didn’t go through. You weren’t charged for it.",
  orderCancelledUnpaid:
    "This order was cancelled because its payment didn’t go through. You weren’t charged for it.",
  roundPaymentFailed: "Payment for this round didn’t go through. ",
  orderPaymentFailed: "Payment for your order didn’t go through. ",
  cancelsAt: (time: string) =>
    `It will be cancelled at ${time} Ask a staff member if you need help.`,
  roundCancelledByStore: "This round was cancelled by the store. ",
  orderCancelledByStore: "Cancelled by the store. ",
  roundAwaitingPayment: "Waiting for payment",
  roundServed: "Served",
  roundPartlyServed: "Partly served",
  itemCancelledLabel: "Cancelled",
  itemNotPaid: "Not paid",
  itemBeingRemade: "Being remade",
  itemServedOf: (served: number | undefined, quantity: number) =>
    `Served ${served ?? ""} of ${quantity}`,
  discountsAndFees: "Discounts and fees",
  totalIncludingTax: "Total including tax",
  totalIncludingTaxAndTip: "Total including tax and tip",
  unpaidRoundsExcluded: "Rounds that weren’t paid aren’t included.",
  /** The visit on this browser has ended. */
  visitEnded: Object.freeze({
    heading: "Your visit on this phone has ended",
    atTable:
      "At a table: your table visit ended or expired. Scan the table QR code again and ask a staff member for the table code to continue. While your table is still open, your earlier orders are on your table page.",
    pickup:
      "For a pickup order: the store still has your order. Give your name or order number at the counter.",
    start: "Go to the start",
  }),
  loadingHeading: "Loading order status",
  receivedHeading: "Order received",
  received: (orderNumber: string) =>
    `Order ${orderNumber} is in. Its progress will show here in a few seconds — this page updates by itself.`,
  receivedNoChange: "If nothing changes after a minute, give your order number to a staff member.",
  invalidHeading: "Order link is invalid",
  invalid: "Use the exact link provided after checkout.",
  notFoundHeading: "We can’t show this order here yet",
  notFoundJustPaid:
    "If you just paid, your order can take a few seconds to appear. Try again in a moment.",
  notFoundThisPhone:
    "This page only opens orders placed on this phone or browser. If it still doesn’t open, ask a staff member with your order number.",
  disabledHeading: "Order tracking is disabled",
  unavailableHeading: "Order status isn’t available",
  unavailable: "We couldn’t load your order status. Please try again.",
  tryLoadingStatus: "Try loading status",
  offlineShowingLast: "Showing the last status loaded on this page.",
  offlineConnect: "Connect to the internet to load your order status.",
  offlineReconnect: "Reconnect and refresh to check again.",
  updatesLabel: "Updates",
  liveUpdatesOn: "Live updates are on.",
  orderComplete: "This order is complete.",
  checksEveryFewSeconds: "This page checks for updates every few seconds.",
  refreshing: "Refreshing…",
  refreshNow: "Refresh now",
  seeTableOrders: "See everything your table ordered",
  viewReceipt: "View receipt and support",
  backToMenu: "Back to menu",
  /** The guest's own contact details section. */
  contact: Object.freeze({
    /** What this page's removal request found, keyed by the server's result code. */
    outcome: Object.freeze({
      Removed: "Your contact details have been removed from this order.",
      AlreadyRemoved:
        "Your contact details had already been removed from this order. There is nothing more to remove.",
      NotGiven: "There were no contact details on this order.",
    }),
    visitEnded:
      "Your visit on this phone has ended, so this can’t be changed here. Ask a staff member to remove your contact details.",
    removalFailed:
      "Your contact details couldn’t be removed right now. Check your connection and try again.",
    defaultStoreName: "The store",
    heading: "Your contact details",
    storeKeeps: (store: string) =>
      `${store} keeps the phone number or email you gave only to contact you about this order, and deletes it 30 days after your order.`,
    remove: "Remove my contact details",
    confirmLabel: "Confirm removal",
    confirm:
      "Remove them now? The store won’t be able to call or email you about this order. You can still collect it by showing your order number.",
    removing: "Removing…",
    removeNow: "Remove now",
    keep: "Keep them",
    removed: "Your contact details have been removed from this order.",
  }),
});
// --- end order status page ---
