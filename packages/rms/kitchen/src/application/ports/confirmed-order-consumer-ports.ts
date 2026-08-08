import type { ConsumerTransaction } from "@bop/eventing";

import type {
  ConfirmedOrderIntakeReceipt,
  KitchenInstant,
  KitchenReference,
} from "../../contracts/confirmed-order-intake.js";

export type ConfirmedOrderIntakeResolution =
  | { readonly status: "NotFound" }
  | { readonly status: "Resolved"; readonly receipt: unknown }
  | { readonly status: "Conflict" };

export type ConfirmedOrderIntakeCommit =
  | { readonly status: "Created"; readonly receipt: unknown }
  | { readonly status: "AlreadyAccepted"; readonly receipt: unknown }
  | { readonly status: "Conflict" };

export interface ConfirmedOrderConsumerPorts {
  readonly authorization: {
    authorize(input: {
      readonly action: "ConsumeConfirmedOrder";
      readonly purpose: "CreateKitchenIntake";
      readonly brandReference: KitchenReference;
      readonly storeReference: KitchenReference;
      readonly orderReference: KitchenReference;
      readonly orderBatchReference: KitchenReference;
      readonly confirmationReference: KitchenReference;
      readonly sourceEventReference: KitchenReference;
      readonly observedAt: KitchenInstant;
    }): Promise<boolean>;
  };
  readonly intakes: {
    resolveByIdentity(input: {
      readonly brandReference: KitchenReference;
      readonly storeReference: KitchenReference;
      readonly sourceEventReference: KitchenReference;
      readonly confirmationReference: KitchenReference;
      readonly orderBatchReference: KitchenReference;
      readonly transaction: ConsumerTransaction;
    }): Promise<ConfirmedOrderIntakeResolution>;
    accept(input: {
      readonly receipt: ConfirmedOrderIntakeReceipt;
      readonly transaction: ConsumerTransaction;
    }): Promise<ConfirmedOrderIntakeCommit>;
  };
  readonly digests: {
    sha256(canonicalValue: string): string;
  };
}
