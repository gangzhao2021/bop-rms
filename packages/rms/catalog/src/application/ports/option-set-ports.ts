import type { AppendAuditRecordInput } from "@bop/audit";
import type { PermissionDecision } from "@bop/permission";
import type { TenantContext } from "@bop/tenant";

import type { OptionSetAggregate } from "../../domain/option-set.js";
import type { CatalogHash, CatalogInstant, CatalogReference } from "../../domain/product.js";

export type OptionSetOperationAction = "Create" | "ReplaceDraft" | "Archive";
export interface OptionSetAuthorizationEvidence {
  readonly tenantContext: TenantContext;
  readonly permission: PermissionDecision;
  readonly audit: AppendAuditRecordInput;
}
export interface OptionSetOperationRecord {
  readonly action: OptionSetOperationAction;
  readonly operationReference: CatalogReference;
  readonly operationIntentHash: CatalogHash;
  readonly aggregate: OptionSetAggregate;
}
export interface OptionSetPorts {
  readonly authorization: {
    authorize(input: {
      readonly action: OptionSetOperationAction;
      readonly operationReference: CatalogReference;
      readonly optionSetReference: CatalogReference;
      readonly observedAt: CatalogInstant;
    }): Promise<OptionSetAuthorizationEvidence | null>;
  };
  readonly references: {
    generate(purpose: "OptionSet" | "OptionSetVersion" | "Option"): string;
    hashIntent(value: string): CatalogHash;
    equals(left: CatalogHash, right: CatalogHash): boolean;
  };
  readonly facts: {
    validateTriggerGraph(input: {
      readonly brandReference: CatalogReference;
      readonly optionSetReference: CatalogReference;
      readonly triggeredOptionSetReferences: readonly CatalogReference[];
    }): Promise<boolean>;
  };
  readonly repository: {
    resolveOperation(
      operationReference: CatalogReference,
    ): Promise<OptionSetOperationRecord | null>;
    load(optionSetReference: CatalogReference): Promise<OptionSetAggregate | null>;
    codeAvailable(input: {
      readonly brandReference: CatalogReference;
      readonly internalCode: string;
      readonly excludingOptionSetReference: CatalogReference | null;
    }): Promise<boolean>;
    create(input: {
      readonly record: OptionSetOperationRecord;
      readonly audit: AppendAuditRecordInput;
    }): Promise<OptionSetOperationRecord>;
    commit(input: {
      readonly record: OptionSetOperationRecord;
      readonly expectedAggregateVersion: number;
      readonly audit: AppendAuditRecordInput;
    }): Promise<OptionSetOperationRecord>;
  };
}
