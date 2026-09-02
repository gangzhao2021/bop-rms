import { validateAuditRecord } from "@bop/audit";
import {
  createProductionBatch,
  parseProductionReference,
  transitionProductionBatch,
  type ProductionBatch,
  type ProductionReference,
} from "../domain/production-batch.js";
import type {
  ProductionBatchAction,
  ProductionBatchEvent,
  ProductionBatchOperationRecord,
  ProductionBatchPorts,
} from "./ports/production-batch-ports.js";
export type ProductionBatchWorkflowErrorCode =
  | "PRODUCTION_BATCH_INPUT_INVALID"
  | "PRODUCTION_BATCH_PERMISSION_DENIED"
  | "PRODUCTION_BATCH_VERSION_CONFLICT"
  | "PRODUCTION_BATCH_IDEMPOTENCY_CONFLICT"
  | "PRODUCTION_BATCH_EVIDENCE_INVALID"
  | "PRODUCTION_BATCH_LIFECYCLE_CONFLICT"
  | "PRODUCTION_BATCH_DEPENDENCY_UNAVAILABLE";
export class ProductionBatchWorkflowError extends Error {
  constructor(readonly code: ProductionBatchWorkflowErrorCode) {
    super("Production Batch operation is unavailable");
    this.name = "ProductionBatchWorkflowError";
  }
}
const invalid = (): never => {
  throw new ProductionBatchWorkflowError("PRODUCTION_BATCH_INPUT_INVALID");
};
const dependency = (): never => {
  throw new ProductionBatchWorkflowError("PRODUCTION_BATCH_DEPENDENCY_UNAVAILABLE");
};
const eventTypes: Record<ProductionBatchAction, ProductionBatchEvent["eventType"]> = {
  CreatePlan: "ProductionBatchPlanned",
  Start: "ProductionBatchStarted",
  RecordObservation: "ProductionBatchObservationRecorded",
  Complete: "ProductionBatchCompleted",
  Quarantine: "ProductionBatchQuarantined",
};
function event(
  action: ProductionBatchAction,
  batch: ProductionBatch,
  at: string,
): ProductionBatchEvent {
  return Object.freeze({
    eventType: eventTypes[action],
    productionBatchReference: batch.productionBatchReference,
    recipeReference: batch.recipeReference,
    recipeVersionReference: batch.recipeVersionReference,
    aggregateVersion: batch.aggregateVersion.toString(),
    status: batch.status,
    plannedYieldMicrounits: batch.plannedYieldMicrounits,
    actualYieldMicrounits: batch.actualYieldMicrounits,
    qualityHold: batch.qualityHold,
    occurredAt: at,
  });
}
function sameIdentity(left: ProductionBatch, right: ProductionBatch) {
  return (
    left.productionBatchReference === right.productionBatchReference &&
    left.tenantReference === right.tenantReference &&
    left.brandReference === right.brandReference &&
    left.storeReference === right.storeReference &&
    left.recipeReference === right.recipeReference &&
    left.recipeVersionReference === right.recipeVersionReference &&
    left.stationReference === right.stationReference &&
    left.plannedYieldMicrounits === right.plannedYieldMicrounits &&
    left.plannedAt === right.plannedAt &&
    JSON.stringify(
      left.ingredients.map((item) => ({
        ingredientReference: item.ingredientReference,
        inventoryItemReference: item.inventoryItemReference,
        lotReference: item.lotReference,
        plannedQuantityMicrounits: item.plannedQuantityMicrounits,
      })),
    ) ===
      JSON.stringify(
        right.ingredients.map((item) => ({
          ingredientReference: item.ingredientReference,
          inventoryItemReference: item.inventoryItemReference,
          lotReference: item.lotReference,
          plannedQuantityMicrounits: item.plannedQuantityMicrounits,
        })),
      )
  );
}
function sameBatch(left: ProductionBatch, right: ProductionBatch) {
  return JSON.stringify(left) === JSON.stringify(right);
}
export interface ExecuteProductionBatchInput {
  readonly action: ProductionBatchAction;
  readonly operationReference: ProductionReference;
  readonly expectedAggregateVersion: number | null;
  readonly candidate: ProductionBatch;
  readonly occurredAt: string;
}
export function createProductionBatchService(ports: ProductionBatchPorts) {
  return Object.freeze({
    async execute(input: ExecuteProductionBatchInput) {
      if (
        input === null ||
        typeof input !== "object" ||
        Array.isArray(input) ||
        Object.getPrototypeOf(input) !== Object.prototype ||
        Reflect.ownKeys(input).length !== 5 ||
        !Object.hasOwn(eventTypes, input.action)
      )
        invalid();
      const operationReference = parseProductionReference(input.operationReference);
      const candidate = createProductionBatch(input.candidate);
      if (candidate.observedAt !== input.occurredAt) invalid();
      let intentDigest: string;
      try {
        intentDigest = ports.references.hashIntent(JSON.stringify(input));
      } catch {
        return dependency();
      }
      if (!/^sha256:[0-9a-f]{64}$/u.test(intentDigest)) return dependency();
      const evidence = await ports.authorization
        .authorize({
          action: input.action,
          productionBatchReference: candidate.productionBatchReference,
          observedAt: input.occurredAt,
        })
        .catch(dependency);
      if (evidence === null)
        throw new ProductionBatchWorkflowError("PRODUCTION_BATCH_PERMISSION_DENIED");
      let audit;
      try {
        audit = validateAuditRecord(evidence.audit, Date.parse(input.occurredAt));
        if (
          evidence.purpose !== "production-batch" ||
          evidence.permission.effect !== "Allow" ||
          evidence.permission.action !== "kitchen.production.manage" ||
          evidence.permission.scopeKind !== "Store" ||
          candidate.tenantReference !== evidence.tenantReference ||
          candidate.brandReference !== evidence.brandReference ||
          candidate.storeReference !== evidence.storeReference ||
          audit.brandId !== evidence.brandReference ||
          audit.storeId !== evidence.storeReference ||
          audit.actor.type === "System" ||
          audit.actor.reference !== evidence.actorReference ||
          audit.actionCode !== `PRODUCTION_BATCH_${input.action.toUpperCase()}` ||
          audit.targetType !== "ProductionBatch" ||
          audit.targetId !== candidate.productionBatchReference ||
          audit.occurredAt !== input.occurredAt
        )
          throw new Error("denied");
      } catch {
        throw new ProductionBatchWorkflowError("PRODUCTION_BATCH_PERMISSION_DENIED");
      }
      const prior = await ports.repository.resolveOperation(operationReference).catch(dependency);
      if (prior !== null) {
        if (!ports.references.equals(prior.intentDigest, intentDigest))
          throw new ProductionBatchWorkflowError("PRODUCTION_BATCH_IDEMPOTENCY_CONFLICT");
        return Object.freeze({ status: "AlreadyApplied" as const, batch: prior.batch });
      }
      const current = await ports.repository
        .load(candidate.productionBatchReference)
        .catch(dependency);
      if (input.action === "CreatePlan") {
        if (
          input.expectedAggregateVersion !== null ||
          current !== null ||
          candidate.status !== "Planned" ||
          candidate.aggregateVersion !== 1
        )
          throw new ProductionBatchWorkflowError("PRODUCTION_BATCH_LIFECYCLE_CONFLICT");
        const [recipe, inventory] = await Promise.all([
          ports.recipe
            .validatePublished({
              recipeReference: candidate.recipeReference,
              recipeVersionReference: candidate.recipeVersionReference,
              brandReference: candidate.brandReference,
            })
            .catch(dependency),
          ports.inventory
            .validateSources({
              storeReference: candidate.storeReference,
              ingredients: candidate.ingredients,
            })
            .catch(dependency),
        ]);
        if (!recipe || !inventory)
          throw new ProductionBatchWorkflowError("PRODUCTION_BATCH_EVIDENCE_INVALID");
      } else {
        if (
          !Number.isSafeInteger(input.expectedAggregateVersion) ||
          (input.expectedAggregateVersion as number) < 1 ||
          current === null ||
          current.aggregateVersion !== input.expectedAggregateVersion
        )
          throw new ProductionBatchWorkflowError("PRODUCTION_BATCH_VERSION_CONFLICT");
        if (
          !sameIdentity(current, candidate) ||
          candidate.aggregateVersion !== current.aggregateVersion + 1
        )
          throw new ProductionBatchWorkflowError("PRODUCTION_BATCH_LIFECYCLE_CONFLICT");
        const expected: Record<
          Exclude<ProductionBatchAction, "CreatePlan">,
          readonly ProductionBatch["status"][]
        > = {
          Start: ["InProgress"],
          RecordObservation: ["InProgress"],
          Complete: ["Completed"],
          Quarantine: ["Quarantined"],
        };
        if (!expected[input.action].includes(candidate.status))
          throw new ProductionBatchWorkflowError("PRODUCTION_BATCH_LIFECYCLE_CONFLICT");
        if (
          input.action === "Start" ||
          input.action === "Complete" ||
          input.action === "Quarantine"
        ) {
          let transitioned: ProductionBatch;
          try {
            transitioned = transitionProductionBatch(
              current,
              input.action,
              input.occurredAt,
              input.action === "Quarantine" ? candidate.qualityExceptionReasonCode : null,
            );
          } catch {
            throw new ProductionBatchWorkflowError("PRODUCTION_BATCH_LIFECYCLE_CONFLICT");
          }
          if (!sameBatch(transitioned, candidate))
            throw new ProductionBatchWorkflowError("PRODUCTION_BATCH_LIFECYCLE_CONFLICT");
        }
        if (input.action === "RecordObservation") {
          const threshold = await ports.policy
            .varianceThresholdBasisPoints({
              storeReference: candidate.storeReference,
              observedAt: input.occurredAt,
            })
            .catch(dependency);
          if (!Number.isSafeInteger(threshold) || threshold < 0) return dependency();
          if ((candidate.varianceBasisPoints ?? 0) > threshold && !candidate.qualityHold)
            throw new ProductionBatchWorkflowError("PRODUCTION_BATCH_EVIDENCE_INVALID");
        }
      }
      const record: ProductionBatchOperationRecord = Object.freeze({
        operationReference,
        intentDigest,
        batch: candidate,
        audit,
        event: event(input.action, candidate, input.occurredAt),
      });
      await ports.repository.commit(record).catch(dependency);
      return Object.freeze({ status: "Applied" as const, batch: candidate });
    },
  });
}
