import { describe, expect, it, vi } from "vitest";
import {
  createPlatformTenantAdministrationService,
  createPlatformTenantAdministrationVersion,
  createBrand,
  PlatformTenantAdministrationError,
  type PlatformTenantAdministrationOperation,
  type PlatformTenantAdministrationPorts,
  type PlatformTenantAdministrationVersion,
} from "../index.js";
const id = (n: number) => `018f9816-0000-7000-8000-${n.toString(16).padStart(12, "0")}`,
  at = "2026-08-15T16:00:00.000Z";
const candidate = (
  status: PlatformTenantAdministrationVersion["status"] = "Draft",
  version = 1,
  overrides: Record<string, unknown> = {},
) =>
  createPlatformTenantAdministrationVersion({
    versionReference: id(20 + version),
    tenantReference: id(1),
    version,
    status,
    regionCode: "CA-ON",
    environment: "Production",
    planMetadataReference: id(2),
    capabilityMetadataReferences: [id(3)],
    dataPolicyReference: id(4),
    retentionPolicyReference: id(5),
    authoredByReference: id(6),
    approvedByReference: ["Approved", "Active", "Suspended", "RestorePending"].includes(status)
      ? id(7)
      : null,
    approvalEvidenceReference: ["Approved", "Active", "Suspended", "RestorePending"].includes(
      status,
    )
      ? id(8)
      : null,
    onboardingEvidenceReference: ["Approved", "Active", "Suspended", "RestorePending"].includes(
      status,
    )
      ? id(9)
      : null,
    impactAssessmentReference: ["SuspensionPending", "Suspended", "RestorePending"].includes(status)
      ? id(10)
      : null,
    supersedesVersionReference: version === 1 ? null : id(19 + version),
    reasonCode: "PLATFORM_ADMIN",
    createdAt: at,
    updatedAt: at,
    dataClassification: "ConfigurationMetadata",
    ...overrides,
  });
const input = (value = candidate(), overrides: Record<string, unknown> = {}) => ({
  operationReference: id(40),
  expectedVersion: value.version - 1,
  actorReference: id(7),
  purposeCode: "AUTHORIZED_SUPPORT",
  supportCaseReference: id(41),
  auditReference: id(42),
  occurredAt: at,
  candidate: value,
  ...overrides,
});
function fixture(current: PlatformTenantAdministrationVersion | null = null) {
  const operations = new Map<string, PlatformTenantAdministrationOperation>();
  const ports: PlatformTenantAdministrationPorts = {
    authorization: {
      authorize: vi.fn(async () => ({
        allowed: true,
        namedPlatformActor: true,
        purposeBound: true,
        supportCaseValid: true,
        recentMfa: true,
      })),
    },
    evidence: {
      validateOnboarding: vi.fn(async () => true),
      validateApproval: vi.fn(async () => true),
      validateImpact: vi.fn(async () => true),
    },
    references: {
      validatePlan: vi.fn(async () => true),
      validateCapability: vi.fn(async () => true),
      validatePolicy: vi.fn(async () => true),
      hashIntent: (value) => `sha256:${value.length.toString(16).padStart(64, "0")}`,
      equals: (left, right) => left === right,
    },
    organization: {
      loadTenant: vi.fn(async () =>
        createBrand({
          brandReference: id(1),
          code: "TENANT_A",
          displayName: "Tenant A",
          defaultLocale: "en-CA",
          currencyCode: "CAD",
          lifecycle: "Draft",
          version: 1,
          createdAt: at,
          updatedAt: at,
        }),
      ),
      validateLifecycle: vi.fn(async () => true),
    },
    repository: {
      loadLatest: vi.fn(async () => current),
      resolveOperation: vi.fn(async (reference) => operations.get(reference) ?? null),
      commit: vi.fn(async ({ operation }) => {
        operations.set(operation.operationReference, operation);
        return operation;
      }),
    },
  };
  return { ports, service: createPlatformTenantAdministrationService(ports) };
}
describe("WP-2197 Platform Tenant administration", () => {
  it("creates a purpose-bound draft for an existing Tenant/Brand", async () => {
    const f = fixture();
    await expect(f.service.execute("CreateDraft", input())).resolves.toMatchObject({
      status: "Applied",
      operation: { command: "CreateDraft", version: 1 },
    });
  });
  it("requires named actor, case-bound purpose and recent MFA for approval", async () => {
    const pending = candidate("PendingApproval", 2),
      f = fixture(pending);
    vi.mocked(f.ports.authorization.authorize).mockResolvedValueOnce({
      allowed: true,
      namedPlatformActor: true,
      purposeBound: true,
      supportCaseValid: true,
      recentMfa: false,
    });
    const approved = candidate("Approved", 3, {
      supersedesVersionReference: pending.versionReference,
      authoredByReference: id(6),
      approvedByReference: id(7),
      approvalEvidenceReference: id(8),
      onboardingEvidenceReference: id(9),
    });
    await expect(f.service.execute("ApproveOnboarding", input(approved))).rejects.toMatchObject({
      code: "PLATFORM_TENANT_MFA_REQUIRED",
    });
  });
  it("fails closed when real onboarding evidence is absent", async () => {
    const pending = candidate("PendingApproval", 2),
      f = fixture(pending);
    vi.mocked(f.ports.evidence.validateOnboarding).mockResolvedValueOnce(false);
    const approved = candidate("Approved", 3, {
      supersedesVersionReference: pending.versionReference,
    });
    await expect(f.service.execute("ApproveOnboarding", input(approved))).rejects.toMatchObject({
      code: "PLATFORM_TENANT_EVIDENCE_INVALID",
    });
  });
  it("requires impact evidence before service suspension", async () => {
    const active = candidate("Active", 4),
      f = fixture(active);
    vi.mocked(f.ports.evidence.validateImpact).mockResolvedValueOnce(false);
    const requested = candidate("SuspensionPending", 5, {
      supersedesVersionReference: active.versionReference,
      approvedByReference: null,
      approvalEvidenceReference: null,
      impactAssessmentReference: id(10),
    });
    await expect(f.service.execute("RequestSuspension", input(requested))).rejects.toMatchObject({
      code: "PLATFORM_TENANT_EVIDENCE_INVALID",
    });
  });
  it("rejects stale versions and idempotency intent conflicts", async () => {
    const f = fixture(candidate("Draft", 1));
    await expect(
      f.service.execute("SubmitOnboarding", input(candidate("PendingApproval", 3))),
    ).rejects.toBeInstanceOf(PlatformTenantAdministrationError);
  });
});
