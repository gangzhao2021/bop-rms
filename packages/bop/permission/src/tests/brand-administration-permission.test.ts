import { describe, expect, it } from "vitest";
import { createMembership } from "@bop/membership";
import { createBrand, createBrandAdministrationContext } from "@bop/tenant";
import {
  brandAdministrationPermissionActions,
  parseBrandAdministrationPermissionAction,
  revalidateBrandAdministrationPermissionContext,
} from "../contracts/brand-administration-permission.js";
import {
  materializeBrandAdministrationPermissionEvidence,
  materializePermissionEvidence,
} from "../application/materialize-policy-evidence.js";
import {
  evaluateBrandAdministrationPermission,
  evaluatePermission,
} from "../application/evaluate-permission.js";
import {
  createBrandAdministrationPermissionRole,
  createBrandAdministrationPolicyState,
  createPermissionDefinition,
  createPermissionGrant,
  createPermissionOverride,
  createRoleAssignment,
} from "../domain/permission-policy.js";
import * as f from "./current-policy.fixture.js";

function fixture(lifecycle: "Draft" | "Active" | "Suspended" | "Archived" = "Draft") {
  const brand = createBrand({ ...f.brand, lifecycle });
  const context = createBrandAdministrationContext(f.actor, brand, f.AT);
  const definition = createPermissionDefinition({
    permissionReference: f.PERMISSION,
    action: "organization.manage",
    lifecycle: "Active",
    version: 1,
    createdAt: f.FROM,
    updatedAt: f.FROM,
  });
  const role = createBrandAdministrationPermissionRole(
    {
      roleReference: f.BRAND_ROLE,
      brandReference: f.BRAND,
      storeReference: null,
      code: "synthetic_brand_admin",
      lifecycle: "Active",
      effectiveFrom: f.FROM,
      effectiveUntil: f.UNTIL,
      version: 1,
      createdAt: f.FROM,
      updatedAt: f.FROM,
    },
    brand,
  );
  const assignment = createRoleAssignment(
    {
      assignmentReference: f.BRAND_ASSIGNMENT,
      roleReference: role.roleReference,
      membershipReference: f.MEMBERSHIP,
      storeAssignmentReference: null,
      actorReference: f.ACTOR,
      brandReference: f.BRAND,
      storeReference: null,
      lifecycle: "Active",
      effectiveFrom: f.FROM,
      effectiveUntil: f.UNTIL,
      version: 1,
      createdAt: f.FROM,
      updatedAt: f.FROM,
    },
    role,
    f.membership,
    null,
  );
  const grant = createPermissionGrant(
    {
      grantReference: f.BRAND_GRANT,
      roleReference: role.roleReference,
      permissionReference: definition.permissionReference,
      action: definition.action,
      brandReference: f.BRAND,
      storeReference: null,
      lifecycle: "Active",
      effectiveFrom: f.FROM,
      effectiveUntil: f.UNTIL,
      version: 1,
      createdAt: f.FROM,
      updatedAt: f.FROM,
    },
    role,
    definition,
  );
  const override = (effect: "Allow" | "Deny") =>
    createPermissionOverride(
      {
        overrideReference: effect === "Allow" ? f.ALLOW : f.DENY,
        permissionReference: definition.permissionReference,
        action: definition.action,
        actorReference: f.ACTOR,
        brandReference: f.BRAND,
        storeReference: null,
        effect,
        lifecycle: "Active",
        reasonReference: f.REASON,
        correlationReference: f.CORRELATION,
        effectiveFrom: f.FROM,
        effectiveUntil: f.UNTIL,
        version: 1,
        createdAt: f.FROM,
        updatedAt: f.FROM,
      },
      definition,
    );
  const input = Object.freeze({
    administrationContext: context,
    policyState: createBrandAdministrationPolicyState(
      { brandReference: f.BRAND, snapshotReference: f.SNAPSHOT, version: 1, updatedAt: f.FROM },
      brand,
    ),
    membership: f.membership,
    storeAssignment: null,
    permissionDefinitions: Object.freeze([definition]),
    roles: Object.freeze([role]),
    roleAssignments: Object.freeze([assignment]),
    permissionGrants: Object.freeze([grant]),
    permissionOverrides: Object.freeze([] as ReturnType<typeof override>[]),
  });
  const policy = materializeBrandAdministrationPermissionEvidence(input);
  const request = {
    administrationContext: context,
    action: "organization.manage",
    resourceScope: {
      kind: "Brand" as const,
      brandReference: brand.brandReference,
      storeReference: null,
    },
    policySnapshotReference: policy.policySnapshotReference,
    policyVersion: policy.policyVersion,
    evidence: policy.evidence,
  };
  return { context, input, request, override, policy };
}

describe("Brand administrative Permission boundary", () => {
  it.each(["Draft", "Active", "Suspended", "Archived"] as const)(
    "uses real %s identity and actual Membership/role/grant without operational context",
    (lifecycle) => {
      const x = fixture(lifecycle);
      expect(x.context.brand.lifecycle).toBe(lifecycle);
      expect(x.context).not.toHaveProperty("scopeKind");
      expect(evaluateBrandAdministrationPermission(x.request)).toMatchObject({
        effect: "Allow",
        reason: "ROLE_PERMISSION",
        scopeKind: "Brand",
      });
      expect(x.policy.activeRoleCodes).toEqual(["synthetic_brand_admin"]);
      const { administrationContext, ...facts } = x.input;
      expect(() =>
        materializePermissionEvidence(
          Object.freeze({ ...facts, tenantContext: administrationContext }) as never,
        ),
      ).toThrow();
      const { administrationContext: selected, ...request } = x.request;
      expect(() => evaluatePermission({ ...request, tenantContext: selected } as never)).toThrow();
    },
  );
  it("admits exactly the six existing configuration actions", () => {
    expect(brandAdministrationPermissionActions).toEqual([
      "organization.manage",
      "publishing.draft.create",
      "publishing.review.submit",
      "publishing.review.approve",
      "publishing.release.publish",
      "publishing.release.archive",
    ]);
    for (const action of brandAdministrationPermissionActions)
      expect(parseBrandAdministrationPermissionAction(action)).toBe(action);
    const x = fixture();
    for (const action of [
      "iam.manage",
      "catalog.product.read",
      "merchant.access",
      "brand.create",
      "publishing.*",
      "organization.manage ",
    ])
      expect(() => evaluateBrandAdministrationPermission({ ...x.request, action })).toThrow();
    for (const action of brandAdministrationPermissionActions.filter(
      (v) => v !== "organization.manage",
    ))
      expect(evaluateBrandAdministrationPermission({ ...x.request, action }).effect).toBe("Deny");
  });
  it("keeps explicit Deny above actual Allow and Role grants; absence defaults to Deny", () => {
    const x = fixture();
    const policy = materializeBrandAdministrationPermissionEvidence(
      Object.freeze({
        ...x.input,
        permissionOverrides: Object.freeze([x.override("Allow"), x.override("Deny")]),
      }),
    );
    expect(
      evaluateBrandAdministrationPermission({ ...x.request, evidence: policy.evidence }),
    ).toMatchObject({ effect: "Deny", reason: "EXPLICIT_DENY" });
    expect(evaluateBrandAdministrationPermission({ ...x.request, evidence: [] })).toMatchObject({
      effect: "Deny",
      reason: "DEFAULT_DENY",
    });
  });
  it("does not materialize unrelated commerce grants into an administrative evidence packet", () => {
    const x = fixture(),
      role = x.input.roles[0];
    if (!role) throw new Error("Missing controlled role");
    const definition = createPermissionDefinition({
      ...x.input.permissionDefinitions[0],
      permissionReference: f.uuid("901"),
      action: "catalog.product.read",
    });
    const grant = createPermissionGrant(
      {
        ...x.input.permissionGrants[0],
        grantReference: f.uuid("902"),
        permissionReference: definition.permissionReference,
        action: definition.action,
      },
      role,
      definition,
    );
    const policy = materializeBrandAdministrationPermissionEvidence(
      Object.freeze({
        ...x.input,
        permissionDefinitions: Object.freeze([...x.input.permissionDefinitions, definition]),
        permissionGrants: Object.freeze([...x.input.permissionGrants, grant]),
      }),
    );
    expect(policy.evidence.map((item) => item.action)).toEqual(["organization.manage"]);
    expect(policy.audit.evidenceCount).toBe(1);
  });
  it("retains exact evidence scope, Actor and half-open validity", () => {
    const x = fixture(),
      evidence = x.policy.evidence[0];
    if (!evidence) throw new Error("Missing controlled evidence");
    for (const change of [
      { actorReference: f.uuid("999") },
      { brandReference: f.OTHER_BRAND },
      { storeReference: f.STORE },
      { effectiveFrom: f.LATER },
      { effectiveUntil: f.AT },
    ])
      expect(
        evaluateBrandAdministrationPermission({
          ...x.request,
          evidence: [Object.freeze({ ...evidence, ...change })],
        } as never).effect,
      ).toBe("Deny");
    expect(() =>
      evaluateBrandAdministrationPermission({
        ...x.request,
        resourceScope: { ...x.request.resourceScope, kind: "Store", storeReference: f.STORE },
      } as never),
    ).toThrow();
    expect(() =>
      evaluateBrandAdministrationPermission({
        ...x.request,
        resourceScope: { ...x.request.resourceScope, brandReference: f.otherBrand.brandReference },
      }),
    ).toThrow();
  });
  it("requires current exact active Membership and rejects Store assignments", () => {
    const x = fixture();
    for (const change of [
      { lifecycle: "Suspended" },
      { effectiveUntil: f.AT },
      { brandReference: f.OTHER_BRAND },
    ]) {
      const membership = createMembership({ ...f.membership, ...change }, f.actor);
      expect(() =>
        materializeBrandAdministrationPermissionEvidence(Object.freeze({ ...x.input, membership })),
      ).toThrow();
    }
    expect(() =>
      materializeBrandAdministrationPermissionEvidence(
        Object.freeze({ ...x.input, storeAssignment: f.storeAssignment }) as never,
      ),
    ).toThrow();
  });
  it("rejects wrong purpose, operational/Store context, extra properties and getters", () => {
    const x = fixture();
    for (const context of [
      f.tenantContext,
      { ...x.context, purposeCode: "CATALOG" },
      { ...x.context, store: f.store },
      { ...x.context, scopeKind: "Brand" },
    ])
      expect(() =>
        revalidateBrandAdministrationPermissionContext(Object.freeze(context)),
      ).toThrow();
    expect(() =>
      evaluateBrandAdministrationPermission({
        ...x.request,
        tenantContext: f.tenantContext,
      } as never),
    ).toThrow();
    let invoked = false;
    const malicious = Object.freeze({
      ...x.context,
      get actor() {
        invoked = true;
        return f.actor;
      },
    });
    expect(() => revalidateBrandAdministrationPermissionContext(malicious)).toThrow();
    expect(invoked).toBe(false);
  });
  it("rejects accessor and sparse arrays without invoking their values", () => {
    const x = fixture();
    let invoked = false;
    const accessor: unknown[] = [];
    Object.defineProperty(accessor, "0", {
      enumerable: true,
      get() {
        invoked = true;
        return x.policy.evidence[0];
      },
    });
    expect(
      evaluateBrandAdministrationPermission({ ...x.request, evidence: accessor } as never),
    ).toMatchObject({ effect: "Deny", reason: "INVALID_POLICY_EVIDENCE" });
    expect(invoked).toBe(false);
    expect(
      evaluateBrandAdministrationPermission({ ...x.request, evidence: new Array(1) } as never)
        .effect,
    ).toBe("Deny");
    expect(() =>
      materializeBrandAdministrationPermissionEvidence(
        Object.freeze({ ...x.input, permissionGrants: Object.freeze(new Array(1)) }) as never,
      ),
    ).toThrow();
  });
});
