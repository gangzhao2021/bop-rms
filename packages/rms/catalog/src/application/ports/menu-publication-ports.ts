import type { AppendAuditRecordInput } from "@bop/audit";
import type { PermissionDecision } from "@bop/permission";
import type { TenantContext } from "@bop/tenant";
import type {
  PublishingApprovalEvidence,
  PublishingLifecycleRecord,
  PublishingReleaseRecord,
  PublishingValidationEvidence,
} from "@bop/publishing";

import type {
  MenuPublicationAction,
  MenuPublicationCommand,
  MenuPublicationRecord,
} from "../../contracts/menu-publication.js";
import type { CatalogHash, CatalogReference } from "../../contracts/product.js";

export interface MenuPublicationAuthorizationEvidence {
  readonly tenantContext: TenantContext;
  readonly permission: PermissionDecision;
  readonly audit: AppendAuditRecordInput;
}

export interface MenuPublicationOperationRecord {
  readonly command: MenuPublicationCommand;
  readonly intentHash: CatalogHash;
  readonly result: MenuPublicationRecord;
}

export interface MenuPublicationPorts {
  readonly authorization: {
    authorize(
      command: MenuPublicationCommand,
    ): Promise<MenuPublicationAuthorizationEvidence | null>;
  };
  readonly facts: {
    loadDraftSnapshot(input: {
      readonly menuReference: CatalogReference;
      readonly menuVersionReference: CatalogReference;
      readonly brandReference: CatalogReference;
      readonly snapshotDigest: CatalogHash;
    }): Promise<PublishingLifecycleRecord | null>;
  };
  readonly evidence: {
    validation(command: MenuPublicationCommand): Promise<PublishingValidationEvidence | null>;
    approval(command: MenuPublicationCommand): Promise<PublishingApprovalEvidence | null>;
  };
  readonly repository: {
    resolveOperation(
      operationReference: CatalogReference,
    ): Promise<MenuPublicationOperationRecord | null>;
    load(menuVersionReference: CatalogReference): Promise<MenuPublicationRecord | null>;
    hasEffectiveOverlap(record: MenuPublicationRecord): Promise<boolean>;
    nextReleaseSequence(menuReference: CatalogReference): Promise<number>;
    currentRelease(menuReference: CatalogReference): Promise<PublishingReleaseRecord | null>;
    commit(input: {
      readonly operation: MenuPublicationOperationRecord;
      readonly expectedVersion: number;
      readonly audit: AppendAuditRecordInput;
    }): Promise<MenuPublicationOperationRecord>;
  };
  readonly references: {
    generate(purpose: "Lifecycle" | "Release"): string;
    hashIntent(value: string): CatalogHash;
    equals(left: CatalogHash, right: CatalogHash): boolean;
  };
}

export type { MenuPublicationAction };
