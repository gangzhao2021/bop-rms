import type { AppendAuditRecordInput } from "@bop/audit";
import type { PermissionDecision } from "@bop/permission";
import type { TenantContext } from "@bop/tenant";
import type {
  RecipeCode,
  RecipeDigest,
  RecipeReference,
  RecipeSnapshot,
} from "../../domain/recipe.js";

export type RecipeAction = "CreateDraft" | "ReplaceDraft" | "Publish" | "Invalidate" | "Archive";
export interface RecipeEvent {
  readonly eventType:
    | "RecipeDraftCreated"
    | "RecipeDraftReplaced"
    | "RecipePublished"
    | "RecipeInvalidated"
    | "RecipeArchived";
  readonly recipeReference: RecipeReference;
  readonly versionReference: RecipeReference;
  readonly brandReference: RecipeReference;
  readonly aggregateVersion: number;
  readonly lifecycle: RecipeSnapshot["lifecycle"];
  readonly snapshotDigest: RecipeDigest;
  readonly occurredAt: string;
}
export interface RecipeOperationRecord {
  readonly action: RecipeAction;
  readonly operationReference: RecipeReference;
  readonly operationIntentHash: RecipeDigest;
  readonly aggregate: RecipeSnapshot;
  readonly event: RecipeEvent;
}
export interface RecipeAuthorizationEvidence {
  readonly tenantContext: TenantContext;
  readonly permission: PermissionDecision;
  readonly costReviewPermission: PermissionDecision | null;
  readonly foodSafetyReviewPermission: PermissionDecision | null;
  readonly draftAuthorActorReference: string | null;
  readonly costReviewerActorReference: string | null;
  readonly foodSafetyReviewerActorReference: string | null;
  readonly audit: AppendAuditRecordInput;
}
export interface RecipePorts {
  readonly authorization: {
    authorize(input: {
      readonly action: RecipeAction;
      readonly operationReference: RecipeReference;
      readonly recipeReference: RecipeReference;
      readonly observedAt: string;
    }): Promise<RecipeAuthorizationEvidence | null>;
  };
  readonly references: {
    hashIntent(canonicalIntent: string): string;
    equals(left: RecipeDigest, right: RecipeDigest): boolean;
  };
  readonly facts: {
    validate(snapshot: RecipeSnapshot): Promise<{
      readonly referencesValid: boolean;
      readonly mappingsComplete: boolean;
      readonly allergenEvidenceVerified: boolean;
      readonly costEvidenceVerified: boolean;
      readonly graphSnapshots: readonly RecipeSnapshot[];
    }>;
  };
  readonly repository: {
    resolveOperation(reference: RecipeReference): Promise<RecipeOperationRecord | null>;
    load(reference: RecipeReference): Promise<RecipeSnapshot | null>;
    codeAvailable(input: {
      readonly brandReference: RecipeReference;
      readonly stableCode: RecipeCode;
      readonly excludingRecipeReference: RecipeReference | null;
    }): Promise<boolean>;
    create(input: {
      readonly record: RecipeOperationRecord;
      readonly audit: AppendAuditRecordInput;
    }): Promise<RecipeOperationRecord>;
    commit(input: {
      readonly record: RecipeOperationRecord;
      readonly expectedAggregateVersion: number;
      readonly audit: AppendAuditRecordInput;
    }): Promise<RecipeOperationRecord>;
  };
}
