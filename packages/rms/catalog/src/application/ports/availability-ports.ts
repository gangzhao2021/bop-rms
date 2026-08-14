import type { AppendAuditRecordInput } from "@bop/audit";
import type { PermissionDecision } from "@bop/permission";
import type { TenantContext } from "@bop/tenant";
import type {
  AvailabilityRuleAggregate,
  AvailabilitySellableType,
} from "../../domain/availability.js";
import type { CatalogHash, CatalogInstant, CatalogReference } from "../../domain/product.js";

export type AvailabilityOperationAction = "Create" | "Replace" | "ChangeLifecycle";
export interface AvailabilityEvent {
  readonly eventType:
    "AvailabilityRuleCreated" | "AvailabilityRuleReplaced" | "AvailabilityRuleLifecycleChanged";
  readonly aggregateReference: CatalogReference;
  readonly aggregateVersion: number;
  readonly brandReference: CatalogReference;
  readonly sellableType: AvailabilitySellableType;
  readonly lifecycle: AvailabilityRuleAggregate["lifecycle"];
  readonly occurredAt: CatalogInstant;
}
export interface AvailabilityOperationRecord {
  readonly action: AvailabilityOperationAction;
  readonly operationReference: CatalogReference;
  readonly operationIntentHash: CatalogHash;
  readonly aggregate: AvailabilityRuleAggregate;
  readonly event: AvailabilityEvent;
}
export interface AvailabilityPorts {
  readonly authorization: {
    authorize(input: {
      readonly action: AvailabilityOperationAction;
      readonly operationReference: CatalogReference;
      readonly ruleReference: CatalogReference;
      readonly observedAt: CatalogInstant;
    }): Promise<{
      readonly tenantContext: TenantContext;
      readonly permission: PermissionDecision;
      readonly audit: AppendAuditRecordInput;
    } | null>;
  };
  readonly references: {
    generate(purpose: "AvailabilityRule"): string;
    hashIntent(value: string): CatalogHash;
    equals(left: CatalogHash, right: CatalogHash): boolean;
  };
  readonly facts: {
    validate(input: {
      readonly brandReference: CatalogReference;
      readonly storeReference: CatalogReference | null;
      readonly sellableReference: CatalogReference;
      readonly sellableType: AvailabilitySellableType;
    }): Promise<boolean>;
  };
  readonly repository: {
    resolveOperation(
      operationReference: CatalogReference,
    ): Promise<AvailabilityOperationRecord | null>;
    load(ruleReference: CatalogReference): Promise<AvailabilityRuleAggregate | null>;
    codeAvailable(input: {
      readonly brandReference: CatalogReference;
      readonly internalCode: string;
      readonly excludingRuleReference: CatalogReference | null;
    }): Promise<boolean>;
    create(input: {
      readonly record: AvailabilityOperationRecord;
      readonly audit: AppendAuditRecordInput;
    }): Promise<AvailabilityOperationRecord>;
    commit(input: {
      readonly record: AvailabilityOperationRecord;
      readonly expectedAggregateVersion: number;
      readonly audit: AppendAuditRecordInput;
    }): Promise<AvailabilityOperationRecord>;
  };
}
