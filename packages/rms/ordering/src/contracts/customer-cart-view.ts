export interface CustomerCartMoney {
  readonly amountMinor: string;
  readonly currency: string;
}

export interface CustomerCartView {
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
    readonly items: readonly {
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
        | { readonly status: "Available"; readonly total: CustomerCartMoney }
        | { readonly status: "Unavailable"; readonly reasonCode: string };
      readonly warnings: readonly string[];
    }[];
    readonly quote: null | {
      readonly quoteReference: string;
      readonly quoteVersion: number;
      readonly cartVersion: number;
      readonly subtotal: CustomerCartMoney;
      readonly discount: CustomerCartMoney;
      readonly tax: CustomerCartMoney;
      readonly fee: CustomerCartMoney;
      readonly total: CustomerCartMoney;
      readonly expiresAt: string;
      readonly warnings: readonly string[];
      readonly blockingReasons: readonly string[];
    };
    readonly warnings: readonly string[];
  };
}
