export const confirmedOrderConsumerName = "kitchen.confirmed-order:v1" as const;
export const confirmedOrderConsumerVersion = 1 as const;

export type KitchenReference = string & { readonly __kitchenReference: unique symbol };
export type KitchenInstant = string & { readonly __kitchenInstant: unique symbol };
export type KitchenDigest = string & { readonly __kitchenDigest: unique symbol };

export interface ConfirmedOrderIntakeReceipt {
  readonly consumerName: typeof confirmedOrderConsumerName;
  readonly consumerVersion: typeof confirmedOrderConsumerVersion;
  readonly sourceEventReference: KitchenReference;
  readonly brandReference: KitchenReference;
  readonly storeReference: KitchenReference;
  readonly orderReference: KitchenReference;
  readonly orderBatchReference: KitchenReference;
  readonly confirmationReference: KitchenReference;
  readonly sourceAggregateVersion: bigint;
  readonly sourceSnapshotDigest: KitchenDigest;
  readonly confirmedAt: KitchenInstant;
  readonly correlationReference: KitchenReference;
  readonly semanticEventBindingDigest: KitchenDigest;
}

export type ConfirmedOrderIntakeResult =
  | {
      readonly status: "Accepted";
      readonly receipt: ConfirmedOrderIntakeReceipt;
    }
  | {
      readonly status: "AlreadyAccepted";
      readonly receipt: ConfirmedOrderIntakeReceipt;
    };

export const confirmedOrderIntakeErrorCodes = [
  "KITCHEN_CONFIRMED_ORDER_INPUT_INVALID",
  "KITCHEN_CONFIRMED_ORDER_PERMISSION_DENIED",
  "KITCHEN_CONFIRMED_ORDER_CONFLICT",
  "KITCHEN_CONFIRMED_ORDER_DEPENDENCY_UNAVAILABLE",
] as const;
export type ConfirmedOrderIntakeErrorCode = (typeof confirmedOrderIntakeErrorCodes)[number];

export class ConfirmedOrderIntakeError extends Error {
  constructor(readonly code: ConfirmedOrderIntakeErrorCode) {
    super(
      code === "KITCHEN_CONFIRMED_ORDER_INPUT_INVALID"
        ? "confirmed order intake is invalid"
        : code === "KITCHEN_CONFIRMED_ORDER_CONFLICT"
          ? "confirmed order intake conflict"
          : "confirmed order intake is unavailable",
    );
    this.name = "ConfirmedOrderIntakeError";
  }
}
