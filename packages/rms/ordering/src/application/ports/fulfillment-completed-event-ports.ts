import type { ConsumerTransaction } from "@bop/eventing";
import type { FulfillmentCompletedEnvelope } from "../../contracts/fulfillment-completed-event.js";
import type { OrderingInstant, OrderingReference } from "../../domain/cart.js";
import type { OrderStatusProjection } from "../../domain/order-status-projection.js";

export interface FulfillmentCompletedEventConsumerPorts {
  readonly authorization: {
    authorize(
      transaction: ConsumerTransaction,
      envelope: FulfillmentCompletedEnvelope,
    ): Promise<boolean>;
  };
  readonly completions: {
    /** Commit or recover authoritative owner history with Workflow and Audit in this transaction. */
    commit(
      transaction: ConsumerTransaction,
      envelope: FulfillmentCompletedEnvelope,
    ): Promise<unknown>;
  };
  readonly projections: {
    load(input: {
      readonly orderReference: OrderingReference;
      readonly transaction: ConsumerTransaction;
    }): Promise<OrderStatusProjection | null>;
    replace(input: {
      readonly projection: OrderStatusProjection;
      readonly envelope: FulfillmentCompletedEnvelope;
      readonly transaction: ConsumerTransaction;
    }): Promise<OrderStatusProjection>;
  };
  readonly references: { generateGeneration(): OrderingReference; now(): OrderingInstant };
  readonly digests: { sha256(canonicalValue: string): string };
}
