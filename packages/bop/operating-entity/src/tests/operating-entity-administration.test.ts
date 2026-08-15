import { describe, expect, it, vi } from "vitest";
import {
  OperatingEntityAdministrationError,
  createBusinessFunctionAssignmentRequest,
  createOperatingEntity,
  createOperatingEntityAdministrationService,
  createOperatingEntityApprovalDecision,
  createOperatingEntityAuthoritySummary,
  createOperatingEntityProfileVersion,
  createRestrictedRevealGrant,
  transitionOperatingEntity,
  type OperatingEntity,
  type OperatingEntityAdministrationOperation,
  type OperatingEntityAdministrationPorts,
  type OperatingEntityApprovalDecision,
  type OperatingEntityProfileVersion,
} from "../index.js";
import { parseOrganizationVersion } from "@bop/tenant";

const id = (n: number) => `018f9e40-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const AT = "2026-08-15T13:00:00.000Z";
const LATER = "2026-08-15T13:01:00.000Z";
const entityShape = (overrides: Record<string, unknown> = {}) => ({
  operatingEntityReference: id(1),
  kind: "LegalEntity",
  legalName: "Synthetic Ontario Incorporated",
  tradeName: "Synthetic Kitchen",
  jurisdictionCode: "CA-ON",
  registrationReference: id(2),
  taxRegistrationReference: id(3),
  billingIdentityReference: id(4),
  settlementReference: id(5),
  evidenceReference: id(6),
  lifecycle: "Draft",
  version: 1,
  createdAt: AT,
  updatedAt: AT,
  ...overrides,
});
const profileShape = (overrides: Record<string, unknown> = {}) => ({
  profileVersionReference: id(10),
  operatingEntityReference: id(1),
  profileVersion: 1,
  legalName: "Synthetic Ontario Incorporated",
  tradeName: "Synthetic Kitchen",
  jurisdictionCode: "CA-ON",
  registrationReference: id(2),
  taxRegistrationReference: id(3),
  registeredAddressReference: id(7),
  billingIdentityReference: id(4),
  settlementReference: id(5),
  evidenceReferences: [id(6)],
  recordedByReference: id(20),
  recordedAt: AT,
  dataClassification: "RestrictedReferenceMetadata",
  ...overrides,
});
const decisionShape = (overrides: Record<string, unknown> = {}) => ({
  decisionReference: id(11),
  operatingEntityReference: id(1),
  entityVersion: 2,
  decision: "Approved",
  submittedByReference: id(20),
  decidedByReference: id(21),
  approvalEvidenceReference: id(12),
  purposeCode: "LEGAL_ENTITY.ADMINISTRATION",
  decidedAt: LATER,
  ...overrides,
});
const command = (artifact: unknown, expectedVersion: number, operation = 30, actor = 20) => ({
  operationReference: id(operation),
  actorReference: id(actor),
  purposeCode: "LEGAL_ENTITY.ADMINISTRATION",
  auditReference: id(operation + 1),
  expectedVersion,
  occurredAt: LATER,
  artifact,
});

function harness(initial = createOperatingEntity(entityShape())) {
  let entity: OperatingEntity | null = initial;
  let profile: OperatingEntityProfileVersion | null = null;
  let decision: OperatingEntityApprovalDecision | null = null;
  const operations = new Map<string, OperatingEntityAdministrationOperation>();
  const ports: OperatingEntityAdministrationPorts = {
    authorization: { authorize: vi.fn(async () => ({ allowed: true, recentMfa: true })) },
    approval: { validate: vi.fn(async () => true) },
    assignments: { hasOverlap: vi.fn(async () => false) },
    references: { hashIntent: (value) => `digest:${value}`, equals: (a, b) => a === b },
    repository: {
      loadEntity: vi.fn(async () => entity),
      loadLatestProfile: vi.fn(async () => profile),
      loadLatestApprovalDecision: vi.fn(async () => decision),
      resolveOperation: vi.fn(async (reference) => operations.get(reference) ?? null),
      commit: vi.fn(async ({ operation }) => {
        operations.set(operation.operationReference, operation);
        if ("kind" in operation.artifact) entity = operation.artifact;
        if ("profileVersion" in operation.artifact) profile = operation.artifact;
        if ("decision" in operation.artifact) decision = operation.artifact;
        return operation;
      }),
    },
  };
  return { ports, service: createOperatingEntityAdministrationService(ports) };
}

describe("WP-2190 Operating Entity administration", () => {
  it("keeps profile and authority details reference-only and closed", () => {
    expect(createOperatingEntityProfileVersion(profileShape()).registeredAddressReference).toBe(
      id(7),
    );
    expect(() =>
      createOperatingEntityProfileVersion({ ...profileShape(), taxNumber: "forbidden" }),
    ).toThrow(OperatingEntityAdministrationError);
    const authority = createOperatingEntityAuthoritySummary({
      authorityVersionReference: id(13),
      operatingEntityReference: id(1),
      authoritySubjectReference: id(14),
      authorityRoleCode: "Officer",
      titleCode: "PRESIDENT",
      status: "Active",
      effectiveFrom: AT,
      effectiveUntil: null,
      restrictedDetailReference: id(15),
      approvalEvidenceReference: id(12),
      version: 1,
      recordedAt: AT,
      dataClassification: "RestrictedReferenceMetadata",
    });
    expect(authority).not.toHaveProperty("personName");
    expect(() =>
      createOperatingEntityAuthoritySummary({ ...authority, personName: "forbidden" }),
    ).toThrow();
  });

  it("limits restricted reveal to a declared-purpose 15-minute grant", () => {
    expect(
      createRestrictedRevealGrant({
        grantReference: id(16),
        operatingEntityReference: id(1),
        actorReference: id(20),
        purposeCode: "LEGAL_ENTITY.RESTRICTED_REVIEW",
        recentMfaValidatedAt: AT,
        expiresAt: "2026-08-15T13:15:00.000Z",
        mayRevealRestrictedReferences: true,
      }).mayRevealRestrictedReferences,
    ).toBe(true);
    expect(() =>
      createRestrictedRevealGrant({
        grantReference: id(16),
        operatingEntityReference: id(1),
        actorReference: id(20),
        purposeCode: "LEGAL_ENTITY.RESTRICTED_REVIEW",
        recentMfaValidatedAt: AT,
        expiresAt: "2026-08-15T13:16:00.000Z",
        mayRevealRestrictedReferences: true,
      }),
    ).toThrow();
  });

  it("saves only a sequential Draft profile and reauthorizes idempotent replay", async () => {
    const context = harness();
    const input = command(createOperatingEntityProfileVersion(profileShape()), 1);
    await expect(context.service.saveProfile(input)).resolves.toMatchObject({ status: "Applied" });
    await expect(context.service.saveProfile(input)).resolves.toMatchObject({
      status: "AlreadyApplied",
    });
    expect(context.ports.authorization.authorize).toHaveBeenCalledTimes(2);
    expect(context.ports.repository.commit).toHaveBeenCalledOnce();
    await expect(
      context.service.saveProfile(
        command(
          createOperatingEntityProfileVersion(
            profileShape({ profileVersionReference: id(17), profileVersion: 3 }),
          ),
          1,
          32,
        ),
      ),
    ).rejects.toMatchObject({ code: "ENTITY_ADMIN_VERSION_CONFLICT" });
  });

  it("submits, independently approves and activates with exact versions", async () => {
    const context = harness();
    const draft = createOperatingEntity(entityShape());
    const pending = transitionOperatingEntity(
      draft,
      parseOrganizationVersion(1),
      "PendingExternalEvidence",
      LATER,
    );
    await context.service.submitForApproval(command(pending, 1));
    const decision = createOperatingEntityApprovalDecision(decisionShape());
    await expect(
      context.service.decideApproval(command(decision, 2, 32, 21)),
    ).resolves.toMatchObject({ status: "Applied" });
    const active = transitionOperatingEntity(pending, parseOrganizationVersion(2), "Active", LATER);
    await expect(context.service.activateEntity(command(active, 2, 34, 21))).resolves.toMatchObject(
      { status: "Applied" },
    );
    expect(context.ports.approval.validate).toHaveBeenCalled();
  });

  it("rejects self-approval, missing recent MFA and revoked permission", async () => {
    expect(() =>
      createOperatingEntityApprovalDecision(decisionShape({ decidedByReference: id(20) })),
    ).toThrow();
    const pending = createOperatingEntity(
      entityShape({ lifecycle: "PendingExternalEvidence", version: 2, updatedAt: LATER }),
    );
    const mfa = harness(pending);
    (mfa.ports.authorization.authorize as ReturnType<typeof vi.fn>).mockResolvedValue({
      allowed: true,
      recentMfa: false,
    });
    await expect(
      mfa.service.decideApproval(
        command(createOperatingEntityApprovalDecision(decisionShape()), 2, 36, 21),
      ),
    ).rejects.toMatchObject({ code: "ENTITY_ADMIN_RECENT_MFA_REQUIRED" });
    (mfa.ports.authorization.authorize as ReturnType<typeof vi.fn>).mockResolvedValue({
      allowed: false,
      recentMfa: true,
    });
    await expect(
      mfa.service.decideApproval(
        command(createOperatingEntityApprovalDecision(decisionShape()), 2, 37, 21),
      ),
    ).rejects.toMatchObject({ code: "ENTITY_ADMIN_PERMISSION_DENIED" });
  });

  it("requires approved non-overlapping Business Function assignments", async () => {
    const active = createOperatingEntity(entityShape({ lifecycle: "Active" }));
    const context = harness(active);
    const assignment = createBusinessFunctionAssignmentRequest({
      assignmentReference: id(40),
      operatingEntityReference: id(1),
      brandReference: id(41),
      storeReference: id(42),
      businessFunction: "SalesReceiptIssuer",
      effectiveFrom: AT,
      effectiveUntil: null,
      approvalEvidenceReference: id(12),
      requestedByReference: id(20),
      approvedByReference: id(21),
      version: 1,
      recordedAt: AT,
    });
    await expect(
      context.service.assignBusinessFunction(command(assignment, 1, 43, 21)),
    ).resolves.toMatchObject({ status: "Applied" });
    (context.ports.assignments.hasOverlap as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    await expect(
      context.service.assignBusinessFunction(
        command({ ...assignment, assignmentReference: id(44) }, 1, 45, 21),
      ),
    ).rejects.toMatchObject({ code: "ENTITY_ADMIN_ASSIGNMENT_OVERLAP" });
  });
});
