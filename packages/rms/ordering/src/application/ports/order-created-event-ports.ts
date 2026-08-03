import type { ConsumerTransaction } from "@bop/eventing";

import type { OrderCreatedEnvelope } from "../../contracts/order-created-event.js";
import type { OrderingInstant, OrderingReference } from "../../domain/cart.js";
import type { OrderStatusProjection } from "../../domain/order-status-projection.js";

export interface OrderCreatedEventConsumerPorts {
  readonly source: {
    loadExact(input: {
      readonly brandReference: OrderingReference;
      readonly storeReference: OrderingReference;
      readonly orderReference: OrderingReference;
      readonly sourceVersion: number;
      readonly sourceCheckpoint: OrderingReference;
      readonly sourceDigest: string;
    }): Promise<unknown | null>;
  };
  readonly projections: {
    load(orderReference: OrderingReference): Promise<OrderStatusProjection | null>;
    replace(input: {
      readonly projection: OrderStatusProjection;
      readonly envelope: OrderCreatedEnvelope;
      readonly transaction: ConsumerTransaction;
    }): Promise<OrderStatusProjection>;
  };
  readonly references: {
    generateGeneration(): string;
    now(): OrderingInstant;
  };
}
