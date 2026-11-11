import type { CheckoutRefusedLine } from "./session-client.js";
import type { CartMoney, CartPlacedOrder, CartView } from "../cart/types.js";

export interface CheckoutQuote {
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
  readonly priceChange: null | {
    readonly outcome: string;
    readonly totalChange: CartMoney;
    readonly requiresReconfirmation: boolean;
    readonly evaluatedAt: string;
  };
  /**
   * WP-2423 item 8 ⑦ (Owner decision 11): the tips the Store offers, as percentages of the
   * subtotal before tax, or tips off. Absent from an older server: 10 / 15 / 18 %.
   */
  readonly tips?: { readonly enabled: boolean; readonly tierPercents: readonly number[] };
  /**
   * WP-2423 M74: each cart line's price before tax with its options, for the quoted quantity.
   * Absent from an older server.
   */
  readonly lines?: readonly {
    readonly cartItemReference: string;
    readonly quantity: number;
    readonly subtotal: CartMoney;
  }[];
  /**
   * WP-2423 price-hold-dish-changes (DEC-PRICE-HOLD §3): each line as this cart was first priced
   * for it (on any phone, before any reload), when that was another quote, and what the
   * restaurant changed about the dish since. Absent from an older server.
   */
  readonly sinceAdded?: readonly {
    readonly cartItemReference: string;
    readonly quantity: number;
    readonly subtotal: CartMoney;
    readonly changes: readonly ("Name" | "Allergens")[];
  }[];
}

export type CheckoutState =
  | Readonly<{ status: "loading" }>
  /** WP-2423 M03: `placedOrder` names the guest's order when the cart is empty after it. */
  | Readonly<{ status: "empty"; placedOrder?: CartPlacedOrder | null }>
  | Readonly<{ status: "ready"; cart: CartView; quote: CheckoutQuote | null }>
  | Readonly<{ status: "pending"; cart: CartView }>
  | Readonly<{
      status:
        | "offline"
        | "session-expired"
        | "conflict"
        | "validation"
        | "unavailable"
        | "quote-expired"
        | "outcome-unknown"
        /** WP-2423 item 6: staff started the table's checkout; no more rounds from a phone. */
        | "table-checking-out"
        /** M126 I.2: this phone's place at the table ended (why: getParticipationEnded). */
        | "participation-ended";
      cart: CartView | null;
      canRetry: boolean;
    }>
  | Readonly<{
      /**
       * WP-2423 (guest-cart-503): the Store can't sell one named line now; nothing was charged or
       * sent. Final until the guest removes it (never retried).
       */
      status: "item-unavailable";
      cart: CartView;
      refusal: "item_unavailable" | "item_options_changed";
      line: CheckoutRefusedLine | null;
      canRetry: false;
    }>
  | Readonly<{
      /**
       * WP-2423: pricing was refused and nothing changed — the table's last order is still being
       * processed, or another guest at the table is checking out this cart. Retry after the wait.
       */
      status: "order-processing" | "checkout-in-progress";
      cart: CartView;
      retryAfterSeconds: number | null;
      canRetry: boolean;
    }>;
