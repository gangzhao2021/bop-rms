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
      }[];
  /** WP-2423: a pickup the Store closed as not collected after the pickup time (Pickup only). */
  readonly pickup?: null | { readonly notCollectedAt: string };
  /** WP-2423 Q12: when a pickup was cancelled because payment was not completed in time. */
  readonly unpaidCancellation?: null | { readonly cancelledAt: string };
  /** WP-2423 Q6: batches the Store cancelled after payment, before the kitchen started. */
  readonly staffCancellations?: readonly StaffCancellation[];
}

export type StaffCancellationReason =
  "CustomerRequest" | "SoldOut" | "StoreError" | "DuplicateOrder";

export interface StaffCancellation {
  readonly orderBatchReference: string;
  readonly cancelledAt: string;
  readonly reason: StaffCancellationReason;
  readonly refundStatus: "Pending" | "Refunded";
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

export type OrderStatusState =
  | { readonly status: "loading" }
  | { readonly status: "invalid-reference" }
  | { readonly status: "permission-denied" }
  | { readonly status: "not-found" }
  | { readonly status: "feature-disabled" }
  | { readonly status: "unavailable" }
  | { readonly status: "offline"; readonly view: OrderStatusView | null }
  | {
      readonly status: "ready";
      readonly view: OrderStatusView;
      readonly realtime: RealtimeAvailability;
      readonly refreshing: boolean;
    };
