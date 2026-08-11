import type { AppendAuditRecordInput } from "@bop/audit";
import type { ConsumerTransaction } from "@bop/eventing";

import type {
  FulfillmentReadyEffect,
  ReadinessInstant,
  ReadinessReference,
} from "../../contracts/fulfillment-readiness.js";

export type FulfillmentReadinessResolution =
  | { readonly status: "NotFound" }
  | { readonly status: "Resolved"; readonly effect: unknown }
  | { readonly status: "Conflict" };

export type FulfillmentReadinessCommit =
  | { readonly status: "Applied" | "AlreadyApplied"; readonly effect: unknown }
  | { readonly status: "Conflict" };

export interface FulfillmentReadinessPorts {
  readonly authorization: {
    authorize(input: {
      readonly action: "ConsumeKitchenItemReady";
      readonly purpose: "RecordFulfillmentItemReady";
      readonly brandReference: ReadinessReference;
      readonly storeReference: ReadinessReference;
      readonly orderReference: ReadinessReference;
      readonly orderBatchReference: ReadinessReference;
      readonly orderItemReference: ReadinessReference;
      readonly sourceEventReference: ReadinessReference;
      readonly observedAt: ReadinessInstant;
    }): Promise<boolean>;
  };
  readonly references: {
    derive(
      purpose: "FulfillmentReadyResult" | "FulfillmentReadyOperation" | "FulfillmentReadyAudit",
      canonicalIdentity: string,
    ): string;
  };
  readonly digests: { sha256(canonicalValue: string): string };
  readonly repository: {
    resolveByKitchenReadyResult(input: {
      readonly brandReference: ReadinessReference;
      readonly storeReference: ReadinessReference;
      readonly kitchenReadyResultReference: ReadinessReference;
      readonly transaction: ConsumerTransaction;
    }): Promise<FulfillmentReadinessResolution>;
    lockByOrder(input: {
      readonly brandReference: ReadinessReference;
      readonly storeReference: ReadinessReference;
      readonly orderReference: ReadinessReference;
      readonly transaction: ConsumerTransaction;
    }): Promise<unknown>;
    apply(input: {
      readonly effect: FulfillmentReadyEffect;
      readonly transaction: ConsumerTransaction;
    }): Promise<FulfillmentReadinessCommit>;
  };
  readonly audit: {
    append(input: {
      readonly record: AppendAuditRecordInput;
      readonly transaction: ConsumerTransaction;
    }): Promise<void>;
  };
}
