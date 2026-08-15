import { createBrand, createStore, createTenantContext } from "@bop/tenant";
import { describe, expect, it } from "vitest";
import {
  createKdsProfileManagementService,
  createKdsProfileRecord,
  kdsUatCheckCodes,
  type KdsProfileManagementPorts,
  type KdsProfileOperation,
  type KdsProfileRecord,
} from "../index.js";
const id = (n: number) => `018f9994-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = (hour: number) => `2026-08-15T${String(hour).padStart(2, "0")}:00:00.000Z`;
const ids = {
  tenant: id(1),
  brand: id(2),
  store: id(3),
  actor: id(4),
  policy: id(5),
  audit: id(6),
  correlation: id(7),
  profile: id(8),
  version: id(9),
  device: id(10),
  station: id(11),
  assignment: id(12),
  run: id(13),
  evidence: id(14),
};
const scope = { tenantReference: ids.tenant, brandReference: ids.brand, storeReference: ids.store };
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
      code: "KDS",
      displayName: "Synthetic KDS Brand",
      defaultLocale: "en-CA",
      currencyCode: "CAD",
      lifecycle: "Active",
      version: 1,
      createdAt: at(10),
      updatedAt: at(10),
    }),
    createStore({
      storeReference: ids.store,
      brandReference: ids.brand,
      code: "KDS-1",
      displayName: "Synthetic KDS Store",
      timeZone: "America/Toronto",
      locale: "en-CA",
      currencyCode: "CAD",
      lifecycle: "Active",
      version: 1,
      createdAt: at(10),
      updatedAt: at(10),
    }),
    observedAt,
  );
}
function profile(options: Record<string, unknown> = {}): KdsProfileRecord {
  return createKdsProfileRecord({
    profileReference: ids.profile,
    revision: 1,
    scope,
    lifecycle: "Draft",
    currentVersion: {
      versionReference: ids.version,
      versionNumber: 1,
      profileLabelCode: "HOT_KDS",
      browserFamily: "ChromiumManaged",
      minimumLogicalWidth: 1024,
      minimumLogicalHeight: 768,
      wakePolicyCode: "ALWAYS_ON_DURING_STORE_HOURS",
      powerPolicyCode: "MANAGED_AC_POWER",
      autoLockSeconds: 120,
      visibilityLossLocks: true,
      handoverPolicy: "LockThenRotateNamedSession",
      notificationMode: "VisualAndAudible",
      networkProcedureCode: "KDS-NETWORK-RECOVERY-V1",
      replacementProcedureCode: "KDS-REPLACEMENT-V1",
      checklistVersionCode: "KDS_UAT_V1",
      createdAt: at(10),
    },
    assignment: null,
    currentUat: null,
    createdByReference: ids.actor,
    createdAt: at(10),
    updatedAt: at(10),
    ...options,
  });
}
function assignment() {
  return {
    assignmentReference: ids.assignment,
    deviceReference: ids.device,
    stationReference: ids.station,
    effectiveFrom: at(11),
    effectiveTo: null,
  };
}
function passedUat() {
  return {
    runReference: ids.run,
    runNumber: 1,
    profileVersionReference: ids.version,
    deviceReference: ids.device,
    stationReference: ids.station,
    checklistVersionCode: "KDS_UAT_V1",
    browserVersionCode: "CHROME_140",
    logicalWidth: 1024,
    logicalHeight: 768,
    status: "Passed",
    dueAt: at(19),
    startedAt: at(12),
    completedAt: at(13),
    evidenceReference: ids.evidence,
    checks: kdsUatCheckCodes.map((checkCode, index) => ({
      resultReference: id(100 + index),
      checkCode,
      outcome: "Passed",
      safeResultCode: "PASSED",
      recordedAt: at(13),
    })),
  };
}
function fixture(
  options: { eligible?: boolean; fresh?: boolean; active?: boolean; evidence?: boolean } = {},
) {
  let latest: KdsProfileRecord | null = null;
  let deny = false;
  const operations = new Map<string, KdsProfileOperation>();
  const actions = {
    CreateKdsProfile: "device.kds-profile.create",
    ReviseKdsProfile: "device.kds-profile.revise",
    AssignKdsProfile: "device.kds-profile.assign",
    RecordKdsUat: "device.kds-profile.uat",
    PublishKdsProfile: "device.kds-profile.publish",
    RevokeKdsProfile: "device.kds-profile.revoke",
  } as const;
  const ports: KdsProfileManagementPorts = {
    authorization: {
      async authorize(input) {
        if (deny) return null;
        return {
          tenantReference: ids.tenant,
          tenantContext: tenant(input.observedAt),
          permission: {
            effect: "Allow",
            reason: "ROLE_PERMISSION",
            source: "RolePermission",
            action: actions[input.command],
            scopeKind: "Store",
            policySnapshotReference: ids.policy,
            policyVersion: 1,
            audit: { effect: "Allow", reason: "ROLE_PERMISSION", source: "RolePermission" },
          },
          audit: {
            auditId: ids.audit,
            brandId: ids.brand,
            storeId: ids.store,
            actor: { type: "User", reference: ids.actor },
            actionCode: `KDS_${input.command.toUpperCase()}`,
            targetType: "KdsProfile",
            targetId: input.targetReference,
            beforeSummary: {},
            afterSummary: {},
            reasonCode: "AUTHORIZED_KDS_PROFILE_OPERATION",
            correlationId: ids.correlation,
            occurredAt: input.observedAt,
            sourceChannel: "API",
            dataClassification: "Confidential",
            retentionPolicyCode: "KDS_PROFILE_OPERATION",
            retentionPolicyVersion: 1,
          },
        } as never;
      },
    },
    references: { hashIntent: (value) => `intent:${value}`, equals: (a, b) => a === b },
    eligibility: {
      async validate() {
        return {
          eligible: options.eligible ?? true,
          fresh: options.fresh ?? true,
          activeNamedOperatorSession: options.active ?? false,
        };
      },
    },
    evidence: {
      async isAccepted() {
        return options.evidence ?? true;
      },
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
        latest = operation.profile;
        operations.set(operation.operationReference, operation);
        return operation;
      },
    },
  };
  return {
    service: createKdsProfileManagementService(ports),
    deny() {
      deny = true;
    },
  };
}
const command = (
  operationReference: string,
  expectedRevision: number,
  value: KdsProfileRecord,
  occurredAt: string,
) => ({
  operationReference,
  expectedRevision,
  profile: value,
  purposeCode: "KDS_ADMIN",
  occurredAt,
});
describe("WP-2181 managed KDS Profile and Store UAT", () => {
  it("creates an exact Draft profile and reauthenticates idempotent replay", async () => {
    const test = fixture();
    const created = profile();
    await expect(
      test.service.createProfile(command(id(20), 0, created, at(10))),
    ).resolves.toMatchObject({ status: "Applied" });
    test.deny();
    await expect(
      test.service.createProfile(command(id(20), 0, created, at(10))),
    ).rejects.toMatchObject({ code: "KDS_PROFILE_PERMISSION_DENIED" });
  });
  it("assigns only an eligible fresh browser KDS", async () => {
    const test = fixture();
    const created = profile();
    await test.service.createProfile(command(id(20), 0, created, at(10)));
    const assigned = profile({ revision: 2, assignment: assignment(), updatedAt: at(11) });
    await expect(
      test.service.assignProfile(command(id(21), 1, assigned, at(11))),
    ).resolves.toMatchObject({ status: "Applied" });
    const blocked = fixture({ eligible: false });
    await blocked.service.createProfile(command(id(30), 0, created, at(10)));
    await expect(
      blocked.service.assignProfile(command(id(31), 1, assigned, at(11))),
    ).rejects.toMatchObject({ code: "KDS_PROFILE_ELIGIBILITY_BLOCKED" });
  });
  it("requires complete accepted evidence for Passed UAT", async () => {
    const test = fixture({ evidence: false });
    const created = profile();
    await test.service.createProfile(command(id(20), 0, created, at(10)));
    const assigned = profile({ revision: 2, assignment: assignment(), updatedAt: at(11) });
    await test.service.assignProfile(command(id(21), 1, assigned, at(11)));
    const passed = profile({
      revision: 3,
      assignment: assignment(),
      currentUat: passedUat(),
      updatedAt: at(13),
    });
    await expect(test.service.recordUat(command(id(22), 2, passed, at(13)))).rejects.toMatchObject({
      code: "KDS_PROFILE_EVIDENCE_REQUIRED",
    });
  });
  it("publishes only the exact Passed UAT with no active operator", async () => {
    const test = fixture();
    const created = profile();
    await test.service.createProfile(command(id(20), 0, created, at(10)));
    const assigned = profile({ revision: 2, assignment: assignment(), updatedAt: at(11) });
    await test.service.assignProfile(command(id(21), 1, assigned, at(11)));
    const passed = profile({
      revision: 3,
      assignment: assignment(),
      currentUat: passedUat(),
      updatedAt: at(13),
    });
    await test.service.recordUat(command(id(22), 2, passed, at(13)));
    const published = profile({
      revision: 4,
      lifecycle: "Published",
      assignment: assignment(),
      currentUat: passedUat(),
      updatedAt: at(14),
    });
    await expect(
      test.service.publishProfile(command(id(23), 3, published, at(14))),
    ).resolves.toMatchObject({ status: "Applied", profile: { lifecycle: "Published" } });
  });
  it("blocks publish during a named operator Session", async () => {
    const test = fixture({ active: true });
    const created = profile();
    await test.service.createProfile(command(id(20), 0, created, at(10)));
    const assigned = profile({ revision: 2, assignment: assignment(), updatedAt: at(11) });
    await test.service.assignProfile(command(id(21), 1, assigned, at(11)));
    const passed = profile({
      revision: 3,
      assignment: assignment(),
      currentUat: passedUat(),
      updatedAt: at(13),
    });
    await test.service.recordUat(command(id(22), 2, passed, at(13)));
    const published = profile({
      revision: 4,
      lifecycle: "Published",
      assignment: assignment(),
      currentUat: passedUat(),
      updatedAt: at(14),
    });
    await expect(
      test.service.publishProfile(command(id(23), 3, published, at(14))),
    ).rejects.toMatchObject({ code: "KDS_PROFILE_ELIGIBILITY_BLOCKED" });
  });
  it("rejects unsafe resolution, incomplete Passed checks and restricted extras", () => {
    expect(() =>
      profile({ currentVersion: { ...profile().currentVersion, minimumLogicalWidth: 800 } }),
    ).toThrow();
    expect(() =>
      profile({ assignment: assignment(), currentUat: { ...passedUat(), checks: [] } }),
    ).toThrow();
    expect(() => createKdsProfileRecord({ ...profile(), sharedCredential: "forbidden" })).toThrow();
  });
});
