import type { AppendAuditRecordInput } from "@bop/audit";
import type { PermissionDecision } from "@bop/permission";
import type { TenantContext } from "@bop/tenant";
import type { PriceBookSnapshot } from "../../domain/price-resolution.js";
import type { PricingDigest, PricingReference } from "../../domain/money-tax-contract.js";

export type PriceBookAction = "CreateDraft" | "ReplaceDraft" | "Publish" | "Archive";
export interface PriceBookEvent {
  readonly eventType:
    | "PriceBookDraftCreated"
    | "PriceBookDraftReplaced"
    | "PriceBookVersionPublished"
    | "PriceBookArchived";
  readonly priceBookReference: PricingReference;
  readonly versionReference: PricingReference;
  readonly brandReference: PricingReference;
  readonly aggregateVersion: number;
  readonly lifecycle: PriceBookSnapshot["lifecycle"];
  readonly currencyCode: string;
  readonly snapshotDigest: PricingDigest;
  readonly occurredAt: string;
}
export interface PriceBookOperationRecord {
  readonly action: PriceBookAction;
  readonly operationReference: PricingReference;
  readonly operationIntentHash: PricingDigest;
  readonly aggregate: PriceBookSnapshot;
  readonly event: PriceBookEvent;
}
export interface PriceBookAuthorizationEvidence {
  readonly tenantContext: TenantContext;
  readonly permission: PermissionDecision;
  readonly approvalPermission: PermissionDecision | null;
  readonly draftAuthorActorReference: string | null;
  readonly audit: AppendAuditRecordInput;
}
export interface PriceBookPorts {
  readonly authorization: {
    authorize(input: {
      readonly action: PriceBookAction;
      readonly operationReference: PricingReference;
      readonly priceBookReference: PricingReference;
      readonly observedAt: string;
    }): Promise<PriceBookAuthorizationEvidence | null>;
  };
  readonly references: {
    hashIntent(value: string): string;
    equals(left: PricingDigest, right: PricingDigest): boolean;
  };
  readonly facts: { validate(snapshot: PriceBookSnapshot): Promise<boolean> };
  readonly repository: {
    resolveOperation(
      operationReference: PricingReference,
    ): Promise<PriceBookOperationRecord | null>;
    load(priceBookReference: PricingReference): Promise<PriceBookSnapshot | null>;
    codeAvailable(input: {
      readonly brandReference: PricingReference;
      readonly stableCode: string;
      readonly excludingPriceBookReference: PricingReference | null;
    }): Promise<boolean>;
    create(input: {
      readonly record: PriceBookOperationRecord;
      readonly audit: AppendAuditRecordInput;
    }): Promise<PriceBookOperationRecord>;
    commit(input: {
      readonly record: PriceBookOperationRecord;
      readonly expectedAggregateVersion: number;
      readonly audit: AppendAuditRecordInput;
    }): Promise<PriceBookOperationRecord>;
  };
}
