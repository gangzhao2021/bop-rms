import { createIdentityActor } from "@bop/identity";
import { createMembership, createStoreAssignment, parseMembershipVersion } from "@bop/membership";
import { createBrand, createStore, createTenantContext } from "@bop/tenant";
import { describe, expect, it } from "vitest";
import {
  PermissionPolicyContractError,
  advancePolicyState,
  createPermissionDefinition,
  createPermissionGrant,
  createPermissionOverride,
  createPermissionRole,
  createPolicyState,
  createRoleAssignment,
  evaluatePermission,
  materializePermissionEvidence,
  parseBusinessAction,
  parsePolicyVersion,
  revokePermissionGrant,
  revokePermissionOverride,
  transitionPermissionDefinition,
  transitionPermissionRole,
  transitionRoleAssignment,
} from "../index.js";

const uuid = (suffix: string) => `018f4f8a-9c2d-7a11-8d01-${suffix.padStart(12, "0")}`;
const ACTOR = uuid("1");
const BRAND = uuid("2");
const OTHER_BRAND = uuid("3");
const STORE = uuid("4");
const MEMBERSHIP = uuid("5");
const WORKFORCE = uuid("6");
const STORE_ASSIGNMENT = uuid("7");
const PERMISSION = uuid("8");
const BRAND_ROLE = uuid("9");
const STORE_ROLE = uuid("10");
const BRAND_ASSIGNMENT = uuid("11");
const STORE_ROLE_ASSIGNMENT = uuid("12");
const BRAND_GRANT = uuid("13");
const STORE_GRANT = uuid("14");
const DENY = uuid("15");
const ALLOW = uuid("16");
const REASON = uuid("17");
const CORRELATION = uuid("18");
const SNAPSHOT = uuid("19");
const NEXT_SNAPSHOT = uuid("20");
const FROM = "2026-07-28T12:00:00.000Z";
const AT = "2026-07-28T12:30:00.000Z";
const UNTIL = "2026-07-28T13:00:00.000Z";
const LATER = "2026-07-28T14:00:00.000Z";
const ACTION = "synthetic.resource.update";

const actor = createIdentityActor({
  actorType: "User",
  actorReference: ACTOR,
  accountKind: "Workforce",
  status: "Active",
  authenticationMethod: "Oidc",
  verificationLevel: "SingleFactor",
  authenticatedAt: FROM,
  recentMfaAt: null,
});
const brand = createBrand({
  brandReference: BRAND,
  code: "SYNTHETIC",
  displayName: "Synthetic Brand",
  defaultLocale: "en-CA",
  currencyCode: "CAD",
  lifecycle: "Active",
  version: 1,
  createdAt: FROM,
  updatedAt: FROM,
});
const otherBrand = createBrand({
  ...brand,
  brandReference: OTHER_BRAND,
  code: "OTHER",
});
const store = createStore({
  storeReference: STORE,
  brandReference: BRAND,
  code: "SYNTHETIC_1",
  displayName: "Synthetic Store",
  timeZone: "America/Toronto",
  locale: "en-CA",
  currencyCode: "CAD",
  lifecycle: "Active",
  version: 1,
  createdAt: FROM,
  updatedAt: FROM,
});
const membership = createMembership(
  {
    membershipReference: MEMBERSHIP,
    actorReference: ACTOR,
    brandReference: BRAND,
    workforceRelationshipReference: WORKFORCE,
    lifecycle: "Active",
    effectiveFrom: FROM,
    effectiveUntil: UNTIL,
    version: 1,
    createdAt: FROM,
    updatedAt: FROM,
  },
  actor,
);
const storeAssignment = createStoreAssignment(
  {
    storeAssignmentReference: STORE_ASSIGNMENT,
    membershipReference: MEMBERSHIP,
    actorReference: ACTOR,
    brandReference: BRAND,
    storeReference: STORE,
    lifecycle: "Active",
    effectiveFrom: FROM,
    effectiveUntil: UNTIL,
    version: 1,
    createdAt: FROM,
    updatedAt: FROM,
  },
  membership,
  store,
);
const permission = createPermissionDefinition({
  permissionReference: PERMISSION,
  action: ACTION,
  lifecycle: "Active",
  version: 1,
  createdAt: FROM,
  updatedAt: FROM,
});
const brandRole = createPermissionRole(
  {
    roleReference: BRAND_ROLE,
    brandReference: BRAND,
    storeReference: null,
    code: "synthetic_manager",
    lifecycle: "Active",
    effectiveFrom: FROM,
    effectiveUntil: UNTIL,
    version: 1,
    createdAt: FROM,
    updatedAt: FROM,
  },
  brand,
  null,
);
const storeRole = createPermissionRole(
  {
    roleReference: STORE_ROLE,
    brandReference: BRAND,
    storeReference: STORE,
    code: "synthetic_operator",
    lifecycle: "Active",
    effectiveFrom: FROM,
    effectiveUntil: UNTIL,
    version: 1,
    createdAt: FROM,
    updatedAt: FROM,
  },
  brand,
  store,
);
const brandAssignment = createRoleAssignment(
  {
    assignmentReference: BRAND_ASSIGNMENT,
    roleReference: BRAND_ROLE,
    membershipReference: MEMBERSHIP,
    storeAssignmentReference: null,
    actorReference: ACTOR,
    brandReference: BRAND,
    storeReference: null,
    lifecycle: "Active",
    effectiveFrom: FROM,
    effectiveUntil: UNTIL,
    version: 1,
    createdAt: FROM,
    updatedAt: FROM,
  },
  brandRole,
  membership,
  null,
);
const storeRoleAssignment = createRoleAssignment(
  {
    assignmentReference: STORE_ROLE_ASSIGNMENT,
    roleReference: STORE_ROLE,
    membershipReference: MEMBERSHIP,
    storeAssignmentReference: STORE_ASSIGNMENT,
    actorReference: ACTOR,
    brandReference: BRAND,
    storeReference: STORE,
    lifecycle: "Active",
    effectiveFrom: FROM,
    effectiveUntil: UNTIL,
    version: 1,
    createdAt: FROM,
    updatedAt: FROM,
  },
  storeRole,
  membership,
  storeAssignment,
);
const brandGrant = createPermissionGrant(
  {
    grantReference: BRAND_GRANT,
    roleReference: BRAND_ROLE,
    permissionReference: PERMISSION,
    action: ACTION,
    brandReference: BRAND,
    storeReference: null,
    lifecycle: "Active",
    effectiveFrom: FROM,
    effectiveUntil: UNTIL,
    version: 1,
    createdAt: FROM,
    updatedAt: FROM,
  },
  brandRole,
  permission,
);
const storeGrant = createPermissionGrant(
  {
    grantReference: STORE_GRANT,
    roleReference: STORE_ROLE,
    permissionReference: PERMISSION,
    action: ACTION,
    brandReference: BRAND,
    storeReference: STORE,
    lifecycle: "Active",
    effectiveFrom: FROM,
    effectiveUntil: UNTIL,
    version: 1,
    createdAt: FROM,
    updatedAt: FROM,
  },
  storeRole,
  permission,
);
const policyState = createPolicyState(
  {
    brandReference: BRAND,
    snapshotReference: SNAPSHOT,
    version: 1,
    updatedAt: FROM,
  },
  brand,
);

const override = (effect: "Deny" | "Allow", reference: string, storeReference: string | null) =>
  createPermissionOverride(
    {
      overrideReference: reference,
      permissionReference: PERMISSION,
      action: ACTION,
      actorReference: ACTOR,
      brandReference: BRAND,
      storeReference,
      effect,
      lifecycle: "Active",
      reasonReference: REASON,
      correlationReference: CORRELATION,
      effectiveFrom: FROM,
      effectiveUntil: UNTIL,
      version: 1,
      createdAt: FROM,
      updatedAt: FROM,
    },
    permission,
  );

function materialization(overrides: Readonly<Record<string, unknown>> = {}) {
  return Object.freeze({
    tenantContext: createTenantContext(actor, brand, store, AT),
    policyState,
    membership,
    storeAssignment,
    permissionDefinitions: Object.freeze([permission]),
    roles: Object.freeze([brandRole, storeRole]),
    roleAssignments: Object.freeze([brandAssignment, storeRoleAssignment]),
    permissionGrants: Object.freeze([brandGrant, storeGrant]),
    permissionOverrides: Object.freeze([]),
    ...overrides,
  });
}

describe("Role, Permission Grant and Explicit Deny / Allow policy", () => {
  it("creates frozen exact-action, Brand and Store policy facts", () => {
    expect(Object.isFrozen(permission)).toBe(true);
    expect(Object.isFrozen(brandRole)).toBe(true);
    expect(Object.isFrozen(storeRoleAssignment)).toBe(true);
    expect(brandRole.storeReference).toBeNull();
    expect(storeRole.storeReference).toBe(STORE);
    expect(brandGrant.action).toBe(parseBusinessAction(ACTION));
  });

  it("rejects wildcards, unknown fields, accessors and foreign scope", () => {
    expect(() =>
      createPermissionDefinition({
        ...permission,
        permissionReference: uuid("21"),
        action: "synthetic.*",
      }),
    ).toThrow(PermissionPolicyContractError);
    expect(() =>
      createPermissionDefinition({ ...permission, permissionReference: uuid("21"), admin: true }),
    ).toThrowError("permission policy shape is invalid");
    let invoked = false;
    const input = Object.create(null);
    Object.defineProperty(input, "permissionReference", {
      enumerable: true,
      get() {
        invoked = true;
        return uuid("21");
      },
    });
    expect(() => createPermissionDefinition(input)).toThrow(PermissionPolicyContractError);
    expect(invoked).toBe(false);
    expect(() => createPermissionRole({ ...brandRole }, otherBrand, null)).toThrowError(
      "permission policy scope is invalid",
    );
  });

  it("requires exact active Membership and Store Assignment relationships", () => {
    expect(() =>
      createRoleAssignment(
        { ...storeRoleAssignment, storeAssignmentReference: null },
        storeRole,
        membership,
        storeAssignment,
      ),
    ).toThrowError("permission policy dependency is invalid");
    const suspendedMembership = {
      ...membership,
      lifecycle: "Suspended",
      version: parseMembershipVersion(2),
      updatedAt: AT,
    } as const;
    expect(() =>
      materializePermissionEvidence(
        materialization({ membership: Object.freeze(suspendedMembership) }) as never,
      ),
    ).toThrowError("permission policy materialization is invalid");
  });

  it("enforces expected version, terminal lifecycle and fresh policy snapshots", () => {
    expect(() =>
      transitionPermissionRole(brandRole, parsePolicyVersion(2), "Suspended", AT),
    ).toThrowError("permission policy version conflict");
    const suspended = transitionPermissionRole(brandRole, parsePolicyVersion(1), "Suspended", AT);
    expect(suspended).toMatchObject({ lifecycle: "Suspended", version: 2 });
    const retired = transitionPermissionDefinition(
      permission,
      parsePolicyVersion(1),
      "Retired",
      AT,
    );
    expect(() =>
      transitionPermissionDefinition(retired, parsePolicyVersion(2), "Active", LATER),
    ).toThrowError("permission policy transition is invalid");
    expect(advancePolicyState(policyState, parsePolicyVersion(1), NEXT_SNAPSHOT, AT)).toMatchObject(
      { snapshotReference: NEXT_SNAPSHOT, version: 2 },
    );
    expect(() => advancePolicyState(policyState, parsePolicyVersion(1), SNAPSHOT, AT)).toThrowError(
      "permission policy transition is invalid",
    );
  });

  it("uses half-open periods and revocation instead of deletion", () => {
    const ended = transitionRoleAssignment(brandAssignment, parsePolicyVersion(1), "Ended", AT);
    expect(ended.lifecycle).toBe("Ended");
    expect(() =>
      transitionRoleAssignment(ended, parsePolicyVersion(2), "Active", LATER),
    ).toThrowError("permission policy transition is invalid");
    const revokedGrant = revokePermissionGrant(brandGrant, parsePolicyVersion(1), AT);
    const revokedOverride = revokePermissionOverride(
      override("Allow", ALLOW, null),
      parsePolicyVersion(1),
      AT,
    );
    expect(revokedGrant.lifecycle).toBe("Revoked");
    expect(revokedOverride.lifecycle).toBe("Revoked");
  });

  it("materializes Brand inheritance and exact Store Role evidence deterministically", () => {
    const result = materializePermissionEvidence(materialization() as never);
    expect(result).toMatchObject({
      policySnapshotReference: SNAPSHOT,
      policyVersion: 1,
      audit: { source: "PermissionPolicy", evidenceCount: 2 },
    });
    expect(result.evidence.map((item) => [item.source, item.storeReference])).toEqual([
      ["RolePermission", null],
      ["RolePermission", STORE],
    ]);
    expect(result.evidence.map((item) => item.evidenceReference)).toEqual(
      [BRAND_GRANT, STORE_GRANT].sort(),
    );
    expect(Object.isFrozen(result.evidence)).toBe(true);
  });

  it("preserves explicit deny over explicit allow and Role Permission", () => {
    const result = materializePermissionEvidence(
      materialization({
        permissionOverrides: Object.freeze([
          override("Allow", ALLOW, null),
          override("Deny", DENY, STORE),
        ]),
      }) as never,
    );
    const decision = evaluatePermission({
      tenantContext: materialization().tenantContext,
      action: parseBusinessAction(ACTION),
      resourceScope: Object.freeze({
        kind: "Store",
        brandReference: brand.brandReference,
        storeReference: store.storeReference,
      }),
      policySnapshotReference: result.policySnapshotReference,
      policyVersion: result.policyVersion,
      evidence: result.evidence,
    });
    expect(decision).toMatchObject({
      effect: "Deny",
      reason: "EXPLICIT_DENY",
      source: "ExplicitDeny",
    });
    expect(result.evidence.map((item) => item.source)).toEqual([
      "ExplicitDeny",
      "ExplicitAllow",
      "RolePermission",
      "RolePermission",
    ]);
  });

  it("does not materialize expired, retired, suspended or foreign facts", () => {
    const expiredOverride = Object.freeze({
      ...override("Allow", ALLOW, null),
      effectiveUntil: AT,
    });
    const suspendedRole = transitionPermissionRole(
      brandRole,
      parsePolicyVersion(1),
      "Suspended",
      AT,
    );
    const result = materializePermissionEvidence(
      materialization({
        roles: Object.freeze([suspendedRole, storeRole]),
        permissionOverrides: Object.freeze([expiredOverride]),
      }) as never,
    );
    expect(result.evidence.map((item) => item.evidenceReference)).toEqual([STORE_GRANT]);
  });

  it("fails closed on duplicate identities, mutable facts and foreign policy state", () => {
    expect(() =>
      materializePermissionEvidence(
        materialization({
          roles: Object.freeze([
            brandRole,
            Object.freeze({ ...brandRole, lifecycle: "Suspended" }),
          ]),
        }) as never,
      ),
    ).toThrowError("permission policy materialization is invalid");
    expect(() =>
      materializePermissionEvidence(materialization({ roles: [brandRole, storeRole] }) as never),
    ).toThrowError("permission policy materialization is invalid");
    expect(() =>
      materializePermissionEvidence(
        materialization({
          policyState: Object.freeze({ ...policyState, brandReference: OTHER_BRAND }),
        }) as never,
      ),
    ).toThrowError("permission policy materialization is invalid");
  });

  it("returns only bounded policy evidence and audit metadata", () => {
    const result = materializePermissionEvidence(
      materialization({
        permissionOverrides: Object.freeze([override("Deny", DENY, STORE)]),
      }) as never,
    );
    expect(Object.keys(result).sort()).toEqual([
      "audit",
      "evidence",
      "policySnapshotReference",
      "policyVersion",
    ]);
    expect(JSON.stringify(result)).not.toContain(REASON);
    expect(JSON.stringify(result)).not.toContain(CORRELATION);
    expect(JSON.stringify(result)).not.toContain("Synthetic Brand");
  });
});
