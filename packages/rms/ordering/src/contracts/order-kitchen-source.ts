import type { OrderingHash, OrderingInstant, OrderingReference } from "../domain/cart.js";

export interface ConfirmedOrderKitchenSourceOption {
  readonly optionReference: OrderingReference;
  readonly quantity: number;
  readonly localizedNames: Readonly<Record<string, string>>;
}

export interface ConfirmedOrderKitchenSourceItem {
  readonly orderItemReference: OrderingReference;
  readonly orderBatchReference: OrderingReference;
  readonly ordinal: number;
  readonly quantity: number;
  readonly productReference: OrderingReference;
  readonly productVersionReference: OrderingReference;
  readonly skuReference: OrderingReference;
  readonly menuVersionReference: OrderingReference;
  readonly localizedDisplayNames: Readonly<Record<string, string>>;
  readonly selectedOptions: readonly ConfirmedOrderKitchenSourceOption[];
  readonly customerNote: string | null;
  readonly lineDigest: OrderingHash;
}

export interface ConfirmedOrderKitchenSourceEvidence {
  readonly evidenceReference: OrderingReference;
  readonly brandReference: OrderingReference;
  readonly storeReference: OrderingReference;
  readonly orderReference: OrderingReference;
  readonly orderBatchReference: OrderingReference;
  readonly confirmationReference: OrderingReference;
  readonly sourceEventReference: OrderingReference;
  readonly sourceAggregateVersion: bigint;
  readonly sourceSnapshotDigest: OrderingHash;
  readonly capturedAt: OrderingInstant;
  readonly evidenceVersion: number;
  readonly items: readonly ConfirmedOrderKitchenSourceItem[];
  readonly evidenceDigest: OrderingHash;
}

export interface ResolveConfirmedOrderKitchenSourceInput {
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

export interface OrderKitchenSourceQueryPorts {
  readonly authorization: {
    authorize(input: {
      readonly action: "ResolveConfirmedOrderKitchenSource";
      readonly purpose: "CreateKitchenWork";
      readonly brandReference: OrderingReference;
      readonly storeReference: OrderingReference;
      readonly orderReference: OrderingReference;
      readonly orderBatchReference: OrderingReference;
      readonly confirmationReference: OrderingReference;
      readonly sourceEventReference: OrderingReference;
      readonly sourceAggregateVersion: bigint;
      readonly sourceSnapshotDigest: OrderingHash;
      readonly observedAt: OrderingInstant;
    }): Promise<boolean>;
  };
  readonly source: {
    loadExact(input: ResolveConfirmedOrderKitchenSourceInput): Promise<unknown | null>;
  };
  readonly digests: {
    sha256(canonicalValue: string): string;
  };
}

export const orderKitchenSourceErrorCodes = [
  "ORDER_KITCHEN_SOURCE_INPUT_INVALID",
  "ORDER_KITCHEN_SOURCE_PERMISSION_DENIED",
  "ORDER_KITCHEN_SOURCE_CONFLICT",
  "ORDER_KITCHEN_SOURCE_DEPENDENCY_UNAVAILABLE",
] as const;

export type OrderKitchenSourceErrorCode = (typeof orderKitchenSourceErrorCodes)[number];

export class OrderKitchenSourceError extends Error {
  constructor(readonly code: OrderKitchenSourceErrorCode) {
    super("order kitchen source is unavailable");
    this.name = "OrderKitchenSourceError";
  }
}
