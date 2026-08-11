import type { ConsumerTransaction } from "@bop/eventing";
import type { FulfillmentCompletedEnvelope } from "../../contracts/fulfillment-completed-event.js";
import type { OrderingInstant, OrderingReference } from "../../domain/cart.js";
import type { OrderStatusProjection } from "../../domain/order-status-projection.js";

export interface FulfillmentCompletedEventConsumerPorts {
  readonly projections: {
    load(orderReference: OrderingReference): Promise<OrderStatusProjection | null>;
    replace(input: {
      readonly projection: OrderStatusProjection;
      readonly envelope: FulfillmentCompletedEnvelope;
      readonly transaction: ConsumerTransaction;
    }): Promise<OrderStatusProjection>;
  };
  readonly references: { generateGeneration(): OrderingReference; now(): OrderingInstant };
  readonly digests: { sha256(canonicalValue: string): string };
}
