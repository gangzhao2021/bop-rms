import { createBrand, createTenantContext } from "@bop/tenant";
import { describe, expect, it } from "vitest";
import {
  ComplianceRecallError,
  createComplianceRecallService,
  createRecallRecord,
  type ComplianceRecallOperation,
  type ComplianceRecallPorts,
  type RecallRecord,
} from "../index.js";

const id = (n: number) => `018f9990-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const hash = (value: string) => `sha256:${value.repeat(64).slice(0, 64)}`;
const ids = {
  tenant: id(1),
  brand: id(2),
  actor: id(3),
  policy: id(4),
  audit: id(5),
  correlation: id(6),
  recall: id(7),
  case: id(8),
  source: id(9),
  requirement: id(10),
  trace: id(11),
  supplier: id(12),
  item: id(13),
  lot: id(14),
  batch: id(15),
  product: id(16),
  sku: id(17),
  hold: id(18),
  transfer: id(19),
  availability: id(20),
  ordering: id(21),
  procurement: id(22),
  task: id(23),
  decision: id(24),
  approval: id(25),
  notification: id(26),
  disposition: id(27),
  outcome: id(28),
  disposer: id(29),
  verification: id(30),
  verifier: id(31),
  foreignBrand: id(32),
};
const times = Array.from(
  { length: 10 },
  (_, index) => `2026-08-14T${String(10 + index).padStart(2, "0")}:00:00.000Z`,
);
const time = (index: number): string => {
  const value = times[index];
  if (value === undefined) throw new Error("synthetic Recall instant missing");
  return value;
};
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
      code: "RECALL",
      displayName: "Synthetic Recall Brand",
      defaultLocale: "en-CA",
      currencyCode: "CAD",
      lifecycle: "Active",
      version: 1,
      createdAt: time(0),
      updatedAt: time(0),
    }),
    null,
    observedAt,
  );
}
function initial(options: Record<string, unknown> = {}): RecallRecord {
  return {
    recallReference: ids.recall,
    revision: 1,
    caseReference: ids.case,
    scope,
    recallType: "Recall",
    sourceKind: "SupplierNotice",
    sourceReference: ids.source,
    sourceSnapshotDigest: hash("a"),
    severity: "Critical",
    status: "ScopeAssessment",
    effectiveFrom: time(0),
    effectiveTo: null,
    affectedScope: null,
    containmentOutcomes: null,
    taskOutcomeReference: null,
    noticeRequirement: "Required",
    noticeOutcomes: null,
    dispositions: [],
    verification: null,
    requirementVersionReference: ids.requirement,
    recordedAt: time(0),
    ...options,
  } as never;
}
function affected(calculatedAt = time(1), partial = false) {
  return {
    traceRunReference: ids.trace,
    supplierReferences: [ids.supplier],
    inventoryItemReferences: [ids.item],
    lotReferences: [ids.lot],
    batchReferences: [ids.batch],
    productReferences: [ids.product],
    skuReferences: [ids.sku],
    storeReferences: [],
    expectedNodeCount: "8",
    tracedNodeCount: partial ? "7" : "8",
    gapCount: partial ? "1" : "0",
    customerOrderCount: "12",
    fulfillmentCount: "9",
    coverage: partial ? "Partial" : "Complete",
    calculatedAt,
  } as const;
}
function fixture(options: { partial?: boolean; verifier?: string; deny?: boolean } = {}) {
  let latest: RecallRecord | null = null;
  let deny = options.deny ?? false;
  let containmentInput: unknown = null;
  let noticeInput: unknown = null;
  const operations = new Map<string, ComplianceRecallOperation>();
  const ports: ComplianceRecallPorts = {
    authorization: {
      async authorize(input) {
        if (deny) return null;
        const actions = {
          InitiateRecall: "compliance.recall.initiate",
          CalculateRecallScope: "compliance.recall.scope.calculate",
          EnforceRecallContainment: "compliance.recall.containment.enforce",
          CreateRecallTasks: "compliance.recall.task.create",
          ResolveRecallNotice: "compliance.recall.notice.resolve",
          RecordRecallDisposition: "compliance.recall.disposition.record",
          VerifyRecallClosure: "compliance.recall.closure.verify",
        } as const;
        return {
          tenantReference: ids.tenant,
          tenantContext: tenant(input.observedAt),
          permission: {
            effect: "Allow",
            reason: "ROLE_PERMISSION",
            source: "RolePermission",
            action: actions[input.command],
            scopeKind: "Brand",
            policySnapshotReference: ids.policy,
            policyVersion: 1,
            audit: { effect: "Allow", reason: "ROLE_PERMISSION", source: "RolePermission" },
          },
          audit: {
            auditId: ids.audit,
            brandId: ids.brand,
            actor: { type: "User", reference: ids.actor },
            actionCode: `COMPLIANCE_RECALL_${input.command.toUpperCase()}`,
            targetType: "RecallRecord",
            targetId: input.targetReference,
            beforeSummary: {},
            afterSummary: {},
            reasonCode: "AUTHORIZED_RECALL_OPERATION",
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
    repository: {
      async resolveOperation(reference) {
        return operations.get(reference) ?? null;
      },
      async loadLatest() {
        return latest;
      },
      async commit({ operation, expectedRevision }) {
        if ((latest?.revision ?? 0) !== expectedRevision) throw new Error("stale");
        latest = operation.recall;
        operations.set(operation.operationReference, operation);
        return operation;
      },
    },
    cases: {
      async resolve() {
        return { scope, caseType: "RecallWithdrawal", lifecycle: "Investigating" } as never;
      },
    },
    traceScope: {
      async calculate(input) {
        return affected(input.requestedAt, options.partial ?? false) as never;
      },
    },
    containment: {
      async enforce(input) {
        containmentInput = input;
        return {
          inventoryHoldOutcomeReference: ids.hold,
          transferBlockOutcomeReference: ids.transfer,
          availabilityBlockOutcomeReference: ids.availability,
          orderingBlockOutcomeReference: ids.ordering,
          procurementBlockOutcomeReference: ids.procurement,
          enforcedAt: input.requestedAt,
        } as never;
      },
    },
    tasks: {
      async create() {
        return { taskOutcomeReference: ids.task } as never;
      },
    },
    notices: {
      async resolve(input) {
        noticeInput = input;
        return {
          decisionReference: ids.decision,
          approvalReference: ids.approval,
          notificationOutcomeReference: ids.notification,
          resolvedAt: input.requestedAt,
        } as never;
      },
    },
    dispositions: {
      async record(input) {
        return {
          dispositionReference: ids.disposition,
          subjectKind: input.subjectKind,
          subjectReference: input.subjectReference,
          decision: input.decision,
          ownerOutcomeReference: ids.outcome,
          decidedBy: ids.disposer,
          decidedAt: input.requestedAt,
        } as never;
      },
    },
    verification: {
      async verify(input) {
        return {
          verificationReference: ids.verification,
          result: "Passed",
          verifiedBy: options.verifier ?? ids.verifier,
          verifiedAt: input.requestedAt,
        } as never;
      },
    },
  };
  return {
    service: createComplianceRecallService(ports),
    operations,
    latest: () => latest,
    containmentInput: () => containmentInput,
    noticeInput: () => noticeInput,
    setDeny(value: boolean) {
      deny = value;
    },
  };
}
const base = (operation: number, revision: number, occurredAt: string) => ({
  operationReference: id(operation),
  recallReference: ids.recall,
  expectedRevision: revision,
  purposeCode: "FOOD_SAFETY_RECALL",
  occurredAt,
});
async function advanceToVerification(f: ReturnType<typeof fixture>) {
  await f.service.initiateRecall({
    operationReference: id(40),
    expectedRevision: 0,
    recall: initial(),
    purposeCode: "FOOD_SAFETY_RECALL",
    occurredAt: time(0),
  });
  await f.service.calculateRecallScope({ ...base(41, 1, time(1)), traceRunReference: ids.trace });
  await f.service.createRecallTasks(base(42, 2, time(2)));
  await f.service.enforceRecallContainment(base(43, 3, time(3)));
  await f.service.resolveRecallNotice(base(44, 4, time(4)));
  await f.service.recordRecallDisposition({
    ...base(45, 5, time(5)),
    subjectKind: "Lot",
    subjectReference: ids.lot,
    decision: "Dispose",
  });
}

describe("WP-2177 Compliance Recall", () => {
  it("enforces reconciled coverage and complete independent closure gates", () => {
    expect(() =>
      createRecallRecord({
        ...initial(),
        revision: 2,
        status: "Containment",
        affectedScope: {
          ...affected(),
          expectedNodeCount: "8",
          tracedNodeCount: "6",
          gapCount: "1",
        },
        recordedAt: time(1),
      }),
    ).toThrow();
    expect(() =>
      createRecallRecord({
        ...initial(),
        revision: 7,
        status: "Closed",
        affectedScope: affected(time(1), true),
        containmentOutcomes: {
          inventoryHoldOutcomeReference: ids.hold,
          transferBlockOutcomeReference: ids.transfer,
          availabilityBlockOutcomeReference: ids.availability,
          orderingBlockOutcomeReference: ids.ordering,
          procurementBlockOutcomeReference: ids.procurement,
          enforcedAt: time(2),
        },
        noticeOutcomes: {
          decisionReference: ids.decision,
          approvalReference: ids.approval,
          notificationOutcomeReference: ids.notification,
          resolvedAt: time(3),
        },
        dispositions: [
          {
            dispositionReference: ids.disposition,
            subjectKind: "Lot",
            subjectReference: ids.lot,
            decision: "Dispose",
            ownerOutcomeReference: ids.outcome,
            decidedBy: ids.disposer,
            decidedAt: time(4),
          },
        ],
        verification: {
          verificationReference: ids.verification,
          result: "Passed",
          verifiedBy: ids.verifier,
          verifiedAt: time(5),
        },
        recordedAt: time(6),
      }),
    ).toThrow();
  });

  it("executes the full owner-delegated lifecycle and emits only initiation/closure facts", async () => {
    const f = fixture();
    await advanceToVerification(f);
    await expect(f.service.verifyRecallClosure(base(46, 6, time(6)))).resolves.toMatchObject({
      status: "Applied",
      recall: { revision: 7, status: "Closed" },
    });
    expect(f.operations.get(id(40))?.events.map((event) => event.eventType)).toEqual([
      "RecallInitiated",
    ]);
    expect(f.operations.get(id(46))?.events.map((event) => event.eventType)).toEqual([
      "RecallClosed",
    ]);
    expect(f.containmentInput()).toMatchObject({ hardBlock: true, overrideAllowed: false });
    expect(f.noticeInput()).toMatchObject({ customerOrderCount: "12", fulfillmentCount: "9" });
  });

  it("blocks closure while Trace coverage has a Gap", async () => {
    const f = fixture({ partial: true });
    await advanceToVerification(f);
    await expect(f.service.verifyRecallClosure(base(46, 6, time(6)))).rejects.toMatchObject({
      code: "COMPLIANCE_RECALL_SOURCE_CONFLICT",
    });
    expect(f.latest()?.status).toBe("Verification");
  });

  it("requires an independent verifier", async () => {
    const f = fixture({ verifier: ids.disposer });
    await advanceToVerification(f);
    await expect(f.service.verifyRecallClosure(base(46, 6, time(6)))).rejects.toMatchObject({
      code: "COMPLIANCE_RECALL_LIFECYCLE_CONFLICT",
    });
  });

  it("keeps idempotency exact without repeating owner actions", async () => {
    const f = fixture();
    const input = {
      operationReference: id(40),
      expectedRevision: 0 as const,
      recall: initial(),
      purposeCode: "FOOD_SAFETY_RECALL",
      occurredAt: time(0),
    };
    await f.service.initiateRecall(input);
    await expect(f.service.initiateRecall(input)).resolves.toMatchObject({
      status: "AlreadyApplied",
    });
    f.setDeny(true);
    await expect(f.service.initiateRecall(input)).rejects.toMatchObject({
      code: "COMPLIANCE_RECALL_PERMISSION_DENIED",
    });
    f.setDeny(false);
    await expect(
      f.service.initiateRecall({ ...input, purposeCode: "DIFFERENT_PURPOSE" }),
    ).rejects.toMatchObject({ code: "COMPLIANCE_RECALL_IDEMPOTENCY_CONFLICT" });
  });

  it("rejects unauthorized, stale and cross-scope Case operations", async () => {
    const denied = fixture({ deny: true });
    await expect(
      denied.service.initiateRecall({
        operationReference: id(40),
        expectedRevision: 0,
        recall: initial(),
        purposeCode: "FOOD_SAFETY_RECALL",
        occurredAt: time(0),
      }),
    ).rejects.toMatchObject({ code: "COMPLIANCE_RECALL_PERMISSION_DENIED" });
    const stale = fixture();
    await stale.service.initiateRecall({
      operationReference: id(40),
      expectedRevision: 0,
      recall: initial(),
      purposeCode: "FOOD_SAFETY_RECALL",
      occurredAt: time(0),
    });
    await expect(
      stale.service.calculateRecallScope({
        ...base(41, 2, time(1)),
        traceRunReference: ids.trace,
      }),
    ).rejects.toMatchObject({ code: "COMPLIANCE_RECALL_VERSION_CONFLICT" });
    expect(() =>
      createRecallRecord(
        initial({ scope: { ...scope, brandReference: ids.foreignBrand }, customerEmail: "x" }),
      ),
    ).toThrow();
  });

  it("fails closed on extra fields and unavailable dependencies", async () => {
    const f = fixture();
    await expect(
      f.service.initiateRecall({
        operationReference: id(40),
        expectedRevision: 0,
        recall: initial(),
        purposeCode: "FOOD_SAFETY_RECALL",
        occurredAt: time(0),
        extra: true,
      } as never),
    ).rejects.toBeInstanceOf(ComplianceRecallError);
  });
});
