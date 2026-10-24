import type { StoreContactView } from "../journey/StoreContact.js";

export type OrderStatusFreshness = "Fresh" | "Stale" | "Rebuilding" | "Failed";

export interface OrderStatusSources {
  readonly dining?: {
    readonly items: readonly {
      readonly orderItemReference: string;
      readonly orderBatchReference: string;
      readonly servedQuantity: number;
    }[];
  };
  readonly checkedAt: string;
  readonly kitchen: null | {
    readonly batches: readonly {
      readonly orderBatchReference: string;
      /** Cancelled only for a batch the Store cancelled before preparation (WP-2423 Q6). */
      readonly status: "Queued" | "InProgress" | "Ready" | "Cancelled";
      readonly updatedAt: string;
    }[];
  };
  readonly payments:
    | null
    | readonly {
        readonly status: "Succeeded" | "Failed";
        readonly occurredAt: string;
        readonly amount: null | { readonly amountMinor: bigint; readonly currencyCode: string };
        readonly freshnessStatus: OrderStatusFreshness;
        /**
         * WP-2423 (v15 3cd0f8dd H1): set for a round staff took payment for on the Store's card
         * machine (with that round); absent for an online payment.
         */
        readonly method?: "CardMachine";
        readonly orderBatchReference?: string;
      }[];
  /**
   * WP-2423 (v15 3cd0f8dd M3): the refunds confirmed on this order, as its latest receipt states
   * them (absent when nothing was refunded).
   */
  readonly refunds?: OrderRefunds;
  /** WP-2423: a pickup the Store closed as not collected after the pickup time (Pickup only). */
  readonly pickup?: null | { readonly notCollectedAt: string };
  /** WP-2423 Q12: when a pickup was cancelled because payment was not completed in time. */
  readonly unpaidCancellation?: null | { readonly cancelledAt: string };
  /** WP-2423 Q6: batches the Store cancelled after payment, before the kitchen started. */
  readonly staffCancellations?: readonly StaffCancellation[];
  /** WP-2423 Q6 step 2: single items the Store cancelled after payment, before the kitchen started. */
  readonly itemCancellations?: readonly ItemCancellation[];
  /** WP-2423: each dine-in round's payment; a failed one is cancelled automatically at cancelsAt. */
  readonly batchPayments?: readonly BatchPayment[];
  /** WP-2423: dine-in rounds cancelled because their payment didn't go through (never charged). */
  readonly unpaidCancellations?: readonly UnpaidBatchCancellation[];
  /** WP-2423 Q10: the Store's published phone and address. */
  readonly storeContact?: StoreContactView;
  /** WP-2423 Q16: whether this order still holds the contact the customer gave (never the value). */
  readonly contactDetails?: "Stored" | "Removed" | "NotGiven";
  /** WP-2423 Q16: the Store's privacy notice (absent until its Owner enters one). */
  readonly privacyNoticeUrl?: string;
  /**
   * WP-2423 D5: each shown item's frozen price before tax and its tax (every item or none), so
   * the page lists item prices, then the subtotal and tax, like the receipt.
   */
  readonly itemPrices?: readonly {
    readonly orderItemReference: string;
    readonly subtotal: { readonly amountMinor: bigint; readonly currencyCode: string };
    readonly tax: { readonly amountMinor: bigint; readonly currencyCode: string };
    /**
     * WP-2423: the options the guest chose, each with what it added for the whole line (zero
     * when free; `subtotal` already includes it). Absent for a plain item.
     */
    readonly options?: readonly OrderItemOptionView[];
    /** WP-2423: the guest's own note for the kitchen (pickup orders; absent when none). */
    readonly customerNote?: string;
  }[];
  /**
   * WP-2423 (v15 aa3d9fac D2): the tip of each paid round (one entry per round with a successful
   * payment), so the page's total is what was paid and matches the receipt.
   */
  readonly tips?: readonly {
    readonly orderBatchReference: string;
    readonly amount: { readonly amountMinor: bigint; readonly currencyCode: string };
  }[];
  /** WP-2423 Q26: items the kitchen is remaking (open portions per Order item). */
  readonly remakes?: readonly {
    readonly orderItemReference: string;
    readonly quantity: number;
  }[];
  /**
   * WP-2423 Q9-G1: the Store did not accept this paid pickup in time and it is refunded
   * automatically, or it is waiting for the Store after an outage (Pickup only).
   */
  readonly storeAcceptance?:
    | { readonly state: "AwaitingStore" }
    | {
        readonly state: "NotAccepted";
        readonly closedAt: string;
        readonly refundStatus: "Pending" | "Refunded";
      };
}

/** WP-2423 (v15 3cd0f8dd M3): what was refunded on the order and, where known, what for. */
export interface OrderRefunds {
  readonly refunded: { readonly amountMinor: bigint; readonly currencyCode: string };
  readonly entries: readonly {
    readonly kind: "Refund" | "ItemCancellation" | "RoundRefund" | "Other";
    readonly orderItemReferences: readonly string[];
    readonly total: { readonly amountMinor: bigint; readonly currencyCode: string };
    readonly tip: { readonly amountMinor: bigint; readonly currencyCode: string };
  }[];
}

export interface BatchPayment {
  readonly orderBatchReference: string;
  readonly status: "Succeeded" | "Failed" | "Awaiting";
  /** When a round whose payment failed is cancelled automatically (null once cancelled or paid). */
  readonly cancelsAt: string | null;
}

export interface UnpaidBatchCancellation {
  readonly orderBatchReference: string;
  readonly cancelledAt: string;
  /** The Store cancelled it before anyone paid (absent from an older server). */
  readonly byStore?: boolean;
}

export type StaffCancellationReason =
  "CustomerRequest" | "SoldOut" | "StoreError" | "DuplicateOrder" | "GuestLeft";

export interface StaffCancellation {
  readonly orderBatchReference: string;
  readonly cancelledAt: string;
  readonly reason: StaffCancellationReason;
  readonly refundStatus: "Pending" | "Refunded";
}

/** Refund is the cancelled items' price, tax and share of the tip (DEC-TIP-REFUND-PROPORTIONAL). */
export interface ItemCancellation {
  readonly orderBatchReference: string;
  readonly orderItemReferences: readonly string[];
  readonly cancelledAt: string;
  readonly reason: StaffCancellationReason;
  readonly refundStatus: "Pending" | "Refunded";
  readonly refundAmount: { readonly amountMinor: bigint; readonly currencyCode: string };
}

export interface OrderStatusView {
  readonly sources?: OrderStatusSources;
  readonly projectionName: "ordering_order_status_v1";
  readonly projectionVersion: 1;
  readonly sourceCheckpoint: string;
  readonly projectedAt: string;
  readonly freshnessStatus: OrderStatusFreshness;
  readonly order: {
    readonly orderReference: string;
    readonly orderNumber: string;
    readonly orderType: "DineIn" | "Pickup";
    readonly canonicalPhase:
      "Submitted" | "Accepted" | "In Progress" | "Ready" | "Fulfilled" | "Rejected" | "Cancelled";
    readonly paymentStatus: "NotReported";
    readonly kitchenStatus: "Unavailable";
    readonly fulfillmentStatus: "Unavailable" | "Completed";
    readonly fulfilledAt: string | null;
    readonly eta: null;
    readonly submittedAt: string;
    readonly batches: readonly {
      readonly orderBatchReference: string;
      readonly submittedAt: string;
      readonly items: readonly {
        readonly orderItemReference: string;
        readonly displayName: string;
        readonly quantity: number;
        readonly lineTotal: { readonly amountMinor: bigint; readonly currencyCode: string };
      }[];
    }[];
  };
}

export type RealtimeAvailability = "connecting" | "available" | "unavailable";

/**
 * WP-2423 (v15 2026-10-16): the guest's own order exists but its status is still being prepared
 * (normally a few seconds after paying). The page says the order was received and keeps checking.
 */
export interface OrderReceivedView {
  readonly kind: "Received";
  readonly orderReference: string;
  readonly orderNumber: string;
  readonly orderType: "DineIn" | "Pickup";
  readonly submittedAt: string;
  readonly checkedAt: string;
}

export type OrderStatusState =
  | { readonly status: "loading" }
  | { readonly status: "received"; readonly received: OrderReceivedView }
  | { readonly status: "invalid-reference" }
  | { readonly status: "permission-denied" }
  | { readonly status: "not-found" }
  /** WP-2423 (46940b76 L5): another guest at this guest's open table placed the order. */
  | { readonly status: "table-order" }
  | { readonly status: "feature-disabled" }
  | { readonly status: "unavailable" }
  | { readonly status: "offline"; readonly view: OrderStatusView | null }
  | {
      readonly status: "ready";
      readonly view: OrderStatusView;
      readonly realtime: RealtimeAvailability;
      readonly refreshing: boolean;
    };

/** WP-2423: one option chosen for an ordered item ("Whipped cream", "Extra shot × 2"). */
export interface OrderItemOptionView {
  readonly displayName: string;
  readonly quantity: number;
  readonly amount: { readonly amountMinor: bigint; readonly currencyCode: string };
}
