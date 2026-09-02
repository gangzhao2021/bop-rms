import type { AppendAuditRecordInput } from "@bop/audit";
import type { PermissionDecision } from "@bop/permission";
import type { TenantContext } from "@bop/tenant";
import type { PricingDigest, PricingReference } from "../../domain/money-tax-contract.js";
import type { PromotionBasket, PromotionSnapshot } from "../../domain/promotion.js";

export type PromotionAction = "CreateDraft" | "ReplaceDraft" | "Publish" | "Pause" | "Archive";
export interface PromotionEvent {
  readonly eventType:
    | "PromotionDraftCreated"
    | "PromotionDraftReplaced"
    | "PromotionPublished"
    | "PromotionPaused"
    | "PromotionArchived";
  readonly promotionReference: PricingReference;
  readonly versionReference: PricingReference;
  readonly brandReference: PricingReference;
  readonly aggregateVersion: number;
  readonly lifecycle: PromotionSnapshot["lifecycle"];
  readonly snapshotDigest: PricingDigest;
  readonly occurredAt: string;
}
export interface PromotionOperationRecord {
  readonly action: PromotionAction;
  readonly operationReference: PricingReference;
  readonly operationIntentHash: PricingDigest;
  readonly aggregate: PromotionSnapshot;
  readonly event: PromotionEvent;
}
export interface PromotionAuthorizationEvidence {
  readonly tenantContext: TenantContext;
  readonly permission: PermissionDecision;
  readonly approvalPermission: PermissionDecision | null;
  readonly draftAuthorActorReference: string | null;
  readonly audit: AppendAuditRecordInput;
}
export interface PromotionPorts {
  readonly authorization: {
    authorize(input: {
      readonly action: PromotionAction;
      readonly operationReference: PricingReference;
      readonly promotionReference: PricingReference;
      readonly observedAt: string;
    }): Promise<PromotionAuthorizationEvidence | null>;
  };
  readonly references: {
    hashIntent(value: string): string;
    equals(left: PricingDigest, right: PricingDigest): boolean;
  };
  readonly facts: {
    validate(snapshot: PromotionSnapshot): Promise<boolean>;
    representativeBaskets(snapshot: PromotionSnapshot): Promise<readonly PromotionBasket[]>;
  };
  readonly repository: {
    resolveOperation(reference: PricingReference): Promise<PromotionOperationRecord | null>;
    load(reference: PricingReference): Promise<PromotionSnapshot | null>;
    codeAvailable(input: {
      readonly brandReference: PricingReference;
      readonly stableCode: string;
      readonly excludingPromotionReference: PricingReference | null;
    }): Promise<boolean>;
    create(input: {
      readonly record: PromotionOperationRecord;
      readonly audit: AppendAuditRecordInput;
    }): Promise<PromotionOperationRecord>;
    commit(input: {
      readonly record: PromotionOperationRecord;
      readonly expectedAggregateVersion: number;
      readonly audit: AppendAuditRecordInput;
    }): Promise<PromotionOperationRecord>;
  };
}
