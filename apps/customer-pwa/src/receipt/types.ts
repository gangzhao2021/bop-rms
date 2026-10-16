import type { StoreContactView } from "../journey/StoreContact.js";

export type ReceiptPaymentStatus = "Paid" | "RefundPending" | "PartiallyRefunded" | "Refunded";
export type ReceiptRecordKind = "Original" | "Correction" | "Void" | "Refund" | "Reissue";

export interface ReceiptMoneyView {
  readonly amountMinor: bigint;
  readonly currencyCode: string;
}

export interface ReceiptSnapshotView {
  readonly receiptReference: string;
  readonly operatingEntityDisplayName: string;
  readonly storeDisplayName: string;
  readonly orderNumber: string;
  readonly issuedAt: string;
  readonly locale: string;
  readonly lines: readonly {
    readonly lineReference: string;
    readonly displayName: string;
    readonly quantity: number;
    /** The item's frozen total after tax and fees; printed only on versions without `lineSubtotal`. */
    readonly lineTotal: ReceiptMoneyView;
    /** WP-2423 D5: the item's price before tax (absent on versions issued before it was frozen). */
    readonly lineSubtotal?: ReceiptMoneyView;
    /**
     * WP-2423: the options chosen for the item, each with what it added for the whole line; the
     * item's `lineSubtotal` already includes them. Absent on versions issued before they were
     * recorded, which print as issued.
     */
    readonly options?: readonly {
      readonly displayName: string;
      readonly quantity: number;
      readonly amount: ReceiptMoneyView;
    }[];
  }[];
  readonly adjustments?: { readonly discount: ReceiptMoneyView; readonly fee: ReceiptMoneyView };
  readonly subtotal: ReceiptMoneyView;
  readonly tax: ReceiptMoneyView;
  readonly tip: ReceiptMoneyView;
  readonly total: ReceiptMoneyView;
  readonly paymentStatus: ReceiptPaymentStatus;
  readonly refundedTotal: ReceiptMoneyView;
  /** WP-2423 Q15: issuer address, registrations and one line per tax (absent on older receipts). */
  readonly taxDetails?: ReceiptTaxDetailsView;
}

export interface ReceiptTaxDetailsView {
  readonly businessAddress: {
    readonly addressLines: readonly string[];
    readonly locality: string;
    readonly regionCode: string;
    readonly postalCode: string;
    readonly countryCode: string;
  } | null;
  readonly taxRegistrations: readonly { readonly label: string; readonly number: string }[];
  readonly taxLines: readonly {
    readonly label: string;
    readonly ratePercent: string;
    readonly included: boolean;
    readonly amount: ReceiptMoneyView;
  }[];
  readonly paymentMethod: "Card";
}

export interface ReceiptRecordView {
  readonly recordReference: string;
  readonly version: number;
  readonly kind: ReceiptRecordKind;
  readonly recordedAt: string;
  readonly reasonCode: string | null;
  readonly snapshot: ReceiptSnapshotView;
}

export interface ReceiptFinancialView {
  readonly observedAt: string;
  readonly currencyCode: string;
  readonly capturedMinor: bigint;
  readonly confirmedRefundMinor: bigint;
  readonly pendingRefundMinor: bigint;
  readonly unresolvedAttemptCount: number;
}
export interface ReceiptView {
  readonly financial?: ReceiptFinancialView | null;
  /** WP-2423 Q10: the Store's published phone and address. */
  readonly storeContact?: StoreContactView;
  /** WP-2423 Q16: the Store's privacy notice (absent until its Owner enters one). */
  readonly privacyNoticeUrl?: string;
  readonly orderReference: string;
  readonly freshnessStatus: "Fresh" | "Stale";
  readonly deliveryStatus:
    "NotRequested" | "Unavailable" | "Pending" | "Sent" | "Unknown" | "Suppressed";
  readonly supportEligible: boolean;
  readonly cancellationEligible: boolean;
  readonly records: readonly ReceiptRecordView[];
}

export type ReceiptState =
  | { readonly status: "loading" }
  | { readonly status: "invalid-reference" }
  | { readonly status: "permission-denied" }
  | { readonly status: "not-found" }
  | { readonly status: "feature-disabled" }
  | { readonly status: "unavailable" }
  | { readonly status: "offline"; readonly view: ReceiptView | null }
  | { readonly status: "ready"; readonly view: ReceiptView };
