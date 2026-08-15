import { createBrand, createTenantContext } from "@bop/tenant";
import { describe, expect, it } from "vitest";
import {
  createComplianceQualificationRecord,
  createComplianceQualificationService,
  type ComplianceQualificationOperation,
  type ComplianceQualificationPorts,
  type ComplianceQualificationRecord,
} from "../index.js";

const id = (n: number) => `018f9960-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const ids = {
  tenant: id(1),
  brand: id(2),
  actor: id(3),
  policy: id(4),
  audit: id(5),
  correlation: id(6),
  qualification: id(7),
  subject: id(8),
  issuer: id(9),
  number: id(10),
  authority: id(11),
  legalEntity: id(12),
  requirement: id(13),
  evidence: id(14),
  membership: id(15),
  ownerRecord: id(16),
  verifier: id(17),
  task: id(18),
  outcome: id(19),
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
function qualification(options: Record<string, unknown> = {}): ComplianceQualificationRecord {
  return {
    qualificationReference: ids.qualification,
    revision: 1,
    scope,
    subjectKind: "Permit",
    subjectReference: ids.subject,
    owner: "Compliance",
    ownerRecordReference: null,
    ownerRecordVersion: null,
    qualificationTypeCode: "FOOD_PREMISES_PERMIT",
    jurisdictionCode: "CA_ON",
    issuerReference: ids.issuer,
    numberReference: ids.number,
    authorityReference: ids.authority,
    holderLegalEntityReference: ids.legalEntity,
    membershipReference: null,
    requirementVersionReference: ids.requirement,
    evidenceReference: ids.evidence,
    issuedAt: "2026-01-01T00:00:00.000Z",
    effectiveFrom: "2026-01-02T00:00:00.000Z",
    expiresAt: "2026-09-01T00:00:00.000Z",
    renewalWindowStartsAt: "2026-08-01T00:00:00.000Z",
    status: "Active",
    verificationResult: "Verified",
    verifiedAt: "2026-01-02T12:00:00.000Z",
    verifiedByReference: ids.verifier,
    eligibilityOutcomeReference: null,
    renewalTaskReference: null,
    severity: "Critical",
    recordedAt: at,
    ...options,
  } as never;
}
function fixture() {
  let latest: ComplianceQualificationRecord | null = null;
  let deny = false;
  let renewalCalls = 0;
  let eligibilityCalls = 0;
  const operations = new Map<string, ComplianceQualificationOperation>();
  const committed: ComplianceQualificationOperation[] = [];
  const ports: ComplianceQualificationPorts = {
    authorization: {
      async authorize(input) {
        if (deny) return null;
        const permission = {
          RecordQualification: "compliance.qualification.record",
          ReviseQualification: "compliance.qualification.review",
          RequestRenewal: "compliance.qualification.renewal.request",
          SuspendEligibility: "compliance.qualification.eligibility.suspend",
        } as const;
        return {
          tenantReference: ids.tenant,
          tenantContext: tenant(input.observedAt),
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
            actor: { type: "User", reference: ids.actor },
            actionCode: `COMPLIANCE_QUALIFICATION_${input.command.toUpperCase()}`,
            targetType: "ComplianceQualification",
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
      async loadLatest() {
        return latest;
      },
      async commit({ operation, expectedRevision }) {
        if ((latest?.revision ?? 0) !== expectedRevision) throw new Error("stale");
        latest = operation.qualification;
        operations.set(operation.operationReference, operation);
        committed.push(operation);
        return operation;
      },
    },
    renewalTasks: {
      async request() {
        renewalCalls += 1;
        return ids.task as never;
      },
    },
    eligibility: {
      async suspend() {
        eligibilityCalls += 1;
        return ids.outcome as never;
      },
    },
  };
  return {
    service: createComplianceQualificationService(ports),
    committed,
    setLatest(value: ComplianceQualificationRecord | null) {
      latest = value;
    },
    deny() {
      deny = true;
    },
    calls: () => ({ renewalCalls, eligibilityCalls }),
  };
}

describe("WP-2174 qualification controls", () => {
  it("pins owner boundaries and rejects extra or contradictory fields", () => {
    expect(() => createComplianceQualificationRecord(qualification())).not.toThrow();
    expect(() =>
      createComplianceQualificationRecord({
        ...qualification(),
        subjectKind: "Supplier",
        owner: "Compliance",
        authorityReference: null,
        holderLegalEntityReference: null,
      }),
    ).toThrow();
    expect(() =>
      createComplianceQualificationRecord({ ...qualification(), status: "Draft" }),
    ).toThrow();
    expect(() =>
      createComplianceQualificationRecord({ ...qualification(), certificateNumber: "PRIVATE" }),
    ).toThrow();
    expect(() =>
      createComplianceQualificationRecord({
        ...qualification(),
        status: "Active",
        verificationResult: "Pending",
        verifiedAt: null,
        verifiedByReference: null,
      }),
    ).toThrow();
  });

  it("records an expiring Permit and publishes only the committed canonical fact", async () => {
    const f = fixture();
    const result = await f.service.recordQualification({
      operationReference: id(30),
      expectedRevision: 0,
      qualification: qualification({ status: "Expiring" }),
      purposeCode: "REGULATORY_COMPLIANCE",
      occurredAt: at,
    });
    expect(result.status).toBe("Applied");
    expect(f.committed[0]?.events.map((event) => event.eventType)).toEqual(["LicenseExpiring"]);
  });

  it("revises Employee qualification without changing Identity and emits expiry", async () => {
    const employee = qualification({
      subjectKind: "Employee",
      owner: "Compliance",
      authorityReference: null,
      holderLegalEntityReference: null,
      membershipReference: ids.membership,
    });
    const f = fixture();
    f.setLatest(employee);
    await f.service.reviseQualification({
      operationReference: id(31),
      expectedRevision: 1,
      qualification: { ...employee, revision: 2, status: "Expired", recordedAt: later },
      purposeCode: "REGULATORY_COMPLIANCE",
      occurredAt: later,
    });
    expect(f.committed[0]?.events.map((event) => event.eventType)).toEqual([
      "EmployeeQualificationExpired",
    ]);
    expect(f.committed[0]?.qualification.subjectReference).toBe(ids.subject);
  });

  it("keeps Supplier expiry publication with the Procurement owner", async () => {
    const f = fixture();
    const supplier = qualification({
      subjectKind: "Supplier",
      owner: "Procurement",
      ownerRecordReference: ids.ownerRecord,
      ownerRecordVersion: 3,
      authorityReference: null,
      holderLegalEntityReference: null,
      status: "Expiring",
    });
    await f.service.recordQualification({
      operationReference: id(36),
      expectedRevision: 0,
      qualification: supplier,
      purposeCode: "REGULATORY_COMPLIANCE",
      occurredAt: at,
    });
    expect(f.committed[0]?.qualification.owner).toBe("Procurement");
    expect(f.committed[0]?.events).toEqual([]);
  });

  it("keeps retries idempotent and rejects changed intent", async () => {
    const f = fixture();
    const input = {
      operationReference: id(32),
      expectedRevision: 0 as const,
      qualification: qualification(),
      purposeCode: "REGULATORY_COMPLIANCE",
      occurredAt: at,
    };
    await f.service.recordQualification(input);
    expect((await f.service.recordQualification(input)).status).toBe("AlreadyApplied");
    await expect(
      f.service.recordQualification({ ...input, purposeCode: "DIFFERENT_PURPOSE" }),
    ).rejects.toMatchObject({
      code: "COMPLIANCE_QUALIFICATION_IDEMPOTENCY_CONFLICT",
    });
  });

  it("requests renewal through Task and records only its opaque reference", async () => {
    const f = fixture();
    f.setLatest(qualification());
    const result = await f.service.requestRenewal({
      operationReference: id(33),
      qualificationReference: ids.qualification,
      expectedRevision: 1,
      purposeCode: "REGULATORY_COMPLIANCE",
      occurredAt: later,
    });
    expect(result.qualification.renewalTaskReference).toBe(ids.task);
    expect(result.qualification.revision).toBe(2);
    expect(f.calls()).toEqual({ renewalCalls: 1, eligibilityCalls: 0 });
  });

  it("suspends eligibility only through the owning port and records Permit suspension", async () => {
    const f = fixture();
    f.setLatest(qualification());
    const result = await f.service.suspendEligibility({
      operationReference: id(34),
      qualificationReference: ids.qualification,
      expectedRevision: 1,
      purposeCode: "REGULATORY_COMPLIANCE",
      occurredAt: later,
    });
    expect(result.qualification).toMatchObject({
      status: "Suspended",
      eligibilityOutcomeReference: ids.outcome,
    });
    expect(f.committed[0]?.events.map((event) => event.eventType)).toEqual(["LicenseSuspended"]);
    expect(f.calls()).toEqual({ renewalCalls: 0, eligibilityCalls: 1 });
  });

  it("fails closed before cross-Domain work when authorization is denied", async () => {
    const f = fixture();
    f.setLatest(qualification());
    f.deny();
    await expect(
      f.service.suspendEligibility({
        operationReference: id(35),
        qualificationReference: ids.qualification,
        expectedRevision: 1,
        purposeCode: "REGULATORY_COMPLIANCE",
        occurredAt: later,
      }),
    ).rejects.toMatchObject({
      code: "COMPLIANCE_QUALIFICATION_PERMISSION_DENIED",
    });
    expect(f.calls()).toEqual({ renewalCalls: 0, eligibilityCalls: 0 });
  });
});
