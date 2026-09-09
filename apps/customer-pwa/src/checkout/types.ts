import type { CartMoney, CartView } from "../cart/types.js";

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
}

export type CheckoutState =
  | Readonly<{ status: "loading" }>
  | Readonly<{ status: "empty" }>
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
        | "outcome-unknown";
      cart: CartView | null;
      canRetry: boolean;
    }>;
