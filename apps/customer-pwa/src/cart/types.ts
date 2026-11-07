import { t } from "../i18n/i18n.js";
import { getTablePaymentTiming } from "../session/customer-transaction-context.js";
export interface CartMoney {
  readonly amountMinor: string;
  readonly currency: string;
}

export interface CartView {
  readonly schemaVersion: 1;
  readonly cart: {
    readonly cartReference: string;
    readonly version: number;
    readonly orderType: "DineIn" | "Pickup";
    readonly serviceMode: string;
    readonly context: {
      readonly brandName: string;
      readonly storeName: string;
    };
    readonly lifecycle: {
      readonly status: "Active" | "Abandoned" | "Expired";
      readonly idleExpiresAt: string;
      readonly absoluteExpiresAt: string;
    };
    readonly items: readonly CartItemView[];
    readonly quote: CartQuoteView | null;
    readonly warnings: readonly string[];
    /**
     * WP-2423 M03: the guest's own order these dishes went to, while the pickup cart is empty after
     * it, or while the cart still holds dishes that are already in it (they can't be checked out
     * again). Absent or null otherwise (always for a table).
     */
    readonly placedOrder?: CartPlacedOrder | null;
    /**
     * WP-2423 (same-table-ordering): a table cart's rounds sent in the last 15 minutes, newest
     * first, with the cart lines each took; absent when unknown.
     */
    readonly recentRounds?: readonly CartRecentRound[];
    /**
     * WP-2423 shared-table-checkout (c): dishes staff took out of this table's cart in the last
     * 15 minutes, newest first; absent when unknown.
     */
    readonly staffRemoved?: readonly CartStaffRemoval[];
  };
}

/** WP-2423 shared-table-checkout (c): a dish staff took out of the table's cart. */
export interface CartStaffRemoval {
  readonly removedAt: string;
  readonly quantity: number;
  /** The dish's menu name by locale (may be empty). */
  readonly names: Readonly<Record<string, string>>;
}

/** WP-2423 (same-table-ordering): a round sent from this table cart (no names, no payer). */
export interface CartRecentRound {
  readonly roundNumber: number;
  readonly sentAt: string;
  readonly sentByThisPhone: boolean;
  readonly cartItemReferences: readonly string[];
  /**
   * WP-2423 M38: where the round's payment stands; null from a server that does not say yet
   * (then the round is described without claiming it was paid).
   */
  readonly paymentState: CartRoundPaymentState | null;
}
/**
 * WP-2423 M38: AwaitingPayment is neither paid nor sent (pay-first: its checkout is open;
 * pay-later: its send is not confirmed yet); WaitingForStaff is a guest round held for staff.
 * Cancelled was closed by the payment window (nobody on staff touched it); StaffDeclined was
 * cancelled by staff before it was sent; StaffCancelled was cancelled by staff after it was sent.
 */
export type CartRoundPaymentState =
  | "AwaitingPayment"
  | "WaitingForStaff"
  | "Paid"
  | "PayLater"
  | "Cancelled"
  | "StaffDeclined"
  | "StaffCancelled";

/** WP-2423 M03: an order the guest already placed from this cart (its store number for display). */
export interface CartPlacedOrder {
  readonly orderReference: string;
  readonly orderNumber: string;
  /** That order won't be made (closed unpaid or cancelled): its dishes can be ordered again. */
  readonly notMade?: boolean;
}

export interface CartItemView {
  readonly cartItemReference: string;
  readonly sellableReference: string;
  readonly displayName: string;
  readonly quantity: number;
  readonly configuration: readonly {
    readonly optionReference: string;
    readonly displayName: string;
    readonly quantity: number;
  }[];
  readonly customerNote: string | null;
  readonly lineEstimate:
    | { readonly status: "Available"; readonly total: CartMoney }
    | { readonly status: "Unavailable"; readonly reasonCode: string };
  readonly warnings: readonly string[];
}

export interface CartQuoteView {
  readonly quoteReference: string;
  readonly quoteVersion: number;
  readonly cartVersion: number;
  readonly subtotal: CartMoney;
  readonly discount: CartMoney;
  readonly tax: CartMoney;
  readonly fee: CartMoney;
  readonly total: CartMoney;
  readonly expiresAt: string;
  readonly warnings: readonly string[];
  readonly blockingReasons: readonly string[];
}

export interface CartItemDraft {
  readonly quantity: number;
  readonly optionSelections: readonly {
    readonly optionReference: string;
    readonly quantity: number;
  }[];
  readonly customerNote: string | null;
}

export type CartErrorCode =
  | "cart_request_invalid"
  | "cart_session_expired"
  | "cart_not_found"
  | "cart_version_conflict"
  | "cart_idempotency_conflict"
  | "cart_selection_invalid"
  | "cart_replacement_forbidden"
  | "cart_replacement_unavailable"
  | "cart_expired"
  | "cart_abandoned"
  | "cart_rate_limited"
  /** WP-2423: the table's last order is still being processed; retry shortly. */
  | "cart_order_processing"
  /** WP-2423: another guest at the table is checking out this cart; nothing was changed. */
  | "cart_checkout_in_progress"
  /** DEC-DINE-IN-PAY-LATER: the table is checking out; staff add dishes. */
  | "cart_table_checking_out"
  /** Coordinator 2026-10-30: this phone scanned a table but hasn't joined it yet. */
  | "cart_dining_not_seated"
  /** M126 I.2: this phone's place at the table ended (left or removed, closed, changed). */
  | "cart_participant_ended"
  /** WP-2423 (guest-cart-503): a named cart line can't be sold now; remove it (never retried). */
  | "cart_item_unavailable"
  /** WP-2423 (guest-cart-503): a named cart line's dish is sold, its options no longer fit. */
  | "cart_item_options_changed"
  /** WP-2423 M03: no order of this cart whose dishes can go back (still open, or paid). */
  | "cart_restore_not_available"
  | "cart_service_unavailable"
  | "quote_operation_expired"
  | "network_unknown";

export class CartClientError extends Error {
  readonly code: CartErrorCode;
  readonly currentVersion: number | null;
  readonly issueCodes: readonly string[];
  readonly retryAfterSeconds: number | null;
  /** WP-2423 (`ITEM_SHORT`): how many of the item the store can make (0: none). */
  readonly available: number | null;
  /** WP-2423 (guest-cart-503): the guest's own cart line the answer names. */
  readonly cartItemReference: string | null;

  constructor(
    code: CartErrorCode,
    details: {
      readonly currentVersion?: number;
      readonly issueCodes?: readonly string[];
      readonly retryAfterSeconds?: number;
      readonly available?: number;
      readonly cartItemReference?: string;
    } = {},
  ) {
    super("The cart request could not be completed.");
    this.name = "CartClientError";
    this.code = code;
    this.currentVersion = details.currentVersion ?? null;
    this.issueCodes = Object.freeze([...(details.issueCodes ?? [])]);
    this.retryAfterSeconds = details.retryAfterSeconds ?? null;
    this.available = details.available ?? null;
    this.cartItemReference = details.cartItemReference ?? null;
  }
}

/**
 * WP-2423: what a guest is told while the table's last order is still being processed. A time is
 * promised only when the wait is time-bounded (the server sent how long it lasts at most).
 */
export function orderProcessingMessage(retryAfterSeconds: number | null): string {
  const base = t("Your table’s last order is still being processed.");
  if (retryAfterSeconds === null)
    return t("{base} Please try again shortly. If this keeps happening, ask a staff member.", {
      base,
    });
  if (retryAfterSeconds <= 60) return t("{base} Try again in a moment.", { base });
  const minutes = Math.ceil(retryAfterSeconds / 60);
  return t("{base} Try again in about {minutes} minute{value1}.", {
    base,
    minutes,
    value1: minutes === 1 ? "" : "s",
  });
}

/**
 * WP-2423 (DEC-DINING-ANY-PARTICIPANT-SUBMIT item 2): what a guest is told while another guest at
 * the same table is checking out this cart. Nothing was changed; they can try again after the wait.
 */
export function checkoutInProgressMessage(retryAfterSeconds: number | null): string {
  // WP-2423 item 6: at a table that pays at the end nobody is paying; someone is placing an order.
  if (getTablePaymentTiming() === "PayLater")
    return t("Someone at your table is placing an order. Try again in a moment.");
  const base = t("Another guest at your table is paying for this order.");
  if (retryAfterSeconds === null) return t("{base} Try again shortly.", { base });
  if (retryAfterSeconds <= 60) return t("{base} Try again in a moment.", { base });
  const minutes = Math.ceil(retryAfterSeconds / 60);
  return t("{base} Try again in about {minutes} minute{value1}.", {
    base,
    minutes,
    value1: minutes === 1 ? "" : "s",
  });
}
