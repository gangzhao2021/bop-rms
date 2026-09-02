import { createBrand, createTenantContext } from "@bop/tenant";
import { describe, expect, it } from "vitest";
import {
  ComplianceInspectionActionError,
  createComplianceCorrectiveActionRecord,
  createComplianceFindingRecord,
  createComplianceInspectionActionService,
  type ComplianceCaseSnapshot,
  type ComplianceCorrectiveActionRecord,
  type ComplianceFindingRecord,
  type ComplianceInspectionActionOperation,
  type ComplianceInspectionActionPorts,
  type ComplianceInspectionRecord,
} from "../index.js";

const id = (n: number) => `018f9940-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const ids = {
  tenant: id(1),
  brand: id(2),
  actor: id(3),
  verifier: id(4),
  owner: id(5),
  policy: id(6),
  audit: id(7),
  correlation: id(8),
  case: id(9),
  requirement: id(10),
  caseRevision1: id(11),
  inspection: id(12),
  inspectionRevision1: id(13),
  inspectionRevision2: id(14),
  checklist: id(15),
  finding: id(16),
  findingRevision1: id(17),
  action: id(18),
  actionRevision1: id(19),
  actionRevision2: id(20),
  actionRevision3: id(21),
  actionRevision4: id(22),
  evidence: id(23),
  ownerOutcome: id(24),
  verificationEvidence: id(25),
  task: id(26),
};
const at = "2026-08-14T18:00:00.000Z";
const later = "2026-08-14T19:00:00.000Z";
const latest = "2026-08-14T20:00:00.000Z";
const tomorrow = "2026-08-15T20:00:00.000Z";
const scope = { tenantReference: ids.tenant, brandReference: ids.brand, storeReference: null };
function tenant(observedAt: string, actorReference: string) {
  return createTenantContext(
    {
      actorType: "User",
      actorReference,
      accountKind: "Workforce",
      status: "Active",
      authenticationMethod: "Oidc",
      verificationLevel: "SingleFactor",
      authenticatedAt: observedAt,
      recentMfaAt: null,
    } as never,
    createBrand({
      brandReference: ids.brand,
      code: "COMPLIANCE",
      displayName: "Synthetic Compliance Brand",
      defaultLocale: "en-CA",
      currencyCode: "CAD",
      lifecycle: "Active",
      version: 1,
      createdAt: at,
      updatedAt: at,
    }),
    null,
    observedAt,
  );
}
function caseAt(version: number): ComplianceCaseSnapshot {
  return {
    caseReference: ids.case,
    revisionReference: id(100 + version),
    scope,
    aggregateVersion: version,
    caseType: "FoodSafetyInspection",
    severity: "Critical",
    lifecycle: "CorrectiveAction",
    ownerReference: ids.owner,
    deadlineAt: tomorrow,
    deadlineTimezone: "America/Toronto",
    primaryScope: { kind: "Store", reference: ids.brand, snapshotCode: "STORE_SCOPE" },
    supportingScopes: [],
    requirementVersionReferences: [ids.requirement],
    openedAt: at,
    openedByActorReference: ids.actor,
    cancellationReasonCode: null,
    closedAt: null,
  } as never;
}
function inspection(options: Record<string, unknown> = {}): ComplianceInspectionRecord {
  return {
    inspectionReference: ids.inspection,
    revisionReference: ids.inspectionRevision1,
    priorRevisionReference: null,
    caseReference: ids.case,
    scope,
    aggregateVersion: 2,
    recordVersion: 1,
    inspectionType: "InternalSelfInspection",
    status: "Finalized",
    checklistVersionReference: ids.checklist,
    requirementVersionReference: ids.requirement,
    inspectionScope: { kind: "Store", reference: ids.brand, snapshotCode: "STORE_SCOPE" },
    inspectorReference: ids.actor,
    authorityReference: null,
    scheduledAt: at,
    startedAt: later,
    completedAt: latest,
    internalRatingCode: "PASS",
    authorityRatingCode: null,
    evidenceReferences: [ids.evidence],
    immediateActionCode: null,
    followUpRequirementCode: "FOLLOW_UP",
    changeReasonCode: null,
    recordedAt: latest,
    actorReference: ids.actor,
    ...options,
  } as never;
}
function finding(options: Record<string, unknown> = {}): ComplianceFindingRecord {
  return {
    findingReference: ids.finding,
    revisionReference: ids.findingRevision1,
    priorRevisionReference: null,
    caseReference: ids.case,
    scope,
    aggregateVersion: 2,
    recordVersion: 1,
    inspectionReference: null,
    requirementVersionReference: ids.requirement,
    hardRequirement: true,
    severity: "Critical",
    status: "Open",
    evidenceReferences: [ids.evidence],
    ownerActionReference: null,
    riskReviewAt: null,
    recordedAt: later,
    actorReference: ids.actor,
    ...options,
  } as never;
}
function action(options: Record<string, unknown> = {}): ComplianceCorrectiveActionRecord {
  return {
    actionReference: ids.action,
    revisionReference: ids.actionRevision1,
    priorRevisionReference: null,
    caseReference: ids.case,
    findingReference: ids.finding,
    scope,
    aggregateVersion: 2,
    recordVersion: 1,
    requirementVersionReference: ids.requirement,
    hardRequirement: true,
    severity: "Critical",
    requiredActionCode: "QUARANTINE_PRODUCT",
    ownerReference: ids.owner,
    dueAt: tomorrow,
    dueTimezone: "America/Toronto",
    priority: "Critical",
    status: "Planned",
    completionEvidenceReferences: [],
    ownerOutcomeReference: null,
    completedByActorReference: null,
    verifierReference: null,
    verificationResult: null,
    verificationEvidenceReference: null,
    conditionCode: null,
    conditionExpiresAt: null,
    reviewAt: null,
    followUpTaskReference: null,
    recordedAt: later,
    actorReference: ids.actor,
    ...options,
  } as never;
}
function fixture(withFinding = false) {
  let aggregate = caseAt(1);
  let actorReference = ids.actor;
  let latestInspection: ComplianceInspectionRecord | null = null;
  let latestFinding: ComplianceFindingRecord | null = withFinding ? finding() : null;
  let latestAction: ComplianceCorrectiveActionRecord | null = null;
  const operations = new Map<string, ComplianceInspectionActionOperation>();
  const committed: ComplianceInspectionActionOperation[] = [];
  const ports: ComplianceInspectionActionPorts = {
    authorization: {
      async authorize(input) {
        const permission = {
          RecordInspection: "compliance.inspection.record",
          CorrectInspection: "compliance.inspection.correct",
          RecordFinding: "compliance.finding.record",
          ChangeFinding: "compliance.finding.manage",
          AssignAction: "compliance.corrective-action.assign",
          AdvanceAction: "compliance.corrective-action.manage",
          VerifyAction: "compliance.corrective-action.verify",
        } as const;
        const targetType = input.command.includes("Inspection")
          ? "ComplianceInspection"
          : input.command.includes("Finding")
            ? "ComplianceFinding"
            : "ComplianceCorrectiveAction";
        return {
          tenantReference: ids.tenant,
          tenantContext: tenant(input.observedAt, actorReference),
          permission: {
            effect: "Allow",
            reason: "ROLE_PERMISSION",
            source: "RolePermission",
            action: permission[input.command],
            scopeKind: "Brand",
            policySnapshotReference: ids.policy,
            policyVersion: 1,
            audit: { effect: "Allow", reason: "ROLE_PERMISSION", source: "RolePermission" },
          },
          audit: {
            auditId: ids.audit,
            brandId: ids.brand,
            actor: { type: "User", reference: actorReference },
            actionCode: `COMPLIANCE_${input.command.toUpperCase()}`,
            targetType,
            targetId: input.targetReference,
            beforeSummary: {},
            afterSummary: {},
            reasonCode: "AUTHORIZED_OPERATION",
            correlationId: ids.correlation,
            occurredAt: input.observedAt,
            sourceChannel: "API",
            dataClassification: "Internal",
            retentionPolicyCode: "AUDIT_DEFAULT",
            retentionPolicyVersion: 1,
          },
        } as never;
      },
    },
    references: {
      hashIntent: (value) => `intent:${value}`,
      equals: (left, right) => left === right,
    },
    repository: {
      async resolveOperation(reference) {
        return operations.get(reference) ?? null;
      },
      async loadCase(reference) {
        return aggregate.caseReference === reference ? aggregate : null;
      },
      async loadLatestInspection() {
        return latestInspection;
      },
      async loadLatestFinding() {
        return latestFinding;
      },
      async loadLatestCorrectiveAction() {
        return latestAction;
      },
      async commit(input) {
        aggregate = input.operation.case;
        if (input.operation.inspection !== null) latestInspection = input.operation.inspection;
        if (input.operation.finding !== null) latestFinding = input.operation.finding;
        if (input.operation.correctiveAction !== null)
          latestAction = input.operation.correctiveAction;
        operations.set(input.operation.operationReference, input.operation);
        committed.push(input.operation);
        return input.operation;
      },
    },
  };
  return {
    service: createComplianceInspectionActionService(ports),
    committed,
    setActor(value: string) {
      actorReference = value;
    },
  };
}

describe("WP-2172 Compliance Inspection and Corrective Action", () => {
  it("finalizes an Inspection and appends a linked correction without rewriting the source", async () => {
    const f = fixture();
    const first = await f.service.recordInspection({
      command: "RecordInspection",
      operationReference: id(30),
      expectedAggregateVersion: 1,
      case: caseAt(2),
      inspection: inspection(),
      purposeCode: "FOOD_SAFETY",
      occurredAt: latest,
    });
    expect(first.status).toBe("Applied");
    const correction = inspection({
      revisionReference: ids.inspectionRevision2,
      priorRevisionReference: ids.inspectionRevision1,
      aggregateVersion: 3,
      recordVersion: 2,
      internalRatingCode: "PASS_CORRECTED",
      changeReasonCode: "RATING_TRANSCRIPTION",
      recordedAt: tomorrow,
    });
    await expect(
      f.service.recordInspection({
        command: "CorrectInspection",
        operationReference: id(31),
        expectedAggregateVersion: 2,
        case: caseAt(3),
        inspection: correction,
        purposeCode: "FOOD_SAFETY",
        occurredAt: tomorrow,
      }),
    ).resolves.toMatchObject({ status: "Applied" });
    expect(f.committed[0]?.inspection?.internalRatingCode).toBe("PASS");
    expect(f.committed[1]?.inspection?.priorRevisionReference).toBe(ids.inspectionRevision1);
    expect(f.committed.flatMap((item) => item.events)).toHaveLength(0);
  });

  it("rejects an ordinary transition that attempts to rewrite a finalized Inspection", async () => {
    const f = fixture();
    await f.service.recordInspection({
      command: "RecordInspection",
      operationReference: id(32),
      expectedAggregateVersion: 1,
      case: caseAt(2),
      inspection: inspection(),
      purposeCode: "FOOD_SAFETY",
      occurredAt: latest,
    });
    await expect(
      f.service.recordInspection({
        command: "RecordInspection",
        operationReference: id(33),
        expectedAggregateVersion: 2,
        case: caseAt(3),
        inspection: inspection({
          revisionReference: ids.inspectionRevision2,
          priorRevisionReference: ids.inspectionRevision1,
          recordVersion: 2,
          aggregateVersion: 3,
          changeReasonCode: "UNAUTHORIZED_REWRITE",
          recordedAt: tomorrow,
        }),
        purposeCode: "FOOD_SAFETY",
        occurredAt: tomorrow,
      }),
    ).rejects.toMatchObject({ code: "COMPLIANCE_RECORD_LIFECYCLE_CONFLICT" });
  });

  it("records a Critical Finding once and emits both accepted facts idempotently", async () => {
    const f = fixture();
    const input = {
      command: "RecordFinding" as const,
      operationReference: id(34),
      expectedAggregateVersion: 1,
      case: caseAt(2),
      finding: finding(),
      purposeCode: "FOOD_SAFETY",
      occurredAt: later,
    };
    await expect(f.service.recordFinding(input)).resolves.toMatchObject({ status: "Applied" });
    await expect(f.service.recordFinding(input)).resolves.toMatchObject({
      status: "AlreadyApplied",
    });
    expect(f.committed).toHaveLength(1);
    expect(f.committed[0]?.events.map((event) => event.eventType)).toEqual([
      "ComplianceFindingRecorded",
      "CriticalComplianceFindingDetected",
    ]);
  });

  it("prohibits Accepted Risk for a Hard Requirement and requires a review time otherwise", () => {
    expect(() =>
      createComplianceFindingRecord(
        finding({ hardRequirement: true, status: "AcceptedRisk", riskReviewAt: tomorrow }),
      ),
    ).toThrow();
    expect(() =>
      createComplianceFindingRecord(
        finding({ hardRequirement: false, status: "AcceptedRisk", riskReviewAt: null }),
      ),
    ).toThrow();
  });

  it("separates Completed from Verified and requires an independent high-risk verifier", async () => {
    const f = fixture(true);
    await f.service.recordCorrectiveAction({
      command: "AssignAction",
      operationReference: id(35),
      expectedAggregateVersion: 1,
      case: caseAt(2),
      correctiveAction: action(),
      purposeCode: "CORRECTIVE_ACTION",
      occurredAt: later,
    });
    const inProgress = action({
      revisionReference: ids.actionRevision2,
      priorRevisionReference: ids.actionRevision1,
      aggregateVersion: 3,
      recordVersion: 2,
      status: "InProgress",
      recordedAt: latest,
    });
    await f.service.recordCorrectiveAction({
      command: "AdvanceAction",
      operationReference: id(36),
      expectedAggregateVersion: 2,
      case: caseAt(3),
      correctiveAction: inProgress,
      purposeCode: "CORRECTIVE_ACTION",
      occurredAt: latest,
    });
    const completed = action({
      revisionReference: ids.actionRevision3,
      priorRevisionReference: ids.actionRevision2,
      aggregateVersion: 4,
      recordVersion: 3,
      status: "Completed",
      completionEvidenceReferences: [ids.evidence],
      ownerOutcomeReference: ids.ownerOutcome,
      completedByActorReference: ids.actor,
      recordedAt: tomorrow,
    });
    await f.service.recordCorrectiveAction({
      command: "AdvanceAction",
      operationReference: id(37),
      expectedAggregateVersion: 3,
      case: caseAt(4),
      correctiveAction: completed,
      purposeCode: "CORRECTIVE_ACTION",
      occurredAt: tomorrow,
    });
    const verified = action({
      revisionReference: ids.actionRevision4,
      priorRevisionReference: ids.actionRevision3,
      aggregateVersion: 5,
      recordVersion: 4,
      status: "Verified",
      completionEvidenceReferences: [ids.evidence],
      ownerOutcomeReference: ids.ownerOutcome,
      completedByActorReference: ids.actor,
      verifierReference: ids.actor,
      verificationResult: "Passed",
      verificationEvidenceReference: ids.verificationEvidence,
      recordedAt: tomorrow,
    });
    await expect(
      f.service.recordCorrectiveAction({
        command: "VerifyAction",
        operationReference: id(38),
        expectedAggregateVersion: 4,
        case: caseAt(5),
        correctiveAction: verified,
        purposeCode: "INDEPENDENT_VERIFICATION",
        occurredAt: tomorrow,
      }),
    ).rejects.toMatchObject({ code: "COMPLIANCE_RECORD_INDEPENDENT_VERIFIER_REQUIRED" });
    f.setActor(ids.verifier);
    await expect(
      f.service.recordCorrectiveAction({
        command: "VerifyAction",
        operationReference: id(39),
        expectedAggregateVersion: 4,
        case: caseAt(5),
        correctiveAction: {
          ...verified,
          actorReference: ids.verifier,
          verifierReference: ids.verifier,
        },
        purposeCode: "INDEPENDENT_VERIFICATION",
        occurredAt: tomorrow,
      }),
    ).resolves.toMatchObject({ status: "Applied" });
    expect(f.committed.at(-2)?.events[0]?.eventType).toBe("CorrectiveActionCompleted");
    expect(f.committed.at(-1)?.events[0]?.eventType).toBe("CorrectiveActionVerified");
  });

  it("keeps Unable to Verify nonterminal and requires a follow-up Task", () => {
    const base = action({
      revisionReference: ids.actionRevision4,
      priorRevisionReference: ids.actionRevision3,
      aggregateVersion: 5,
      recordVersion: 4,
      status: "Completed",
      completionEvidenceReferences: [ids.evidence],
      ownerOutcomeReference: ids.ownerOutcome,
      completedByActorReference: ids.actor,
      verifierReference: ids.verifier,
      verificationResult: "UnableToVerify",
      verificationEvidenceReference: ids.verificationEvidence,
      actorReference: ids.verifier,
    });
    expect(() => createComplianceCorrectiveActionRecord(base)).toThrow();
    expect(
      createComplianceCorrectiveActionRecord({ ...base, followUpTaskReference: ids.task }).status,
    ).toBe("Completed");
  });

  it("fails closed on stale Case versions before authorization or append", async () => {
    const f = fixture();
    await expect(
      f.service.recordFinding({
        command: "RecordFinding",
        operationReference: id(40),
        expectedAggregateVersion: 9,
        case: caseAt(2),
        finding: finding(),
        purposeCode: "FOOD_SAFETY",
        occurredAt: later,
      }),
    ).rejects.toBeInstanceOf(ComplianceInspectionActionError);
    expect(f.committed).toHaveLength(0);
  });
});
