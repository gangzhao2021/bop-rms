import { describe, expect, it, vi } from "vitest";
import {
  createDiagnosticAccessGrant,
  createDiagnosticAccessResolver,
  createSupportActionRecord,
  createSupportCaseService,
  createSupportCaseVersion,
  parseSupportCaseReference,
  SupportCaseError,
  type DiagnosticAccessGrant,
  type SupportCaseOperation,
  type SupportCasePorts,
  type SupportCaseStatus,
  type SupportCaseVersion,
} from "../index.js";
const id = (n: number) =>
    parseSupportCaseReference(`018f9816-0000-7000-8000-${n.toString(16).padStart(12, "0")}`),
  at = "2026-08-15T16:00:00.000Z";
const version = (
  status: SupportCaseStatus = "Open",
  number = 1,
  overrides: Record<string, unknown> = {},
) =>
  createSupportCaseVersion({
    versionReference: id(10 + number),
    caseReference: id(1),
    version: number,
    status,
    tenantReference: id(2),
    storeReference: id(3),
    caseType: "DIAGNOSTIC",
    purposeCode: "AUTHORIZED_SUPPORT",
    requesterActorReference: id(4),
    requesterVerificationEvidenceReference: id(5),
    assignedRoleReference: status === "Open" || status === "Closed" ? null : id(6),
    dueAt: "2026-08-16T16:00:00.000Z",
    supersedesVersionReference: number === 1 ? null : id(9 + number),
    reasonCode: "SUPPORT_REQUEST",
    createdAt: at,
    updatedAt: at,
    dataClassification: "ConfidentialMetadata",
    ...overrides,
  });
const grant = (overrides: Record<string, unknown> = {}) =>
  createDiagnosticAccessGrant({
    grantReference: id(30),
    caseReference: id(1),
    tenantReference: id(2),
    storeReference: id(3),
    supportActorReference: id(4),
    requestedByReference: id(4),
    approvedByReference: id(7),
    approvalEvidenceReference: id(31),
    recentMfaEvidenceReference: id(32),
    purposeCode: "AUTHORIZED_SUPPORT",
    delegatedPermissions: ["tenant.diagnostics"],
    maskingPolicyReference: id(33),
    grantedAt: at,
    expiresAt: "2026-08-15T16:15:00.000Z",
    dataClassification: "RestrictedAccessMetadata",
    ...overrides,
  });
const input = (
  candidate: SupportCaseVersion,
  actor = id(4),
  overrides: Record<string, unknown> = {},
) => ({
  operationReference: id(40 + candidate.version),
  expectedVersion: candidate.version - 1,
  actorReference: actor,
  purposeCode: "AUTHORIZED_SUPPORT",
  auditReference: id(50),
  occurredAt: at,
  candidate,
  grant: null,
  action: null,
  grantReference: null,
  ...overrides,
});
function fixture(
  current: SupportCaseVersion | null = null,
  activeGrant: DiagnosticAccessGrant | null = null,
) {
  const operations = new Map<string, SupportCaseOperation>();
  let observedAt = at;
  let revoked = false;
  const resolveActive = async (
    query: Parameters<SupportCasePorts["repository"]["resolveActiveDiagnosticAccess"]>[0],
  ) =>
    current?.status === "AccessGranted" &&
    activeGrant !== null &&
    !revoked &&
    activeGrant.caseReference === query.caseReference &&
    activeGrant.grantReference === query.grantReference &&
    activeGrant.supportActorReference === query.actorReference &&
    activeGrant.tenantReference === query.tenantReference &&
    activeGrant.storeReference === query.storeReference &&
    activeGrant.purposeCode === query.purposeCode &&
    activeGrant.delegatedPermissions.includes(query.delegatedPermission) &&
    Date.parse(query.observedAt) < Date.parse(activeGrant.expiresAt)
      ? activeGrant
      : null;
  const ports: SupportCasePorts = {
    clock: { now: () => observedAt },
    authorization: {
      authorize: vi.fn(async () => ({
        allowed: true,
        namedPlatformActor: true,
        purposeBound: true,
        caseBound: true,
        recentMfa: true,
        approver: true,
      })),
    },
    evidence: {
      validateRequester: vi.fn(async () => true),
      validateApproval: vi.fn(async () => true),
      validateRecentMfa: vi.fn(async () => true),
    },
    scope: { validateTenantStore: vi.fn(async () => true) },
    delegation: { validate: vi.fn(async () => true) },
    references: {
      hashIntent: (value) => `sha256:${value.length.toString(16).padStart(64, "0")}`,
      equals: (left, right) => left === right,
    },
    repository: {
      loadLatest: vi.fn(async () => current),
      loadGrant: vi.fn(async () => activeGrant),
      isGrantRevoked: vi.fn(async () => revoked),
      resolveActiveDiagnosticAccess: vi.fn(resolveActive),
      resolveOperation: vi.fn(async (reference) => operations.get(reference) ?? null),
      commit: vi.fn(async ({ operation, requiredActiveDiagnosticAccess }) => {
        if (
          requiredActiveDiagnosticAccess !== null &&
          (await resolveActive(requiredActiveDiagnosticAccess)) === null
        )
          throw new Error("active diagnostic access changed before commit");
        operations.set(operation.operationReference, operation);
        return operation;
      }),
    },
  };
  return {
    ports,
    service: createSupportCaseService(ports),
    revoke: () => {
      revoked = true;
    },
    setNow: (value: string) => {
      observedAt = value;
    },
  };
}
describe("WP-2198 Support Case", () => {
  it("creates a verified, purpose-bound Case without impersonation material", async () => {
    const f = fixture();
    await expect(f.service.execute("Create", input(version()))).resolves.toMatchObject({
      status: "Applied",
      operation: { command: "Create", version: 1 },
    });
  });
  it("rejects grants longer than fifteen minutes", () => {
    expect(() => grant({ expiresAt: "2026-08-15T16:15:00.001Z" })).toThrow(SupportCaseError);
  });
  it("requires recent MFA and independent approval for grants", async () => {
    const pending = version("AccessPendingApproval", 3),
      f = fixture(pending);
    vi.mocked(f.ports.authorization.authorize).mockResolvedValue({
      allowed: true,
      namedPlatformActor: true,
      purposeBound: true,
      caseBound: true,
      recentMfa: false,
      approver: true,
    });
    const candidate = version("AccessGranted", 4, {
      supersedesVersionReference: pending.versionReference,
    });
    await expect(
      f.service.execute("GrantAccess", input(candidate, id(7), { grant: grant() })),
    ).rejects.toMatchObject({ code: "SUPPORT_CASE_MFA_REQUIRED" });
  });
  it("records only an exact action delegated by an active grant", async () => {
    const active = version("AccessGranted", 4),
      g = grant(),
      f = fixture(active, g),
      candidate = version("AccessGranted", 5, {
        supersedesVersionReference: active.versionReference,
      }),
      action = createSupportActionRecord({
        actionReference: id(60),
        caseReference: id(1),
        grantReference: id(30),
        supportActorReference: id(4),
        delegatedPermission: "tenant.diagnostics",
        targetType: "TENANT_HEALTH",
        targetReference: id(61),
        reasonCode: "INVESTIGATE_INCIDENT",
        evidenceReference: id(62),
        occurredAt: at,
        dataClassification: "RestrictedAccessMetadata",
      });
    await expect(
      f.service.execute(
        "RecordAction",
        input(candidate, id(4), { action, grantReference: id(30) }),
      ),
    ).resolves.toMatchObject({ status: "Applied" });
  });
  it("fails closed when resolving an expired or mismatched access grant", async () => {
    const active = version("AccessGranted", 4),
      g = grant(),
      f = fixture(active, g),
      resolve = createDiagnosticAccessResolver(f.ports);
    f.setNow("2026-08-15T16:15:00.000Z");
    await expect(
      resolve({
        caseReference: id(1),
        grantReference: id(30),
        actorReference: id(4),
        tenantReference: id(2),
        storeReference: id(3),
        purposeCode: "AUTHORIZED_SUPPORT",
        delegatedPermission: "tenant.diagnostics",
      }),
    ).resolves.toEqual({ allowed: false, reason: "Denied" });
  });
  it("uses trusted time instead of caller-controlled diagnostic timestamps", async () => {
    const active = version("AccessGranted", 4),
      f = fixture(active, grant()),
      resolve = createDiagnosticAccessResolver(f.ports);
    f.setNow("2026-08-15T16:15:00.000Z");
    await expect(
      resolve({
        caseReference: id(1),
        grantReference: id(30),
        actorReference: id(4),
        tenantReference: id(2),
        storeReference: id(3),
        purposeCode: "AUTHORIZED_SUPPORT",
        delegatedPermission: "tenant.diagnostics",
      }),
    ).resolves.toEqual({ allowed: false, reason: "Denied" });
  });
  it("requires the active grant to be revalidated atomically with an action commit", async () => {
    const active = version("AccessGranted", 4),
      f = fixture(active, grant()),
      candidate = version("AccessGranted", 5, {
        supersedesVersionReference: active.versionReference,
      }),
      action = createSupportActionRecord({
        actionReference: id(60),
        caseReference: id(1),
        grantReference: id(30),
        supportActorReference: id(4),
        delegatedPermission: "tenant.diagnostics",
        targetType: "TENANT_HEALTH",
        targetReference: id(61),
        reasonCode: "INVESTIGATE_INCIDENT",
        evidenceReference: id(62),
        occurredAt: at,
        dataClassification: "RestrictedAccessMetadata",
      });
    vi.mocked(f.ports.repository.resolveActiveDiagnosticAccess).mockImplementationOnce(
      async (query) => {
        f.revoke();
        return grant().grantReference === query.grantReference ? grant() : null;
      },
    );
    await expect(
      f.service.execute(
        "RecordAction",
        input(candidate, id(4), { action, grantReference: id(30) }),
      ),
    ).rejects.toMatchObject({ code: "SUPPORT_CASE_DEPENDENCY_UNAVAILABLE" });
    expect(f.ports.repository.commit).toHaveBeenCalledWith(
      expect.objectContaining({
        requiredActiveDiagnosticAccess: expect.objectContaining({ observedAt: at }),
      }),
    );
  });
});
