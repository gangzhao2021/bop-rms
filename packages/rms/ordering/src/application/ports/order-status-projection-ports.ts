import type { GuestSession } from "@bop/identity";
import type { OrderingInstant, OrderingReference } from "../../domain/cart.js";
import type { OrderStatusProjection } from "../../domain/order-status-projection.js";

export interface OrderStatusProjectionPorts {
  readonly references: {
    generateGeneration(): string;
    now(): string;
  };
  readonly source: {
    loadExact(orderReference: OrderingReference): Promise<unknown | null>;
  };
  readonly projections: {
    load(orderReference: OrderingReference): Promise<OrderStatusProjection | null>;
    replace(projection: OrderStatusProjection): Promise<OrderStatusProjection>;
  };
}

export interface OrderStatusQueryPorts {
  readonly authorization: {
    authorizeCustomer(input: {
      orderReference: OrderingReference;
      observedAt: OrderingInstant;
    }): Promise<{ guestSession: GuestSession } | null>;
    authorizeMerchant(input: {
      brandReference: OrderingReference;
      storeReference: OrderingReference;
      purpose: "OrderStatusRead";
      observedAt: OrderingInstant;
    }): Promise<{ actorReference: OrderingReference } | null>;
  };
  readonly projections: {
    load(orderReference: OrderingReference): Promise<OrderStatusProjection | null>;
    list(input: {
      brandReference: OrderingReference;
      storeReference: OrderingReference;
      exactReferenceOrNumber: string | null;
      orderType: "DineIn" | "Pickup" | null;
      sourceChannel: "Api" | "Pos" | "Qr" | "Web" | null;
      canonicalPhase: "Submitted" | "Fulfilled" | null;
      closureStatus: "Open" | null;
      paymentStatus: "NotReported" | null;
      limit: number;
    }): Promise<readonly OrderStatusProjection[]>;
  };
}
