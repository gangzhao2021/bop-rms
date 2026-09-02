import { createBrand, createTenantContext } from "@bop/tenant";
import { describe, expect, it } from "vitest";
import {
  ComplianceTraceabilityError,
  createComplianceTraceabilityService,
  createTraceRun,
  type ComplianceTraceabilityOperation,
  type ComplianceTraceabilityPorts,
  type TraceEvidenceSet,
  type TraceRun,
} from "../index.js";

const id = (n: number) => `018f9980-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const hash = (value: string) => `sha256:${value.repeat(64).slice(0, 64)}`;
const ids = {
  tenant: id(1),
  brand: id(2),
  actor: id(3),
  policy: id(4),
  audit: id(5),
  correlation: id(6),
  run: id(7),
  supplierNode: id(8),
  supplier: id(9),
  poNode: id(10),
  po: id(11),
  receiptNode: id(12),
  receipt: id(13),
  lotNode: id(14),
  lot: id(15),
  edge1: id(16),
  edge2: id(17),
  edge3: id(18),
  gap: id(19),
  projection: id(20),
  evidenceSet: id(21),
  retention: id(22),
  case: id(23),
  artifact: id(24),
  recall: id(25),
  operation2: id(26),
  operation3: id(27),
  foreignBrand: id(28),
};
const from = "2026-08-14T16:00:00.000Z";
const to = "2026-08-14T17:00:00.000Z";
const requested = "2026-08-14T18:00:00.000Z";
const completed = "2026-08-14T18:00:01.000Z";
const later = "2026-08-14T19:00:00.000Z";
const scope = { tenantReference: ids.tenant, brandReference: ids.brand, storeReference: null };
function tenant(observedAt: string) {
  return createTenantContext(
    {
      actorType: "User",
      actorReference: ids.actor,
      accountKind: "Workforce",
      status: "Active",
      authenticationMethod: "Oidc",
      verificationLevel: "SingleFactor",
      authenticatedAt: observedAt,
      recentMfaAt: null,
    } as never,
    createBrand({
      brandReference: ids.brand,
      code: "TRACE",
      displayName: "Synthetic Trace Brand",
      defaultLocale: "en-CA",
      currencyCode: "CAD",
      lifecycle: "Active",
      version: 1,
      createdAt: from,
      updatedAt: from,
    }),
    null,
    observedAt,
  );
}
function node(
  nodeReference: string,
  sourceReference: string,
  kind: "Supplier" | "PurchaseOrder" | "GoodsReceipt" | "Lot",
  ownerDomain: "Procurement" | "Inventory",
) {
  return {
    nodeReference,
    kind,
    sourceReference,
    ownerDomain,
    scope,
    occurredAt: "2026-08-14T16:30:00.000Z",
    snapshotDigest: hash("a"),
    accessClass: "Internal",
  };
}
function run(options: Record<string, unknown> = {}): TraceRun {
  return {
    runReference: ids.run,
    scope,
    criteria: {
      direction: "Forward",
      seedKind: "Supplier",
      seedReference: ids.supplier,
      periodFrom: from,
      periodTo: to,
    },
    requestedAt: requested,
    completedAt: completed,
    sourceAsOf: "2026-08-14T17:59:59.000Z",
    projectionVersionReference: ids.projection,
    completeness: "Complete",
    nodes: [
      node(ids.supplierNode, ids.supplier, "Supplier", "Procurement"),
      node(ids.poNode, ids.po, "PurchaseOrder", "Procurement"),
      node(ids.receiptNode, ids.receipt, "GoodsReceipt", "Inventory"),
      node(ids.lotNode, ids.lot, "Lot", "Inventory"),
    ],
    edges: [
      {
        edgeReference: ids.edge1,
        fromNodeReference: ids.supplierNode,
        toNodeReference: ids.poNode,
        relationship: "SuppliedOn",
        occurredAt: "2026-08-14T16:31:00.000Z",
      },
      {
        edgeReference: ids.edge2,
        fromNodeReference: ids.poNode,
        toNodeReference: ids.receiptNode,
        relationship: "ReceivedAs",
        occurredAt: "2026-08-14T16:32:00.000Z",
      },
      {
        edgeReference: ids.edge3,
        fromNodeReference: ids.receiptNode,
        toNodeReference: ids.lotNode,
        relationship: "IdentifiedAsLot",
        occurredAt: "2026-08-14T16:33:00.000Z",
      },
    ],
    gaps: [],
    ...options,
  } as never;
}
function evidenceSet(options: Record<string, unknown> = {}): TraceEvidenceSet {
  return {
    evidenceSetReference: ids.evidenceSet,
    revision: 1,
    scope,
    caseReference: ids.case,
    runReference: ids.run,
    nodeReferences: [ids.supplierNode, ids.poNode],
    edgeReferences: [ids.edge1],
    gapReferences: [],
    retentionPolicyReference: ids.retention,
    legalHold: false,
    accessClass: "Restricted",
    createdBy: ids.actor,
    createdAt: later,
    ...options,
  } as never;
}
function fixture() {
  let deny = false;
  let traceRun = run();
  let latestEvidenceSet: TraceEvidenceSet | null = null;
  let artifactCalls = 0;
  let recallCalls = 0;
  const operations = new Map<string, ComplianceTraceabilityOperation>();
  const authorizationBase = (action: string, observedAt: string) => ({
    tenantReference: ids.tenant,
    tenantContext: tenant(observedAt),
    permission: {
      effect: "Allow",
      reason: "ROLE_PERMISSION",
      source: "RolePermission",
      action,
      scopeKind: "Brand",
      policySnapshotReference: ids.policy,
      policyVersion: 1,
      audit: { effect: "Allow", reason: "ROLE_PERMISSION", source: "RolePermission" },
    },
  });
  const ports: ComplianceTraceabilityPorts = {
    authorization: {
      async authorizeQuery(input) {
        return deny
          ? null
          : (authorizationBase("compliance.traceability.view", input.observedAt) as never);
      },
      async authorizeCommand(input) {
        if (deny) return null;
        const actions = {
          PinEvidenceSet: "compliance.traceability.evidence.pin",
          ExportEvidenceSet: "compliance.traceability.evidence.export",
          OpenRecallFromTrace: "compliance.recall.open",
        } as const;
        const targetType =
          input.command === "OpenRecallFromTrace" ? "TraceRun" : "TraceEvidenceSet";
        return {
          ...authorizationBase(actions[input.command], input.observedAt),
          audit: {
            auditId: ids.audit,
            brandId: ids.brand,
            actor: { type: "User", reference: ids.actor },
            actionCode: `COMPLIANCE_TRACEABILITY_${input.command.toUpperCase()}`,
            targetType,
            targetId: input.targetReference,
            beforeSummary: {},
            afterSummary: {},
            reasonCode: "AUTHORIZED_TRACE_OPERATION",
            correlationId: ids.correlation,
            occurredAt: input.observedAt,
            sourceChannel: "API",
            dataClassification: "Restricted",
            retentionPolicyCode: "COMPLIANCE_RESTRICTED",
            retentionPolicyVersion: 1,
          },
        } as never;
      },
    },
    references: { hashIntent: (value) => `intent:${value}`, equals: (a, b) => a === b },
    traceProjection: {
      async run() {
        return traceRun;
      },
      async loadRun() {
        return traceRun;
      },
    },
    cases: {
      async resolve() {
        return { scope, lifecycle: "Investigating", accessClass: "Restricted" } as never;
      },
    },
    repository: {
      async resolveOperation(reference) {
        return operations.get(reference) ?? null;
      },
      async loadEvidenceSet() {
        return latestEvidenceSet;
      },
      async commit({ operation, expectedRevision }) {
        if (operation.evidenceSet !== null) {
          if ((latestEvidenceSet?.revision ?? 0) !== expectedRevision) throw new Error("stale");
          latestEvidenceSet = operation.evidenceSet;
        }
        operations.set(operation.operationReference, operation);
        return operation;
      },
    },
    artifacts: {
      async exportRestricted(input) {
        artifactCalls += 1;
        return {
          exportOperationReference: input.operationReference,
          evidenceSetReference: input.evidenceSet.evidenceSetReference,
          caseReference: input.caseReference,
          artifactReference: ids.artifact,
          artifactDigest: hash("f"),
          recordedAt: input.requestedAt,
          accessClass: "Restricted",
        } as never;
      },
    },
    recalls: {
      async openFromTrace(input) {
        recallCalls += 1;
        return {
          requestReference: input.operationReference,
          runReference: input.run.runReference,
          recallReference: ids.recall,
          recordedAt: input.requestedAt,
        } as never;
      },
    },
  };
  return {
    service: createComplianceTraceabilityService(ports),
    operations,
    setDeny(value: boolean) {
      deny = value;
    },
    setRun(value: TraceRun) {
      traceRun = value;
    },
    setEvidenceSet(value: TraceEvidenceSet | null) {
      latestEvidenceSet = value;
    },
    artifactCalls: () => artifactCalls,
    recallCalls: () => recallCalls,
  };
}
const queryInput = () => ({
  operationReference: ids.run,
  scope,
  criteria: run().criteria,
  purposeCode: "FOOD_SAFETY_TRACE",
  observedAt: requested,
});

describe("WP-2176 compliance traceability", () => {
  it("accepts a bounded canonical chain and rejects invented topology or unrestricted Customer nodes", () => {
    expect(createTraceRun(run()).edges).toHaveLength(3);
    expect(() =>
      createTraceRun(
        run({
          edges: [
            {
              ...run().edges[0],
              relationship: "CompletedByFulfillment",
            },
          ],
        }),
      ),
    ).toThrow();
    expect(() =>
      createTraceRun(
        run({
          nodes: [
            ...run().nodes,
            {
              ...node(id(40), id(41), "Lot", "Inventory"),
              kind: "Customer",
              ownerDomain: "Customer",
              accessClass: "Internal",
            },
          ],
        }),
      ),
    ).toThrow();
  });

  it("requires every incomplete segment to be an explicit Gap", () => {
    const gap = {
      gapReference: ids.gap,
      adjacentNodeReference: ids.lotNode,
      expectedKind: "InventoryMovement",
      direction: "Forward",
      reason: "MissingSource",
      detectedAt: completed,
    };
    expect(createTraceRun(run({ completeness: "Partial", gaps: [gap] })).gaps).toEqual([gap]);
    expect(() => createTraceRun(run({ completeness: "Complete", gaps: [gap] }))).toThrow();
    expect(() => createTraceRun(run({ completeness: "Partial", gaps: [] }))).toThrow();
  });

  it("runs an authorized exact-scope query and rejects permission or projection drift", async () => {
    const f = fixture();
    await expect(f.service.query(queryInput())).resolves.toMatchObject({
      runReference: ids.run,
      projectionVersionReference: ids.projection,
      completeness: "Complete",
    });
    f.setDeny(true);
    await expect(f.service.query(queryInput())).rejects.toMatchObject({
      code: "COMPLIANCE_TRACEABILITY_PERMISSION_DENIED",
    });
    f.setDeny(false);
    f.setRun(run({ scope: { ...scope, brandReference: ids.foreignBrand } }));
    await expect(f.service.query(queryInput())).rejects.toMatchObject({
      code: "COMPLIANCE_TRACEABILITY_SOURCE_CONFLICT",
    });
  });

  it("pins only references present in the authorized Run and exact active Case", async () => {
    const f = fixture();
    await expect(
      f.service.pinEvidenceSet({
        operationReference: ids.operation2,
        expectedRevision: 0,
        evidenceSet: evidenceSet(),
        purposeCode: "FOOD_SAFETY_EVIDENCE",
        observedAt: later,
      }),
    ).resolves.toMatchObject({ status: "Applied", evidenceSet: { accessClass: "Restricted" } });
    const invalid = fixture();
    await expect(
      invalid.service.pinEvidenceSet({
        operationReference: ids.operation2,
        expectedRevision: 0,
        evidenceSet: evidenceSet({ nodeReferences: [id(99)] }),
        purposeCode: "FOOD_SAFETY_EVIDENCE",
        observedAt: later,
      }),
    ).rejects.toMatchObject({ code: "COMPLIANCE_TRACEABILITY_SOURCE_CONFLICT" });
  });

  it("keeps command idempotency exact and detects operation reuse", async () => {
    const f = fixture();
    const input = {
      operationReference: ids.operation2,
      expectedRevision: 0 as const,
      evidenceSet: evidenceSet(),
      purposeCode: "FOOD_SAFETY_EVIDENCE",
      observedAt: later,
    };
    await f.service.pinEvidenceSet(input);
    await expect(f.service.pinEvidenceSet(input)).resolves.toMatchObject({
      status: "AlreadyApplied",
    });
    await expect(
      f.service.pinEvidenceSet({ ...input, purposeCode: "DIFFERENT_PURPOSE" }),
    ).rejects.toMatchObject({ code: "COMPLIANCE_TRACEABILITY_IDEMPOTENCY_CONFLICT" });
  });

  it("exports only an exact pinned restricted Evidence Set and returns an opaque receipt", async () => {
    const f = fixture();
    f.setEvidenceSet(evidenceSet());
    await expect(
      f.service.exportEvidenceSet({
        operationReference: ids.operation2,
        scope,
        evidenceSetReference: ids.evidenceSet,
        caseReference: ids.case,
        expectedRevision: 1,
        purposeCode: "REGULATORY_CASE_EXPORT",
        observedAt: later,
      }),
    ).resolves.toMatchObject({
      status: "Applied",
      exportReceipt: { artifactReference: ids.artifact, accessClass: "Restricted" },
    });
    expect(f.artifactCalls()).toBe(1);
    await expect(
      f.service.exportEvidenceSet({
        operationReference: ids.operation3,
        scope,
        evidenceSetReference: ids.evidenceSet,
        caseReference: ids.case,
        expectedRevision: 2,
        purposeCode: "REGULATORY_CASE_EXPORT",
        observedAt: later,
      }),
    ).rejects.toMatchObject({ code: "COMPLIANCE_TRACEABILITY_VERSION_CONFLICT" });
  });

  it("delegates Recall opening without creating Recall lifecycle facts", async () => {
    const f = fixture();
    await expect(
      f.service.openRecallFromTrace({
        operationReference: ids.operation3,
        scope,
        runReference: ids.run,
        caseReference: ids.case,
        purposeCode: "FOOD_SAFETY_RECALL",
        observedAt: later,
      }),
    ).resolves.toMatchObject({
      status: "Applied",
      recallOutcome: { recallReference: ids.recall, runReference: ids.run },
    });
    expect(f.recallCalls()).toBe(1);
  });

  it("fails closed on malformed input and unavailable dependencies", async () => {
    const f = fixture();
    await expect(f.service.query({ ...queryInput(), extra: true } as never)).rejects.toBeInstanceOf(
      ComplianceTraceabilityError,
    );
    f.setRun(null as never);
    await expect(f.service.query(queryInput())).rejects.toMatchObject({
      code: "COMPLIANCE_TRACEABILITY_DEPENDENCY_UNAVAILABLE",
    });
  });
});
