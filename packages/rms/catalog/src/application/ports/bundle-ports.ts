import type { AppendAuditRecordInput } from "@bop/audit";
import type { PermissionDecision } from "@bop/permission";
import type { TenantContext } from "@bop/tenant";

import type { BundleAggregate } from "../../domain/bundle.js";
import type { CatalogHash, CatalogInstant, CatalogReference } from "../../domain/product.js";

export type BundleOperationAction = "Create" | "ReplaceDraft" | "Publish" | "ChangeLifecycle";
export interface BundleAuthorizationEvidence {
  readonly tenantContext: TenantContext;
  readonly permission: PermissionDecision;
  readonly pricingApproval: PermissionDecision | null;
  readonly audit: AppendAuditRecordInput;
}
export interface BundleEvent {
  readonly eventType:
    | "BundleDraftCreated"
    | "BundleDraftReplaced"
    | "BundleVersionPublished"
    | "BundleLifecycleChanged";
  readonly aggregateReference: CatalogReference;
  readonly versionReference: CatalogReference;
  readonly aggregateVersion: number;
  readonly brandReference: CatalogReference;
  readonly lifecycle: BundleAggregate["lifecycle"];
  readonly validationDigest: CatalogHash | null;
  readonly occurredAt: CatalogInstant;
}
export interface BundleOperationRecord {
  readonly action: BundleOperationAction;
  readonly operationReference: CatalogReference;
  readonly operationIntentHash: CatalogHash;
  readonly aggregate: BundleAggregate;
  readonly event: BundleEvent;
}
export interface BundlePorts {
  readonly authorization: {
    authorize(input: {
      readonly action: BundleOperationAction;
      readonly operationReference: CatalogReference;
      readonly bundleReference: CatalogReference;
      readonly observedAt: CatalogInstant;
    }): Promise<BundleAuthorizationEvidence | null>;
  };
  readonly references: {
    generate(purpose: "Bundle" | "BundleVersion" | "BundleGroup"): string;
    hashIntent(value: string): string;
    equals(left: CatalogHash, right: CatalogHash): boolean;
  };
  readonly facts: {
    validatePublishedReferences(aggregate: BundleAggregate): Promise<boolean>;
  };
  readonly repository: {
    resolveOperation(operationReference: CatalogReference): Promise<BundleOperationRecord | null>;
    load(bundleReference: CatalogReference): Promise<BundleAggregate | null>;
    codeAvailable(input: {
      readonly brandReference: CatalogReference;
      readonly internalCode: string;
      readonly excludingBundleReference: CatalogReference | null;
    }): Promise<boolean>;
    create(input: {
      readonly record: BundleOperationRecord;
      readonly audit: AppendAuditRecordInput;
    }): Promise<BundleOperationRecord>;
    commit(input: {
      readonly record: BundleOperationRecord;
      readonly expectedAggregateVersion: number;
      readonly audit: AppendAuditRecordInput;
    }): Promise<BundleOperationRecord>;
  };
}
