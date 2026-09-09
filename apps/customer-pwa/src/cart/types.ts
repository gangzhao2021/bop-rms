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
  };
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
  | "cart_expired"
  | "cart_abandoned"
  | "cart_rate_limited"
  | "cart_service_unavailable"
  | "quote_operation_expired"
  | "network_unknown";

export class CartClientError extends Error {
  readonly code: CartErrorCode;
  readonly currentVersion: number | null;
  readonly issueCodes: readonly string[];
  readonly retryAfterSeconds: number | null;

  constructor(
    code: CartErrorCode,
    details: {
      readonly currentVersion?: number;
      readonly issueCodes?: readonly string[];
      readonly retryAfterSeconds?: number;
    } = {},
  ) {
    super("The cart request could not be completed.");
    this.name = "CartClientError";
    this.code = code;
    this.currentVersion = details.currentVersion ?? null;
    this.issueCodes = Object.freeze([...(details.issueCodes ?? [])]);
    this.retryAfterSeconds = details.retryAfterSeconds ?? null;
  }
}
