import type { ConsumerTransaction } from "@bop/eventing";

import type { OrderCreatedEnvelope } from "../../contracts/order-created-event.js";
import type { OrderingInstant, OrderingReference } from "../../domain/cart.js";
import type {
  OrderStatusProjection,
  OrderStatusSourceSnapshot,
} from "../../domain/order-status-projection.js";

export interface OrderCreatedEventConsumerPorts {
  readonly authorization: {
    authorize(transaction: ConsumerTransaction, envelope: OrderCreatedEnvelope): Promise<boolean>;
  };
  readonly source: {
    freshness(
      transaction: ConsumerTransaction,
      snapshot: OrderStatusSourceSnapshot,
    ): Promise<"Fresh" | "Stale">;
    loadExact(input: {
      readonly transaction: ConsumerTransaction;
      readonly envelope: OrderCreatedEnvelope;
      readonly brandReference: OrderingReference;
      readonly storeReference: OrderingReference;
      readonly orderReference: OrderingReference;
      readonly sourceVersion: number;
      readonly sourceCheckpoint: OrderingReference;
      readonly sourceDigest: string;
    }): Promise<unknown | null>;
  };
  readonly projections: {
    load(input: {
      readonly orderReference: OrderingReference;
      readonly transaction: ConsumerTransaction;
    }): Promise<OrderStatusProjection | null>;
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
