import type { GuestSession } from "@bop/identity";
import type { OrderingInstant, OrderingReference } from "../../domain/cart.js";
import type {
  OrderStatusCanonicalPhase,
  OrderStatusProjection,
} from "../../domain/order-status-projection.js";

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
  /**
   * WP-2423 / DEC-PILOT-BATCH-PHASE-01: Ordering's merged current phase for an Order (own records
   * plus consumed Kitchen facts), read in the caller's transaction. Absent: the snapshot phase.
   */
  readonly phases?: {
    load(
      orderReference: OrderingReference,
    ): Promise<{ readonly canonicalPhase: OrderStatusCanonicalPhase } | null>;
  };
  readonly authorization: {
    authorizeCustomer(input: {
      orderReference: OrderingReference;
      observedAt: OrderingInstant;
    }): Promise<{ guestSession: GuestSession } | null>;
    /**
     * WP-2423 Q8: a current participant of the dine-in session this Order belongs to (any guest at
     * the table, not only the one who started the Order). The adapter proves the Order is the
     * guest's own dining session's Order; absent means the read is refused.
     */
    authorizeDiningParticipant?(input: {
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
      canonicalPhase:
        | "Submitted"
        | "Accepted"
        | "In Progress"
        | "Ready"
        | "Fulfilled"
        | "Rejected"
        | "Cancelled"
        | null;
      closureStatus: "Open" | null;
      paymentStatus: "NotReported" | null;
      limit: number;
    }): Promise<readonly OrderStatusProjection[]>;
  };
}
