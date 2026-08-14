import { createBrand, createTenantContext } from "@bop/tenant";
import { describe, expect, it } from "vitest";
import {
  createBackfillRequestSnapshot,
  createPipelineRunService,
  createPipelineRunSnapshot,
  createPipelineRunStateSnapshot,
  parseReportingReference,
  type BackfillRequestSnapshot,
  type PipelineOperationRecord,
  type PipelineRunPorts,
  type PipelineRunSnapshot,
  type PipelineRunStateSnapshot,
} from "../index.js";

const id = (n: number) => `018f9940-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const ref = (n: number) => parseReportingReference(id(n));
const scope = { tenantReference: id(1), brandReference: id(2), storeReference: null };
const at = "2026-08-14T18:00:00.000Z";
const before = "2026-08-14T17:00:00.000Z";
const digest = `sha256:${"a".repeat(64)}`;
const run = () => ({
  runReference: id(3),
  scope,
  pipelineReference: id(4),
  pipelineVersionReference: id(5),
  transformationVersionReference: id(6),
  inputCheckpointReference: id(7),
  outputDatasetVersionReference: id(8),
  outputPartitionCode: "BUSINESS_DATE_2026_08_14",
  environmentCode: "TEST",
  logicalBatchDigest: digest,
  executionKind: "Load",
  replay: false,
  retryOfRunReference: null,
  backfillRequestVersionReference: null,
  correctionReasonCode: null,
  correctionCodeVersionReference: null,
  preReconciliationRunReference: null,
  queuedAt: at,
  requestedByActorReference: id(9),
});
const state = () => ({
  stateReference: id(10),
  runReference: id(3),
  scope,
  sequence: 2,
  status: "Succeeded",
  watermarkOccurredAt: at,
  recordsRead: "100",
  recordsWritten: "97",
  recordsLate: "2",
  recordsRejected: "3",
  dataQualityResultReference: id(11),
  postReconciliationRunReference: null,
  errorReference: null,
  occurredAt: at,
  actorReference: id(9),
});
const request = () => ({
  requestReference: id(12),
  requestVersionReference: id(13),
  scope,
  aggregateVersion: 2,
  versionNumber: 2,
  snapshotDigest: digest,
  lifecycle: "Approved",
  pipelineReference: id(4),
  pipelineVersionReference: id(5),
  transformationVersionReference: id(6),
  outputDatasetVersionReference: id(8),
  outputPartitionCode: "BUSINESS_DATE_2026_08_14",
  rangeFrom: before,
  rangeUntil: at,
  reasonCode: "HISTORICAL_LOAD",
  requestedAt: at,
  requestedByActorReference: id(9),
  decidedAt: at,
  decidedByActorReference: id(14),
  boundRunReference: null,
  recordedAt: at,
  recordedByActorReference: id(14),
});

function tenant(observedAt: string) {
  return createTenantContext(
    {
      actorType: "User",
      actorReference: id(9),
      accountKind: "Workforce",
      status: "Active",
      authenticationMethod: "Oidc",
      verificationLevel: "SingleFactor",
      authenticatedAt: observedAt,
      recentMfaAt: null,
    } as never,
    createBrand({
      brandReference: id(2),
      code: "REPORTING",
      displayName: "Synthetic Reporting Brand",
      defaultLocale: "en-CA",
      currencyCode: "CAD",
      lifecycle: "Active",
      version: 1,
      createdAt: before,
      updatedAt: before,
    }),
    null,
    observedAt,
  );
}
function hash(value: string) {
  let valueHash = 2166136261;
  for (const character of value) {
    valueHash ^= character.charCodeAt(0);
    valueHash = Math.imul(valueHash, 16777619);
  }
  return `sha256:${(valueHash >>> 0).toString(16).padStart(8, "0").repeat(8)}`;
}
function workflowFixture() {
  const runs = new Map<string, PipelineRunSnapshot>();
  const logicalBatches = new Map<string, PipelineRunSnapshot>();
  const states = new Map<string, PipelineRunStateSnapshot>();
  const backfills = new Map<string, BackfillRequestSnapshot>();
  const backfillVersions = new Map<string, BackfillRequestSnapshot>();
  const operations = new Map<string, PipelineOperationRecord>();
  const permissionByAction = {
    CreateRun: "reporting.pipeline.run",
    AdvanceRun: "reporting.pipeline.run",
    RequestBackfill: "reporting.pipeline.backfill.request",
    ApproveBackfill: "reporting.pipeline.backfill.approve",
    RejectBackfill: "reporting.pipeline.backfill.approve",
    BindBackfill: "reporting.pipeline.backfill.manage",
    CompleteBackfill: "reporting.pipeline.backfill.manage",
    FailBackfill: "reporting.pipeline.backfill.manage",
    CancelBackfill: "reporting.pipeline.backfill.manage",
  } as const;
  const ports: PipelineRunPorts = {
    authorization: {
      async authorize(input) {
        return {
          tenantReference: id(1),
          tenantContext: tenant(input.observedAt),
          permission: {
            effect: "Allow",
            reason: "ROLE_PERMISSION",
            source: "RolePermission",
            action: permissionByAction[input.action],
            scopeKind: "Brand",
            policySnapshotReference: id(40),
            policyVersion: 1,
            audit: { effect: "Allow", reason: "ROLE_PERMISSION", source: "RolePermission" },
          },
          audit: {
            auditId: id(41),
            brandId: id(2),
            actor: { type: "User", reference: id(9) },
            actionCode: `REPORTING_PIPELINE_${input.action.toUpperCase()}`,
            targetType: input.action.includes("Backfill") ? "BackfillRequest" : "PipelineRun",
            targetId: input.targetReference,
            beforeSummary: {},
            afterSummary: {},
            reasonCode: "AUTHORIZED_OPERATION",
            correlationId: id(42),
            occurredAt: input.observedAt,
            sourceChannel: "API",
            dataClassification: "Internal",
            retentionPolicyCode: "AUDIT_DEFAULT",
            retentionPolicyVersion: 1,
          },
        } as never;
      },
    },
    references: { hashIntent: hash, equals: (left, right) => left === right },
    repository: {
      async resolveOperation(reference) {
        return operations.get(reference) ?? null;
      },
      async loadRun(reference) {
        return runs.get(reference) ?? null;
      },
      async loadRunByLogicalBatch(value) {
        return logicalBatches.get(value) ?? null;
      },
      async loadLatestRunState(reference) {
        return states.get(reference) ?? null;
      },
      async loadBackfill(reference) {
        return backfills.get(reference) ?? null;
      },
      async loadBackfillVersion(reference) {
        return backfillVersions.get(reference) ?? null;
      },
      async commitRun(input) {
        runs.set(input.run.runReference, input.run);
        logicalBatches.set(input.run.logicalBatchDigest, input.run);
        states.set(input.run.runReference, input.state);
        operations.set(input.operation.operationReference, input.operation);
        return input.operation;
      },
      async commitRunState(input) {
        states.set(input.state.runReference, input.state);
        operations.set(input.operation.operationReference, input.operation);
        return input.operation;
      },
      async commitBackfill(input) {
        backfills.set(input.request.requestReference, input.request);
        backfillVersions.set(input.request.requestVersionReference, input.request);
        operations.set(input.operation.operationReference, input.operation);
        return input.operation;
      },
    },
  };
  return { service: createPipelineRunService(ports), operations, runs, states };
}
const queued = (value: PipelineRunSnapshot = createPipelineRunSnapshot(run()), occurredAt = at) =>
  createPipelineRunStateSnapshot({
    ...state(),
    stateReference: id(30),
    runReference: value.runReference,
    sequence: 1,
    status: "Queued",
    watermarkOccurredAt: null,
    recordsRead: null,
    recordsWritten: null,
    recordsLate: null,
    recordsRejected: null,
    dataQualityResultReference: null,
    occurredAt,
  });

describe("Pipeline Run and Backfill contracts", () => {
  it("keeps run intent closed, version-pinned and replay classified", () => {
    expect(createPipelineRunSnapshot(run()).executionKind).toBe("Load");
    expect(() => createPipelineRunSnapshot({ ...run(), sql: "select private_data" })).toThrow();
    expect(() => createPipelineRunSnapshot({ ...run(), replay: true })).toThrow();
    expect(() =>
      createPipelineRunSnapshot({ ...run(), executionKind: "Backfill", replay: true }),
    ).toThrow();
  });

  it("requires exact terminal counts, quality evidence and bounded late/rejected records", () => {
    expect(createPipelineRunStateSnapshot(state()).recordsWritten).toBe("97");
    expect(() => createPipelineRunStateSnapshot({ ...state(), recordsRead: 100 })).toThrow();
    expect(() => createPipelineRunStateSnapshot({ ...state(), recordsLate: "101" })).toThrow();
    expect(() =>
      createPipelineRunStateSnapshot({ ...state(), dataQualityResultReference: null }),
    ).toThrow();
    expect(() =>
      createPipelineRunStateSnapshot({
        ...state(),
        watermarkOccurredAt: "2026-08-14T18:00:00.001Z",
      }),
    ).toThrow();
  });

  it("requires a distinct approver and rejects half-decisions", () => {
    expect(createBackfillRequestSnapshot(request()).lifecycle).toBe("Approved");
    expect(() =>
      createBackfillRequestSnapshot({ ...request(), decidedByActorReference: id(9) }),
    ).toThrow();
    expect(() => createBackfillRequestSnapshot({ ...request(), decidedAt: null })).toThrow();
    expect(() =>
      createBackfillRequestSnapshot({ ...request(), rangeUntil: "2026-08-14T18:00:00.001Z" }),
    ).toThrow();
  });

  it("pins retries to a prior run and preserves coherent cancelled audit history", () => {
    expect(
      createPipelineRunSnapshot({
        ...run(),
        executionKind: "Retry",
        replay: true,
        retryOfRunReference: id(15),
      }).retryOfRunReference,
    ).toBe(id(15));
    expect(() =>
      createPipelineRunSnapshot({ ...run(), executionKind: "Retry", replay: true }),
    ).toThrow();
    expect(createBackfillRequestSnapshot({ ...request(), lifecycle: "Cancelled" }).decidedAt).toBe(
      at,
    );
    expect(() =>
      createBackfillRequestSnapshot({
        ...request(),
        lifecycle: "Cancelled",
        decidedAt: null,
      }),
    ).toThrow();
  });

  it("records append-only lifecycle states and composes a minimal completion Event", async () => {
    const { service, operations } = workflowFixture();
    const pinnedRun = createPipelineRunSnapshot(run());
    await service.createRun({
      operationReference: ref(50),
      run: pinnedRun,
      initialState: queued(pinnedRun),
      occurredAt: at,
    });
    await service.advanceRun({
      operationReference: ref(51),
      expectedSequence: 1,
      state: createPipelineRunStateSnapshot({
        ...queued(pinnedRun),
        stateReference: id(31),
        sequence: 2,
        status: "Running",
        watermarkOccurredAt: at,
      }),
      occurredAt: at,
    });
    await service.advanceRun({
      operationReference: ref(52),
      expectedSequence: 2,
      state: createPipelineRunStateSnapshot({
        ...state(),
        stateReference: id(32),
        sequence: 3,
      }),
      occurredAt: at,
    });
    expect(operations.get(id(52))?.event?.eventType).toBe("AnalyticsLoadCompleted");
    await expect(
      service.advanceRun({
        operationReference: ref(53),
        expectedSequence: 3,
        state: createPipelineRunStateSnapshot({ ...state(), stateReference: id(33), sequence: 4 }),
        occurredAt: at,
      }),
    ).rejects.toMatchObject({ code: "PIPELINE_LIFECYCLE_CONFLICT" });
  });

  it("allows only a pinned retry of a failed logical batch", async () => {
    const { service, operations } = workflowFixture();
    const original = createPipelineRunSnapshot(run());
    await service.createRun({
      operationReference: ref(54),
      run: original,
      initialState: queued(original),
      occurredAt: at,
    });
    await service.advanceRun({
      operationReference: ref(55),
      expectedSequence: 1,
      state: createPipelineRunStateSnapshot({
        ...queued(original),
        stateReference: id(34),
        sequence: 2,
        status: "Running",
        watermarkOccurredAt: at,
      }),
      occurredAt: at,
    });
    await service.advanceRun({
      operationReference: ref(58),
      expectedSequence: 2,
      state: createPipelineRunStateSnapshot({
        ...state(),
        stateReference: id(35),
        sequence: 3,
        status: "Failed",
        dataQualityResultReference: null,
        errorReference: id(38),
      }),
      occurredAt: at,
    });
    const retry = createPipelineRunSnapshot({
      ...run(),
      runReference: id(36),
      executionKind: "Retry",
      replay: true,
      retryOfRunReference: original.runReference,
    });
    await service.createRun({
      operationReference: ref(56),
      run: retry,
      initialState: queued(retry),
      occurredAt: at,
    });
    expect(operations.get(id(56))?.action).toBe("CreateRun");
    await expect(
      service.createRun({
        operationReference: ref(57),
        run: createPipelineRunSnapshot({ ...run(), runReference: id(37) }),
        initialState: queued(createPipelineRunSnapshot({ ...run(), runReference: id(37) })),
        occurredAt: at,
      }),
    ).rejects.toMatchObject({ code: "PIPELINE_IDEMPOTENCY_CONFLICT" });
  });
});
