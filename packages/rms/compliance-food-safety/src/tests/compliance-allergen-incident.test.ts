import { createBrand, createTenantContext } from "@bop/tenant";
import { describe, expect, it } from "vitest";
import {
  createAllergenControlReview,
  createComplianceAllergenIncidentService,
  createFoodSafetyIncidentRecord,
  type AllergenControlReview,
  type ComplianceAllergenIncidentOperation,
  type ComplianceAllergenIncidentPorts,
  type FoodSafetyIncidentRecord,
} from "../index.js";
const id = (n: number) => `018f9970-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const hash = (value: string) => `sha256:${value.repeat(64).slice(0, 64)}`;
const ids = {
  tenant: id(1),
  brand: id(2),
  actor: id(3),
  policy: id(4),
  audit: id(5),
  correlation: id(6),
  review: id(7),
  subject: id(8),
  recipe: id(9),
  allergen: id(10),
  source: id(11),
  evidence: id(12),
  requirement: id(13),
  reviewer: id(14),
  invalidatingSource: id(15),
  availabilityBlock: id(16),
  paymentBlock: id(17),
  incident: id(18),
  case: id(19),
  reporter: id(20),
  product: id(21),
  order: id(22),
  evidence2: id(23),
  containment: id(24),
  verification: id(25),
};
const at = "2026-08-14T18:00:00.000Z";
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
function review(options: Record<string, unknown> = {}): AllergenControlReview {
  return {
    reviewReference: ids.review,
    revision: 1,
    scope,
    subjectKind: "SellablePath",
    subjectReference: ids.subject,
    configurationDigest: hash("a"),
    allergenPolicyVersionReference: ids.policy,
    recipeVersionReferences: [ids.recipe],
    sourceAssertions: [
      {
        allergenReference: ids.allergen,
        classification: "Contains",
        sourceVersionReference: ids.source,
        evidenceReference: ids.evidence,
        evidenceStatus: "Current",
        validUntil: "2027-01-01T00:00:00.000Z",
      },
    ],
    reviewStatus: "Pending",
    reviewerReference: null,
    reviewedAt: null,
    invalidatedBySourceVersionReference: null,
    publicationBlockOutcomeReference: null,
    paymentBlockOutcomeReference: null,
    allergenFreeClaim: false,
    requirementVersionReference: ids.requirement,
    severity: "Major",
    recordedAt: at,
    ...options,
  } as never;
}
function incident(options: Record<string, unknown> = {}): FoodSafetyIncidentRecord {
  return {
    incidentReference: ids.incident,
    revision: 1,
    caseReference: ids.case,
    scope,
    incidentType: "AllergenExposure",
    severity: "Critical",
    status: "Reported",
    occurredAt: at,
    reportedAt: at,
    reporterReference: ids.reporter,
    productReference: ids.product,
    orderReference: ids.order,
    lotReference: null,
    employeeReference: null,
    allegationSnapshotReference: null,
    healthSnapshotReference: null,
    configurationSnapshotDigest: hash("b"),
    recipeSnapshotDigest: hash("c"),
    handlingSnapshotDigest: hash("d"),
    containmentOutcomeReferences: [],
    evidenceReferences: [ids.evidence],
    notificationReference: null,
    investigationReference: null,
    outcomeCode: null,
    verificationReference: null,
    availabilityBlockOutcomeReference: null,
    paymentBlockOutcomeReference: null,
    requirementVersionReference: ids.requirement,
    accessClass: "Restricted",
    recordedAt: at,
    ...options,
  } as never;
}
function fixture() {
  let latestReview: AllergenControlReview | null = null;
  let latestIncident: FoodSafetyIncidentRecord | null = null;
  let deny = false;
  let matchesPinned = true;
  let blockCalls = 0;
  const operations = new Map<string, ComplianceAllergenIncidentOperation>();
  const committed: ComplianceAllergenIncidentOperation[] = [];
  const ports: ComplianceAllergenIncidentPorts = {
    authorization: {
      async authorize(input) {
        if (deny) return null;
        const actions = {
          RecordAllergenReview: "compliance.allergen.review.record",
          ReviseAllergenReview: "compliance.allergen.review.manage",
          EnforceAllergenBlocks: "compliance.allergen.block.enforce",
          ReportFoodSafetyIncident: "compliance.incident.report",
          ReviseFoodSafetyIncident: "compliance.incident.manage",
          EnforceIncidentBlocks: "compliance.incident.block.enforce",
        } as const;
        const targetType = input.command.includes("Incident")
          ? "FoodSafetyIncident"
          : "AllergenControlReview";
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
            actionCode: `COMPLIANCE_ALLERGEN_INCIDENT_${input.command.toUpperCase()}`,
            targetType,
            targetId: input.targetReference,
            beforeSummary: {},
            afterSummary: {},
            reasonCode: "AUTHORIZED_OPERATION",
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
      async loadLatestReview() {
        return latestReview;
      },
      async loadLatestIncident() {
        return latestIncident;
      },
      async commit({ operation, expectedRevision }) {
        const current =
          operation.allergenReview !== null
            ? (latestReview?.revision ?? 0)
            : (latestIncident?.revision ?? 0);
        if (current !== expectedRevision) throw new Error("stale");
        if (operation.allergenReview !== null) latestReview = operation.allergenReview;
        if (operation.incident !== null) latestIncident = operation.incident;
        operations.set(operation.operationReference, operation);
        committed.push(operation);
        return operation;
      },
    },
    allergenSources: {
      async assess() {
        return {
          scope,
          matchesPinned,
          invalidatingSourceVersionReference: matchesPinned ? null : ids.invalidatingSource,
          assessedAt: at,
        } as never;
      },
    },
    cases: {
      async resolve() {
        return { scope, caseType: "FoodSafetyIncident", lifecycle: "Investigating" } as never;
      },
    },
    ownerBlocks: {
      async enforce() {
        blockCalls += 1;
        return {
          availabilityBlockOutcomeReference: ids.availabilityBlock,
          paymentBlockOutcomeReference: ids.paymentBlock,
        } as never;
      },
    },
  };
  return {
    service: createComplianceAllergenIncidentService(ports),
    committed,
    setReview(value: AllergenControlReview | null) {
      latestReview = value;
    },
    setIncident(value: FoodSafetyIncidentRecord | null) {
      latestIncident = value;
    },
    invalidateSource() {
      matchesPinned = false;
    },
    deny() {
      deny = true;
    },
    blockCalls: () => blockCalls,
  };
}
describe("WP-2175 allergen and incident controls", () => {
  it("rejects unsafe approval, allergen-free claims, raw extras and incomplete exposure snapshots", () => {
    expect(() => createAllergenControlReview(review())).not.toThrow();
    expect(() => createAllergenControlReview({ ...review(), allergenFreeClaim: true })).toThrow();
    expect(() =>
      createAllergenControlReview({
        ...review(),
        reviewStatus: "Approved",
        reviewerReference: ids.reviewer,
        reviewedAt: at,
        sourceAssertions: [{ ...review().sourceAssertions[0], evidenceStatus: "Conflicting" }],
      }),
    ).toThrow();
    expect(() =>
      createAllergenControlReview({ ...review(), customerNote: "restricted" }),
    ).toThrow();
    expect(() =>
      createFoodSafetyIncidentRecord({ ...incident(), handlingSnapshotDigest: null }),
    ).toThrow();
  });
  it("records a pending review without inventing a failure", async () => {
    const f = fixture();
    await f.service.recordAllergenReview({
      operationReference: id(30),
      expectedRevision: 0,
      review: review(),
      purposeCode: "FOOD_SAFETY",
      occurredAt: at,
    });
    expect(f.committed[0]?.events).toEqual([]);
  });
  it("records rejected and source-invalidated reviews as canonical failures", async () => {
    const rejected = review({
      revision: 2,
      reviewStatus: "Rejected",
      reviewerReference: ids.reviewer,
      reviewedAt: later,
      severity: "Critical",
      recordedAt: later,
    });
    const f = fixture();
    f.setReview(review());
    await f.service.reviseAllergenReview({
      operationReference: id(31),
      expectedRevision: 1,
      review: rejected,
      purposeCode: "FOOD_SAFETY",
      occurredAt: later,
    });
    expect(f.committed[0]?.events.map((event) => event.eventType)).toEqual([
      "AllergenControlFailureDetected",
    ]);
    const invalidating = fixture();
    invalidating.setReview(review());
    invalidating.invalidateSource();
    await invalidating.service.reviseAllergenReview({
      operationReference: id(32),
      expectedRevision: 1,
      review: review({
        revision: 2,
        reviewStatus: "Invalidated",
        reviewerReference: ids.reviewer,
        reviewedAt: later,
        invalidatedBySourceVersionReference: ids.invalidatingSource,
        severity: "Critical",
        recordedAt: later,
      }),
      purposeCode: "FOOD_SAFETY",
      occurredAt: later,
    });
    expect(invalidating.committed[0]?.events[0]?.eventType).toBe("AllergenControlFailureDetected");
  });
  it("enforces unsafe review blocks only through the owner port", async () => {
    const f = fixture();
    f.setReview(review());
    const result = await f.service.enforceAllergenBlocks({
      operationReference: id(33),
      reviewReference: ids.review,
      expectedRevision: 1,
      purposeCode: "FOOD_SAFETY",
      occurredAt: later,
    });
    expect(result.allergenReview).toMatchObject({
      publicationBlockOutcomeReference: ids.availabilityBlock,
      paymentBlockOutcomeReference: ids.paymentBlock,
    });
    expect(f.blockCalls()).toBe(1);
  });
  it("reports an Incident against an active exact-scope Case and emits no restricted detail", async () => {
    const f = fixture();
    await f.service.reportFoodSafetyIncident({
      operationReference: id(34),
      expectedRevision: 0,
      incident: incident(),
      purposeCode: "INCIDENT_RESPONSE",
      occurredAt: at,
    });
    expect(f.committed[0]?.events).toEqual([
      expect.objectContaining({
        eventType: "FoodSafetyIncidentReported",
        recordReference: ids.incident,
      }),
    ]);
    expect(f.committed[0]?.events[0]).not.toHaveProperty("allegationSnapshotReference");
  });
  it("preserves Incident evidence and rejects premature closure", async () => {
    expect(() => createFoodSafetyIncidentRecord({ ...incident(), status: "Closed" })).toThrow();
    const f = fixture();
    f.setIncident(incident());
    await f.service.reviseFoodSafetyIncident({
      operationReference: id(35),
      expectedRevision: 1,
      incident: incident({
        revision: 2,
        status: "Investigating",
        evidenceReferences: [ids.evidence, ids.evidence2],
        recordedAt: later,
      }),
      purposeCode: "INCIDENT_RESPONSE",
      occurredAt: later,
    });
    expect(f.committed[0]?.incident?.evidenceReferences).toHaveLength(2);
  });
  it("links Incident availability and payment blocks without writing either Domain", async () => {
    const f = fixture();
    f.setIncident(incident());
    const result = await f.service.enforceIncidentBlocks({
      operationReference: id(36),
      incidentReference: ids.incident,
      expectedRevision: 1,
      purposeCode: "INCIDENT_RESPONSE",
      occurredAt: later,
    });
    expect(result.incident).toMatchObject({
      availabilityBlockOutcomeReference: ids.availabilityBlock,
      paymentBlockOutcomeReference: ids.paymentBlock,
    });
    expect(f.blockCalls()).toBe(1);
  });
  it("fails closed before owner block work when permission is denied", async () => {
    const f = fixture();
    f.setIncident(incident());
    f.deny();
    await expect(
      f.service.enforceIncidentBlocks({
        operationReference: id(37),
        incidentReference: ids.incident,
        expectedRevision: 1,
        purposeCode: "INCIDENT_RESPONSE",
        occurredAt: later,
      }),
    ).rejects.toMatchObject({ code: "COMPLIANCE_ALLERGEN_INCIDENT_PERMISSION_DENIED" });
    expect(f.blockCalls()).toBe(0);
  });
});
