import type { OrderingHash, OrderingInstant, OrderingReference } from "../domain/cart.js";

export interface ConfirmedOrderFulfillmentSourceItem {
  readonly orderItemReference: OrderingReference;
  readonly ordinal: number;
  readonly quantity: number;
  readonly lineDigest: OrderingHash;
}

export interface ConfirmedOrderFulfillmentSourceEvidence {
  readonly evidenceReference: OrderingReference;
  readonly brandReference: OrderingReference;
  readonly storeReference: OrderingReference;
  readonly orderReference: OrderingReference;
  readonly orderBatchReference: OrderingReference;
  readonly confirmationReference: OrderingReference;
  readonly sourceEventReference: OrderingReference;
  readonly sourceAggregateVersion: bigint;
  readonly sourceSnapshotDigest: OrderingHash;
  readonly orderType: "DineIn" | "Pickup";
  readonly capturedAt: OrderingInstant;
  readonly evidenceVersion: 1;
  readonly items: readonly ConfirmedOrderFulfillmentSourceItem[];
  readonly evidenceDigest: OrderingHash;
}

export interface ResolveConfirmedOrderFulfillmentSourceInput {
  readonly brandReference: OrderingReference;
  readonly storeReference: OrderingReference;
  readonly orderReference: OrderingReference;
  readonly orderBatchReference: OrderingReference;
  readonly confirmationReference: OrderingReference;
  readonly sourceEventReference: OrderingReference;
  readonly sourceAggregateVersion: bigint;
  readonly sourceSnapshotDigest: OrderingHash;
  readonly observedAt: OrderingInstant;
}

export interface OrderFulfillmentSourceQueryPorts {
  readonly authorization: {
    authorize(
      input: ResolveConfirmedOrderFulfillmentSourceInput & {
        readonly action: "ResolveConfirmedOrderFulfillmentSource";
        readonly purpose: "CreatePickupFulfillment";
      },
    ): Promise<boolean>;
  };
  readonly source: {
    loadExact(input: ResolveConfirmedOrderFulfillmentSourceInput): Promise<unknown | null>;
  };
  readonly digests: {
    sha256(canonicalValue: string): string;
  };
}

export const orderFulfillmentSourceErrorCodes = [
  "ORDER_FULFILLMENT_SOURCE_INPUT_INVALID",
  "ORDER_FULFILLMENT_SOURCE_PERMISSION_DENIED",
  "ORDER_FULFILLMENT_SOURCE_CONFLICT",
  "ORDER_FULFILLMENT_SOURCE_DEPENDENCY_UNAVAILABLE",
] as const;

export type OrderFulfillmentSourceErrorCode = (typeof orderFulfillmentSourceErrorCodes)[number];

export class OrderFulfillmentSourceError extends Error {
  constructor(readonly code: OrderFulfillmentSourceErrorCode) {
    super("order fulfillment source is unavailable");
    this.name = "OrderFulfillmentSourceError";
  }
}
