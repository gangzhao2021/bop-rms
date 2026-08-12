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
    readonly lineTotal: ReceiptMoneyView;
  }[];
  readonly subtotal: ReceiptMoneyView;
  readonly tax: ReceiptMoneyView;
  readonly tip: ReceiptMoneyView;
  readonly total: ReceiptMoneyView;
  readonly paymentStatus: ReceiptPaymentStatus;
  readonly refundedTotal: ReceiptMoneyView;
}

export interface ReceiptRecordView {
  readonly recordReference: string;
  readonly version: number;
  readonly kind: ReceiptRecordKind;
  readonly recordedAt: string;
  readonly reasonCode: string | null;
  readonly snapshot: ReceiptSnapshotView;
}

export interface ReceiptView {
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
