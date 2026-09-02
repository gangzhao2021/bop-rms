import { createBrand, createTenantContext } from "@bop/tenant";
import { describe, expect, it } from "vitest";
import {
  ComplianceCaseError,
  createComplianceCaseService,
  type ComplianceCaseOperationRecord,
  type ComplianceCasePorts,
  type ComplianceCaseSnapshot,
  type ComplianceContainmentRecord,
  type RegulatoryNotificationRecord,
} from "../index.js";

const id = (n: number) => `018f9930-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
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
  revision1: id(11),
  revision2: id(12),
  operation1: id(13),
  operation2: id(14),
  operation3: id(15),
  operation4: id(16),
  containment: id(17),
  ownerAction: id(18),
  releaseVerification: id(19),
  notification: id(20),
  authority: id(21),
  submission: id(22),
  closeEvidence: id(23),
};
const at = "2026-08-14T18:00:00.000Z";
const later = "2026-08-14T19:00:00.000Z";
const latest = "2026-08-14T20:00:00.000Z";
const scope = { tenantReference: ids.tenant, brandReference: ids.brand, storeReference: null };
function tenant(observedAt: string, actorReference = ids.actor) {
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
function candidate(options: Partial<ComplianceCaseSnapshot> = {}): ComplianceCaseSnapshot {
  return {
    caseReference: ids.case,
    revisionReference: ids.revision1,
    scope,
    aggregateVersion: 1,
    caseType: "FoodSafetyIncident",
    severity: "Critical",
    lifecycle: "Open",
    ownerReference: ids.owner,
    deadlineAt: latest,
    deadlineTimezone: "America/Toronto",
    primaryScope: { kind: "Store", reference: ids.brand, snapshotCode: "STORE_SCOPE" },
    supportingScopes: [],
    requirementVersionReferences: [ids.requirement],
    openedAt: at,
    openedByActorReference: ids.actor,
    cancellationReasonCode: null,
    closedAt: null,
    ...options,
  } as never;
}
function containment(
  options: Partial<ComplianceContainmentRecord> = {},
): ComplianceContainmentRecord {
  return {
    containmentReference: ids.containment,
    caseReference: ids.case,
    scope,
    sequence: 1,
    action: "StopSelling",
    hardBlock: true,
    targetScope: {
      kind: "ProductRecipeAllergen",
      reference: ids.brand,
      snapshotCode: "PRODUCT_SCOPE",
    },
    status: "Applied",
    ownerActionReference: ids.ownerAction,
    releaseVerificationReference: null,
    requestedAt: at,
    occurredAt: later,
    actorReference: ids.actor,
    ...options,
  } as never;
}
function notification(
  options: Partial<RegulatoryNotificationRecord> = {},
): RegulatoryNotificationRecord {
  return {
    notificationReference: ids.notification,
    caseReference: ids.case,
    scope,
    sequence: 1,
    authorityReference: ids.authority,
    requirementVersionReference: ids.requirement,
    deadlineAt: latest,
    status: "Required",
    submissionReference: null,
    basisCode: null,
    occurredAt: later,
    actorReference: ids.actor,
    ...options,
  } as never;
}
function fixture() {
  let aggregate: ComplianceCaseSnapshot | null = null;
  let latestContainment: ComplianceContainmentRecord | null = null;
  let latestNotification: RegulatoryNotificationRecord | null = null;
  const operations = new Map<string, ComplianceCaseOperationRecord>();
  let authorizingActor = ids.actor;
  const ports: ComplianceCasePorts = {
    authorization: {
      async authorize(input) {
        const permissionByAction = {
          Open: "compliance.case.manage",
          Assign: "compliance.case.assign",
          Transition: "compliance.case.manage",
          Escalate: "compliance.case.escalate",
          Cancel: "compliance.case.cancel",
          Close: "compliance.case.close",
          RecordContainment: "compliance.containment.record",
          RecordNotification: "compliance.notification.record",
        } as const;
        return {
          tenantReference: ids.tenant,
          tenantContext: tenant(input.observedAt, authorizingActor),
          permission: {
            effect: "Allow",
            reason: "ROLE_PERMISSION",
            source: "RolePermission",
            action: permissionByAction[input.action],
            scopeKind: "Brand",
            policySnapshotReference: ids.policy,
            policyVersion: 1,
            audit: { effect: "Allow", reason: "ROLE_PERMISSION", source: "RolePermission" },
          },
          audit: {
            auditId: ids.audit,
            brandId: ids.brand,
            actor: { type: "User", reference: authorizingActor },
            actionCode: `COMPLIANCE_CASE_${input.action.toUpperCase()}`,
            targetType: "ComplianceCase",
            targetId: input.caseReference,
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
      async load(reference) {
        return aggregate?.caseReference === reference ? aggregate : null;
      },
      async loadLatestContainment() {
        return latestContainment;
      },
      async loadLatestNotification() {
        return latestNotification;
      },
      async commit(input) {
        aggregate = input.operation.case;
        if (input.operation.containment !== null) latestContainment = input.operation.containment;
        if (input.operation.notification !== null)
          latestNotification = input.operation.notification;
        operations.set(input.operation.operationReference, input.operation);
        return input.operation;
      },
    },
  };
  return {
    service: createComplianceCaseService(ports),
    setActor(value: string) {
      authorizingActor = value;
    },
  };
}
const execute = (
  action: "Open" | "Assign" | "Transition" | "Escalate" | "Cancel" | "Close",
  operationReference: string,
  value: ComplianceCaseSnapshot,
  expectedAggregateVersion: number | null,
  occurredAt: string,
  closeGate: unknown | null = null,
) => ({
  action,
  operationReference,
  expectedAggregateVersion,
  candidate: value,
  purposeCode: "COMPLIANCE_CASE_MANAGEMENT",
  occurredAt,
  closeGate,
});

describe("WP-2171 Compliance Case", () => {
  it("opens once with strict scope, version and canonical Event", async () => {
    const { service } = fixture();
    const first = await service.execute(execute("Open", ids.operation1, candidate(), null, at));
    expect(first).toMatchObject({
      status: "Applied",
      case: { aggregateVersion: 1, lifecycle: "Open" },
    });
    await expect(
      service.execute(execute("Open", ids.operation1, candidate(), null, at)),
    ).resolves.toMatchObject({ status: "AlreadyApplied" });
  });
  it("emits only canonical lifecycle facts and never reopens a closed Case", async () => {
    const { service, setActor } = fixture();
    await service.execute(execute("Open", ids.operation1, candidate(), null, at));
    const verification = candidate({
      revisionReference: ids.revision2 as never,
      aggregateVersion: 2,
      lifecycle: "Verification",
    });
    await expect(
      service.execute(execute("Transition", ids.operation2, verification, 1, later)),
    ).resolves.toMatchObject({ case: { lifecycle: "Verification" } });
    setActor(ids.verifier);
    const closed = candidate({
      revisionReference: id(30) as never,
      aggregateVersion: 3,
      lifecycle: "Closed",
      closedAt: latest,
    });
    const gate = {
      caseReference: ids.case,
      aggregateVersion: 3,
      criticalFindingsReady: true,
      mandatoryActionsComplete: true,
      evidenceComplete: true,
      reinspectionComplete: true,
      regulatoryNotificationSatisfied: true,
      linkedDomainActionsValid: true,
      verifiedAt: latest,
      verifierReference: ids.verifier,
      evidenceReference: ids.closeEvidence,
    };
    await service.execute(execute("Close", ids.operation3, closed, 2, latest, gate));
    const reopen = candidate({
      revisionReference: id(31) as never,
      aggregateVersion: 4,
      lifecycle: "Open",
    });
    await expect(
      service.execute(execute("Transition", ids.operation4, reopen, 3, latest)),
    ).rejects.toMatchObject({ code: "COMPLIANCE_CASE_VERSION_CONFLICT" });
  });
  it("requires complete independent close gates for a Critical Case", async () => {
    const { service, setActor } = fixture();
    await service.execute(execute("Open", ids.operation1, candidate(), null, at));
    const verification = candidate({
      revisionReference: ids.revision2 as never,
      aggregateVersion: 2,
      lifecycle: "Verification",
    });
    await service.execute(execute("Transition", ids.operation2, verification, 1, later));
    const closed = candidate({
      revisionReference: id(32) as never,
      aggregateVersion: 3,
      lifecycle: "Closed",
      closedAt: latest,
    });
    setActor(ids.owner);
    const selfGate = {
      caseReference: ids.case,
      aggregateVersion: 3,
      criticalFindingsReady: true,
      mandatoryActionsComplete: true,
      evidenceComplete: true,
      reinspectionComplete: true,
      regulatoryNotificationSatisfied: true,
      linkedDomainActionsValid: true,
      verifiedAt: latest,
      verifierReference: ids.owner,
      evidenceReference: ids.closeEvidence,
    };
    await expect(
      service.execute(execute("Close", ids.operation3, closed, 2, latest, selfGate)),
    ).rejects.toMatchObject({ code: "COMPLIANCE_CASE_CLOSE_GATES_REQUIRED" });
  });
  it("does not let a narrow assignment command rewrite severity or scope", async () => {
    const { service } = fixture();
    await service.execute(execute("Open", ids.operation1, candidate(), null, at));
    const rewritten = candidate({
      revisionReference: ids.revision2 as never,
      aggregateVersion: 2,
      ownerReference: ids.verifier as never,
      severity: "Minor",
    });
    await expect(
      service.execute(execute("Assign", ids.operation2, rewritten, 1, later)),
    ).rejects.toMatchObject({ code: "COMPLIANCE_CASE_LIFECYCLE_CONFLICT" });
  });
  it("records owning-Domain containment outcomes and requires verified release", async () => {
    const { service } = fixture();
    await service.execute(execute("Open", ids.operation1, candidate(), null, at));
    const revised = candidate({ revisionReference: ids.revision2 as never, aggregateVersion: 2 });
    await service.recordContainment({
      operationReference: ids.operation2,
      expectedAggregateVersion: 1,
      case: revised,
      containment: containment(),
      purposeCode: "IMMEDIATE_CONTAINMENT",
      occurredAt: later,
    });
    const released = candidate({ revisionReference: id(33) as never, aggregateVersion: 3 });
    await expect(
      service.recordContainment({
        operationReference: ids.operation3,
        expectedAggregateVersion: 2,
        case: released,
        containment: containment({
          sequence: 2,
          status: "Released",
          ownerActionReference: ids.ownerAction as never,
          releaseVerificationReference: null,
          occurredAt: latest,
        }),
        purposeCode: "CONTAINMENT_RELEASE",
        occurredAt: latest,
      }),
    ).rejects.toBeInstanceOf(ComplianceCaseError);
    await expect(
      service.recordContainment({
        operationReference: ids.operation4,
        expectedAggregateVersion: 2,
        case: released,
        containment: containment({
          sequence: 2,
          status: "Released",
          ownerActionReference: ids.ownerAction as never,
          releaseVerificationReference: ids.releaseVerification as never,
          occurredAt: latest,
        }),
        purposeCode: "CONTAINMENT_RELEASE",
        occurredAt: latest,
      }),
    ).resolves.toMatchObject({ containment: { status: "Released" } });
  });
  it("never infers submission from a deadline and requires a basis for Not Required", async () => {
    const { service } = fixture();
    await service.execute(execute("Open", ids.operation1, candidate(), null, at));
    const revised = candidate({ revisionReference: ids.revision2 as never, aggregateVersion: 2 });
    await expect(
      service.recordNotification({
        operationReference: ids.operation2,
        expectedAggregateVersion: 1,
        case: revised,
        notification: notification({ status: "Submitted", submissionReference: null }),
        purposeCode: "REGULATORY_NOTIFICATION",
        occurredAt: later,
      }),
    ).rejects.toBeInstanceOf(ComplianceCaseError);
    await expect(
      service.recordNotification({
        operationReference: ids.operation3,
        expectedAggregateVersion: 1,
        case: revised,
        notification: notification({ status: "NotRequired", basisCode: null }),
        purposeCode: "REGULATORY_NOTIFICATION",
        occurredAt: later,
      }),
    ).rejects.toBeInstanceOf(ComplianceCaseError);
    await expect(
      service.recordNotification({
        operationReference: ids.operation4,
        expectedAggregateVersion: 1,
        case: revised,
        notification: notification({
          status: "Submitted",
          submissionReference: ids.submission as never,
        }),
        purposeCode: "REGULATORY_NOTIFICATION",
        occurredAt: later,
      }),
    ).resolves.toMatchObject({ notification: { status: "Submitted" } });
  });
});
