export * from "../domain/order-status-projection.js";

import type {
  OrderStatusBatchSummary,
  OrderStatusFreshness,
} from "../domain/order-status-projection.js";
import type { OrderingInstant, OrderingReference } from "../domain/cart.js";

export interface CustomerOrderStatusView {
  readonly projectionName: "ordering_order_status_v1";
  readonly projectionVersion: 1;
  readonly sourceCheckpoint: OrderingReference;
  readonly projectedAt: OrderingInstant;
  readonly freshnessStatus: OrderStatusFreshness;
  readonly order: {
    readonly orderReference: OrderingReference;
    readonly orderNumber: string;
    readonly orderType: "DineIn" | "Pickup";
    readonly canonicalPhase: "Submitted";
    readonly paymentStatus: "NotReported";
    readonly kitchenStatus: "Unavailable";
    readonly fulfillmentStatus: "Unavailable";
    readonly eta: null;
    readonly submittedAt: OrderingInstant;
    readonly batches: readonly OrderStatusBatchSummary[];
  };
}

export interface MerchantOrderStatusView extends CustomerOrderStatusView {
  readonly order: CustomerOrderStatusView["order"] & {
    readonly brandReference: OrderingReference;
    readonly storeReference: OrderingReference;
    readonly sourceChannel: "Api" | "Pos" | "Qr" | "Web";
    readonly closureStatus: "Open";
  };
}

export interface MerchantOrderStatusQuery {
  readonly brandReference: OrderingReference;
  readonly storeReference: OrderingReference;
  readonly observedAt: OrderingInstant;
  readonly exactReferenceOrNumber: OrderingReference | string | null;
  readonly orderType: "DineIn" | "Pickup" | null;
  readonly sourceChannel: "Api" | "Pos" | "Qr" | "Web" | null;
  readonly canonicalPhase: "Submitted" | null;
  readonly closureStatus: "Open" | null;
  readonly paymentStatus: "NotReported" | null;
  readonly limit: number;
}
