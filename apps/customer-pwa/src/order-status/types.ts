export type OrderStatusFreshness = "Fresh" | "Stale" | "Rebuilding" | "Failed";

export interface OrderStatusView {
  readonly projectionName: "ordering_order_status_v1";
  readonly projectionVersion: 1;
  readonly sourceCheckpoint: string;
  readonly projectedAt: string;
  readonly freshnessStatus: OrderStatusFreshness;
  readonly order: {
    readonly orderReference: string;
    readonly orderNumber: string;
    readonly orderType: "DineIn" | "Pickup";
    readonly canonicalPhase: "Submitted" | "Fulfilled";
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
