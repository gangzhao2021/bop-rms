import type { AppendAuditRecordInput } from "@bop/audit";
import type { ProductionBatch, ProductionReference } from "../../domain/production-batch.js";
export type ProductionBatchAction =
  "CreatePlan" | "Start" | "RecordObservation" | "Complete" | "Quarantine";
export interface ProductionBatchEvent {
  readonly eventType:
    | "ProductionBatchPlanned"
    | "ProductionBatchStarted"
    | "ProductionBatchObservationRecorded"
    | "ProductionBatchCompleted"
    | "ProductionBatchQuarantined";
  readonly productionBatchReference: ProductionReference;
  readonly recipeReference: ProductionReference;
  readonly recipeVersionReference: ProductionReference;
  readonly aggregateVersion: string;
  readonly status: ProductionBatch["status"];
  readonly plannedYieldMicrounits: string;
  readonly actualYieldMicrounits: string | null;
  readonly qualityHold: boolean;
  readonly occurredAt: string;
}
export interface ProductionBatchOperationRecord {
  readonly operationReference: ProductionReference;
  readonly intentDigest: string;
  readonly batch: ProductionBatch;
  readonly audit: AppendAuditRecordInput;
  readonly event: ProductionBatchEvent;
}
export interface ProductionBatchPorts {
  readonly authorization: {
    authorize(input: {
      readonly action: ProductionBatchAction;
      readonly productionBatchReference: ProductionReference;
      readonly observedAt: string;
    }): Promise<null | {
      readonly tenantReference: ProductionReference;
      readonly brandReference: ProductionReference;
      readonly storeReference: ProductionReference;
      readonly actorReference: ProductionReference;
      readonly purpose: "production-batch";
      readonly permission: {
        readonly effect: "Allow" | "Deny";
        readonly action: "kitchen.production.manage";
        readonly scopeKind: "Store";
      };
      readonly audit: AppendAuditRecordInput;
    }>;
  };
  readonly recipe: {
    validatePublished(input: {
      readonly recipeReference: ProductionReference;
      readonly recipeVersionReference: ProductionReference;
      readonly brandReference: ProductionReference;
    }): Promise<boolean>;
  };
  readonly inventory: {
    validateSources(input: {
      readonly storeReference: ProductionReference;
      readonly ingredients: ProductionBatch["ingredients"];
    }): Promise<boolean>;
  };
  readonly policy: {
    varianceThresholdBasisPoints(input: {
      readonly storeReference: ProductionReference;
      readonly observedAt: string;
    }): Promise<number>;
  };
  readonly references: {
    hashIntent(value: string): string;
    equals(left: string, right: string): boolean;
  };
  readonly repository: {
    resolveOperation(
      operationReference: ProductionReference,
    ): Promise<ProductionBatchOperationRecord | null>;
    load(productionBatchReference: ProductionReference): Promise<ProductionBatch | null>;
    commit(record: ProductionBatchOperationRecord): Promise<void>;
  };
}
