import type { AppendAuditRecordInput } from "@bop/audit";
import type { ConsumerTransaction } from "@bop/eventing";
import type {
  ConfirmedOrderFulfillmentSourceEvidence,
  ResolveConfirmedOrderFulfillmentSourceInput,
} from "@rms/ordering";

import type {
  FulfillmentDigest,
  FulfillmentInstant,
  FulfillmentReference,
  PickupFulfillmentCreationEffect,
} from "../../contracts/pickup-fulfillment.js";

export type PickupFulfillmentResolution =
  | { readonly status: "NotFound" }
  | { readonly status: "Resolved"; readonly effect: unknown }
  | { readonly status: "Conflict" };

export type PickupFulfillmentCommit =
  | { readonly status: "Created" | "AlreadyCreated"; readonly effect: unknown }
  | { readonly status: "Conflict" };

export interface PickupFulfillmentPorts {
  readonly authorization: {
    authorize(input: {
      readonly action: "ConsumeConfirmedOrder";
      readonly purpose: "CreatePickupFulfillment";
      readonly brandReference: FulfillmentReference;
      readonly storeReference: FulfillmentReference;
      readonly orderReference: FulfillmentReference;
      readonly orderBatchReference: FulfillmentReference;
      readonly confirmationReference: FulfillmentReference;
      readonly sourceEventReference: FulfillmentReference;
      readonly observedAt: FulfillmentInstant;
    }): Promise<boolean>;
  };
  readonly orderingSource: {
    resolve(
      input: ResolveConfirmedOrderFulfillmentSourceInput,
    ): Promise<ConfirmedOrderFulfillmentSourceEvidence>;
  };
  readonly references: {
    derive(
      purpose:
        | "PickupFulfillment"
        | "PickupFulfillmentItem"
        | "PickupFulfillmentOperation"
        | "PickupFulfillmentAudit",
      canonicalIdentity: string,
    ): string;
  };
  readonly digests: {
    sha256(canonicalValue: string): string;
  };
  readonly repository: {
    resolveByOrder(input: {
      readonly brandReference: FulfillmentReference;
      readonly storeReference: FulfillmentReference;
      readonly orderReference: FulfillmentReference;
      readonly transaction: ConsumerTransaction;
    }): Promise<PickupFulfillmentResolution>;
    create(input: {
      readonly effect: PickupFulfillmentCreationEffect;
      readonly transaction: ConsumerTransaction;
    }): Promise<PickupFulfillmentCommit>;
  };
  readonly audit: {
    append(input: {
      readonly record: AppendAuditRecordInput;
      readonly transaction: ConsumerTransaction;
    }): Promise<void>;
  };
  readonly effectDigests?: {
    parse(value: unknown): FulfillmentDigest;
  };
}
