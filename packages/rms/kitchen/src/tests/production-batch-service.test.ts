import { describe, expect, it } from "vitest";
import {
  createProductionBatch,
  createProductionBatchService,
  observeProductionBatch,
  parseProductionCode,
  parseProductionReference,
  transitionProductionBatch,
  type ProductionBatchOperationRecord,
  type ProductionBatchPorts,
} from "../index.js";
const raw = (n: number) => `018f9f00-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const id = (n: number) => parseProductionReference(raw(n));
const refs = {
  batch: id(1),
  tenant: id(2),
  brand: id(3),
  store: id(4),
  actor: id(5),
  recipe: id(6),
  recipeVersion: id(7),
  station: id(8),
  ingredient: id(9),
  item: id(10),
  operation: id(11),
};
const at = "2026-08-14T01:00:00.000Z";
function planned() {
  return createProductionBatch({
    productionBatchReference: refs.batch,
    tenantReference: refs.tenant,
    brandReference: refs.brand,
    storeReference: refs.store,
    recipeReference: refs.recipe,
    recipeVersionReference: refs.recipeVersion,
    stationReference: refs.station,
    plannedYieldMicrounits: "1000000",
    actualYieldMicrounits: null,
    ingredients: [
      {
        ingredientReference: refs.ingredient,
        inventoryItemReference: refs.item,
        lotReference: null,
        plannedQuantityMicrounits: "500000",
        actualQuantityMicrounits: null,
      },
    ],
    status: "Planned",
    qualityHold: false,
    varianceBasisPoints: null,
    qualityExceptionReasonCode: null,
    aggregateVersion: 1,
    plannedAt: at,
    observedAt: at,
  });
}
const hash = (value: string) => {
  let state = 2166136261;
  for (const character of value) state = Math.imul(state ^ character.charCodeAt(0), 16777619);
  return `sha256:${(state >>> 0).toString(16).padStart(8, "0").repeat(8)}`;
};
function fixture(options: { denied?: boolean; recipe?: boolean; inventory?: boolean } = {}) {
  const operations = new Map<string, ProductionBatchOperationRecord>();
  let current: ReturnType<typeof planned> | null = null;
  const events: unknown[] = [];
  const ports: ProductionBatchPorts = {
    authorization: {
      async authorize(input) {
        if (options.denied) return null;
        return {
          tenantReference: refs.tenant,
          brandReference: refs.brand,
          storeReference: refs.store,
          actorReference: refs.actor,
          purpose: "production-batch" as const,
          permission: {
            effect: "Allow" as const,
            action: "kitchen.production.manage" as const,
            scopeKind: "Store" as const,
          },
          audit: {
            auditId: raw(20),
            brandId: refs.brand,
            storeId: refs.store,
            actor: { type: "User" as const, reference: refs.actor },
            actionCode: `PRODUCTION_BATCH_${input.action.toUpperCase()}`,
            targetType: "ProductionBatch",
            targetId: refs.batch,
            reasonCode: "AUTHORIZED",
            correlationId: raw(21),
            occurredAt: input.observedAt,
            sourceChannel: "OPERATIONS_WEB",
            dataClassification: "Internal" as const,
            retentionPolicyCode: "AUDIT_STANDARD",
            retentionPolicyVersion: 1,
          },
        };
      },
    },
    recipe: {
      async validatePublished() {
        return options.recipe !== false;
      },
    },
    inventory: {
      async validateSources() {
        return options.inventory !== false;
      },
    },
    policy: {
      async varianceThresholdBasisPoints() {
        return 200;
      },
    },
    references: { hashIntent: hash, equals: (left, right) => left === right },
    repository: {
      async resolveOperation(reference) {
        return operations.get(reference) ?? null;
      },
      async load() {
        return current;
      },
      async commit(record) {
        operations.set(record.operationReference, record);
        current = record.batch;
        events.push(record.event);
      },
    },
  };
  return { service: createProductionBatchService(ports), events, current: () => current };
}
describe("Production Batch service", () => {
  it("authorizes, validates public evidence, commits and replays the plan", async () => {
    const value = fixture();
    const command = {
      action: "CreatePlan" as const,
      operationReference: refs.operation,
      expectedAggregateVersion: null,
      candidate: planned(),
      occurredAt: at,
    };
    await expect(value.service.execute(command)).resolves.toMatchObject({
      status: "Applied",
      batch: { status: "Planned" },
    });
    expect(value.events).toEqual([
      expect.objectContaining({ eventType: "ProductionBatchPlanned" }),
    ]);
    await expect(value.service.execute(command)).resolves.toMatchObject({
      status: "AlreadyApplied",
    });
  });
  it("fails closed on permission and Recipe / Inventory evidence", async () => {
    const command = {
      action: "CreatePlan" as const,
      operationReference: refs.operation,
      expectedAggregateVersion: null,
      candidate: planned(),
      occurredAt: at,
    };
    await expect(fixture({ denied: true }).service.execute(command)).rejects.toMatchObject({
      code: "PRODUCTION_BATCH_PERMISSION_DENIED",
    });
    await expect(fixture({ recipe: false }).service.execute(command)).rejects.toMatchObject({
      code: "PRODUCTION_BATCH_EVIDENCE_INVALID",
    });
    await expect(fixture({ inventory: false }).service.execute(command)).rejects.toMatchObject({
      code: "PRODUCTION_BATCH_EVIDENCE_INVALID",
    });
  });
  it("enforces Expected Version on later lifecycle commands", async () => {
    const value = fixture();
    await value.service.execute({
      action: "CreatePlan",
      operationReference: refs.operation,
      expectedAggregateVersion: null,
      candidate: planned(),
      occurredAt: at,
    });
    const started = transitionProductionBatch(planned(), "Start", "2026-08-14T01:01:00.000Z");
    await expect(
      value.service.execute({
        action: "Start",
        operationReference: id(12),
        expectedAggregateVersion: 9,
        candidate: started,
        occurredAt: started.observedAt,
      }),
    ).rejects.toMatchObject({ code: "PRODUCTION_BATCH_VERSION_CONFLICT" });
  });
  it("rejects a caller-injected Start snapshot instead of bypassing the Domain transition", async () => {
    const value = fixture();
    await value.service.execute({
      action: "CreatePlan",
      operationReference: refs.operation,
      expectedAggregateVersion: null,
      candidate: planned(),
      occurredAt: at,
    });
    const started = transitionProductionBatch(planned(), "Start", "2026-08-14T01:01:00.000Z");
    const injected = createProductionBatch({
      ...started,
      actualYieldMicrounits: "900000",
      ingredients: [{ ...started.ingredients[0], actualQuantityMicrounits: "500000" }],
      varianceBasisPoints: 1000,
    });
    await expect(
      value.service.execute({
        action: "Start",
        operationReference: id(13),
        expectedAggregateVersion: 1,
        candidate: injected,
        occurredAt: injected.observedAt,
      }),
    ).rejects.toMatchObject({ code: "PRODUCTION_BATCH_LIFECYCLE_CONFLICT" });
  });
  it("commits the exact Start, Observation, Complete and Quarantine transitions", async () => {
    const value = fixture();
    await value.service.execute({
      action: "CreatePlan",
      operationReference: refs.operation,
      expectedAggregateVersion: null,
      candidate: planned(),
      occurredAt: at,
    });
    const started = transitionProductionBatch(planned(), "Start", "2026-08-14T01:01:00.000Z");
    await value.service.execute({
      action: "Start",
      operationReference: id(12),
      expectedAggregateVersion: 1,
      candidate: started,
      occurredAt: started.observedAt,
    });
    const observed = observeProductionBatch(started, {
      actualYieldMicrounits: "1000000",
      actualIngredientQuantities: { [refs.ingredient]: "500000" },
      varianceThresholdBasisPoints: 200,
      qualityExceptionReasonCode: null,
      observedAt: "2026-08-14T01:02:00.000Z",
    });
    await value.service.execute({
      action: "RecordObservation",
      operationReference: id(13),
      expectedAggregateVersion: 2,
      candidate: observed,
      occurredAt: observed.observedAt,
    });
    const completed = transitionProductionBatch(observed, "Complete", "2026-08-14T01:03:00.000Z");
    await value.service.execute({
      action: "Complete",
      operationReference: id(14),
      expectedAggregateVersion: 3,
      candidate: completed,
      occurredAt: completed.observedAt,
    });
    const quarantined = transitionProductionBatch(
      completed,
      "Quarantine",
      "2026-08-14T01:04:00.000Z",
      parseProductionCode("QUALITY_REVIEW"),
    );
    await value.service.execute({
      action: "Quarantine",
      operationReference: id(15),
      expectedAggregateVersion: 4,
      candidate: quarantined,
      occurredAt: quarantined.observedAt,
    });
    expect(value.events).toEqual([
      expect.objectContaining({ eventType: "ProductionBatchPlanned" }),
      expect.objectContaining({ eventType: "ProductionBatchStarted" }),
      expect.objectContaining({ eventType: "ProductionBatchObservationRecorded" }),
      expect.objectContaining({ eventType: "ProductionBatchCompleted" }),
      expect.objectContaining({ eventType: "ProductionBatchQuarantined" }),
    ]);
  });
});
