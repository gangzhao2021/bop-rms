import { createBrand, createTenantContext } from "@bop/tenant";
import { describe, expect, it } from "vitest";
import {
  compareRoleAdministration,
  createRoleAdministrationVersion,
  executeRoleAdministration,
  RoleAdministrationContractError,
} from "../index.js";

const id = (n: string) => `018f0000-0000-7000-8000-0000000000${n}`;
const at = "2026-08-15T15:00:00.000Z";
const selection = {
  permissionReference: id("10"),
  action: "identity.role.view",
  groupCode: "role_admin",
  highRisk: false,
  dependencyActions: [],
} as const;
function version(overrides: Record<string, unknown> = {}) {
  return createRoleAdministrationVersion({
    administrationReference: id("11"),
    roleReference: id("12"),
    version: 1,
    brandReference: id("02"),
    storeReference: null,
    code: "access_admin",
    displayName: "Access administrator",
    description: "Synthetic role administration fixture",
    roleType: "Custom",
    lifecycle: "Draft",
    sourcePolicyVersion: 7,
    selections: [selection],
    authoredByReference: id("01"),
    submittedByReference: null,
    approvedByReference: null,
    decisionEvidenceReference: null,
    reasonCode: "ROLE_ADMIN_CHANGE",
    changedAt: at,
    ...overrides,
  });
}
function context() {
  const actor = {
    actorType: "User",
    accountKind: "Workforce",
    actorReference: id("01"),
    status: "Active",
    authenticationMethod: "Oidc",
    verificationLevel: "SingleFactor",
    authenticatedAt: at,
    recentMfaAt: null,
  } as const;
  return createTenantContext(
    actor as never,
    createBrand({
      brandReference: id("02"),
      code: "SYNTH",
      displayName: "Synthetic",
      defaultLocale: "en-CA",
      currencyCode: "CAD",
      lifecycle: "Active",
      version: 1,
      createdAt: at,
      updatedAt: at,
    }),
    null,
    at,
  );
}
describe("WP-2195 role administration", () => {
  it("keeps versions closed and prevents system-role drafting or self approval", () => {
    expect(Object.isFrozen(version())).toBe(true);
    expect(() => version({ extra: true })).toThrow(RoleAdministrationContractError);
    expect(() => version({ roleType: "System" })).toThrow(RoleAdministrationContractError);
    expect(() =>
      version({
        lifecycle: "Approved",
        submittedByReference: id("03"),
        approvedByReference: id("03"),
        decisionEvidenceReference: id("14"),
      }),
    ).toThrow(RoleAdministrationContractError);
  });
  it("compares high-risk changes and blocks missing permission dependencies", () => {
    const candidate = version({
      version: 2,
      selections: [
        selection,
        {
          permissionReference: id("15"),
          action: "identity.role.activate",
          groupCode: "role_admin",
          highRisk: true,
          dependencyActions: ["identity.role.approve"],
        },
      ],
    });
    expect(compareRoleAdministration(version(), candidate, 4)).toMatchObject({
      added: ["identity.role.activate"],
      highRiskChanges: ["identity.role.activate"],
      affectedAssignmentCount: 4,
      activationBlocked: true,
    });
  });
  it("authorizes the exact action and atomically commits Audit with a draft version", async () => {
    const current = version(),
      next = version({ version: 2 }),
      commits: unknown[] = [];
    await executeRoleAdministration(
      {
        tenantContext: context(),
        operation: "SaveDraft",
        expectedVersion: current.version,
        idempotencyKey: "wp2195.save-draft.0001",
        current,
        next,
        auditId: id("16") as never,
        correlationId: id("17") as never,
        sourceChannel: "MERCHANT_WEB",
      },
      {
        authorization: {
          authorize: async (request) =>
            Object.freeze({
              effect: "Allow",
              action: request.action,
              scopeKind: "Brand",
              reason: "EXPLICIT_ALLOW",
              source: "ExplicitAllow",
            }) as never,
        },
        impact: { countActiveAssignments: async () => 0 },
        policy: { currentVersion: async () => 7 },
        unitOfWork: { commit: async (input) => void commits.push(input) },
      },
    );
    expect(commits).toHaveLength(1);
  });
  it("fails closed when activation is evaluated against a newer policy", async () => {
    const current = version({
      lifecycle: "Approved",
      submittedByReference: id("03"),
      approvedByReference: id("04"),
      decisionEvidenceReference: id("14"),
    });
    const next = version({
      version: 2,
      lifecycle: "Active",
      submittedByReference: id("03"),
      approvedByReference: id("04"),
      decisionEvidenceReference: id("14"),
    });
    await expect(
      executeRoleAdministration(
        {
          tenantContext: context(),
          operation: "Activate",
          expectedVersion: current.version,
          idempotencyKey: "wp2195.activate.0001",
          current,
          next,
          auditId: id("16") as never,
          correlationId: id("17") as never,
          sourceChannel: "MERCHANT_WEB",
        },
        {
          authorization: {
            authorize: async (request) =>
              Object.freeze({
                effect: "Allow",
                action: request.action,
                scopeKind: "Brand",
                reason: "EXPLICIT_ALLOW",
                source: "ExplicitAllow",
              }) as never,
          },
          impact: { countActiveAssignments: async () => 2 },
          policy: { currentVersion: async () => 8 },
          unitOfWork: { commit: async () => undefined },
        },
      ),
    ).rejects.toMatchObject({ code: "ROLE_ADMIN_POLICY_CONFLICT" });
  });
});
