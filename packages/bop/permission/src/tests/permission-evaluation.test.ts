import { describe, expect, it } from "vitest";
import { createBrand, createStore, createTenantContext } from "@bop/tenant";
import {
  PermissionEvaluationContractError,
  evaluatePermission,
  type PermissionEvaluationRequest,
  type PermissionEvidenceSource,
} from "../index.js";

const ids = {
  actor: "018f0000-0000-7000-8000-000000000001",
  brand: "018f0000-0000-7000-8000-000000000002",
  store: "018f0000-0000-7000-8000-000000000003",
  policy: "018f0000-0000-7000-8000-000000000004",
  deny: "018f0000-0000-7000-8000-000000000005",
  allow: "018f0000-0000-7000-8000-000000000006",
  role: "018f0000-0000-7000-8000-000000000007",
  roleEvidence: "018f0000-0000-7000-8000-000000000008",
  otherStore: "018f0000-0000-7000-8000-000000000009",
} as const;
const now = "2026-07-28T20:00:00.000Z";

function context(store = true) {
  const actor = {
    actorType: "User",
    actorReference: ids.actor,
    accountKind: "Workforce",
    status: "Active",
    authenticationMethod: "Oidc",
    verificationLevel: "SingleFactor",
    authenticatedAt: now,
    recentMfaAt: null,
  } as const;
  const brand = createBrand({
    brandReference: ids.brand,
    code: "SYNTHETIC",
    displayName: "Synthetic Brand",
    defaultLocale: "en-CA",
    currencyCode: "CAD",
    lifecycle: "Active",
    version: 1,
    createdAt: now,
    updatedAt: now,
  });
  const storeValue = store
    ? createStore({
        storeReference: ids.store,
        brandReference: ids.brand,
        code: "SYNTHETIC-1",
        displayName: "Synthetic Store",
        timeZone: "America/Toronto",
        locale: "en-CA",
        currencyCode: "CAD",
        lifecycle: "Active",
        version: 1,
        createdAt: now,
        updatedAt: now,
      })
    : null;
  return createTenantContext(actor as never, brand, storeValue, now);
}

function item(
  source: PermissionEvidenceSource,
  evidenceReference: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    source,
    evidenceReference,
    action: "synthetic.resource.update",
    actorReference: ids.actor,
    roleReference: source === "RolePermission" ? ids.role : null,
    brandReference: ids.brand,
    storeReference: null,
    effectiveFrom: "2026-01-01T00:00:00.000Z",
    effectiveUntil: null,
    ...overrides,
  };
}

function request(
  evidence: readonly ReturnType<typeof item>[],
  store = true,
): PermissionEvaluationRequest {
  const tenantContext = context(store);
  return {
    tenantContext,
    action: "synthetic.resource.update",
    resourceScope: {
      kind: store ? "Store" : "Brand",
      brandReference: ids.brand,
      storeReference: store ? ids.store : null,
    },
    policySnapshotReference: ids.policy,
    policyVersion: 3,
    evidence,
  } as PermissionEvaluationRequest;
}

describe("Permission Evaluation Contract", () => {
  it("defaults to a bounded denial without identifiers", () => {
    const result = evaluatePermission(request([]));
    expect(result).toEqual({
      effect: "Deny",
      reason: "DEFAULT_DENY",
      source: "DefaultDeny",
      action: "synthetic.resource.update",
      scopeKind: "Store",
      policySnapshotReference: ids.policy,
      policyVersion: 3,
      audit: { effect: "Deny", reason: "DEFAULT_DENY", source: "DefaultDeny" },
    });
    expect(JSON.stringify(result)).not.toContain(ids.actor);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("applies deny, explicit allow and role precedence independent of order", () => {
    const candidates = [
      item("RolePermission", ids.roleEvidence),
      item("ExplicitAllow", ids.allow),
      item("ExplicitDeny", ids.deny),
    ];
    expect(evaluatePermission(request(candidates)).reason).toBe("EXPLICIT_DENY");
    expect(evaluatePermission(request(candidates.toReversed())).reason).toBe("EXPLICIT_DENY");
    expect(evaluatePermission(request(candidates.slice(0, 2))).reason).toBe("EXPLICIT_ALLOW");
    expect(evaluatePermission(request(candidates.slice(0, 1))).reason).toBe("ROLE_PERMISSION");
  });

  it("allows Brand evidence in a Store but isolates sibling Store evidence", () => {
    expect(evaluatePermission(request([item("ExplicitAllow", ids.allow)])).effect).toBe("Allow");
    expect(
      evaluatePermission(
        request([item("ExplicitAllow", ids.allow, { storeReference: ids.otherStore })]),
      ).reason,
    ).toBe("DEFAULT_DENY");
  });

  it("ignores other action, Actor, Brand and expired evidence", () => {
    const cases = [
      { action: "synthetic.resource.read" },
      { actorReference: ids.otherStore },
      { brandReference: ids.otherStore },
      { effectiveUntil: "2026-07-28T20:00:00.000Z" },
      { effectiveFrom: "2026-07-28T20:00:00.001Z" },
    ];
    for (const override of cases)
      expect(evaluatePermission(request([item("ExplicitAllow", ids.allow, override)])).reason).toBe(
        "DEFAULT_DENY",
      );
  });

  it("fails closed on malformed or conflicting policy evidence", () => {
    const malformed = item("RolePermission", ids.roleEvidence, { roleReference: null });
    expect(evaluatePermission(request([malformed])).reason).toBe("INVALID_POLICY_EVIDENCE");
    const conflict = item("ExplicitDeny", ids.allow);
    expect(evaluatePermission(request([item("ExplicitAllow", ids.allow), conflict])).reason).toBe(
      "INVALID_POLICY_EVIDENCE",
    );
  });

  it("rejects forged scope, mutable context, wildcard and unknown request fields", () => {
    const forged = request([]);
    expect(() =>
      evaluatePermission({
        ...forged,
        resourceScope: { ...forged.resourceScope, storeReference: ids.otherStore },
      } as never),
    ).toThrowError(PermissionEvaluationContractError);
    expect(() =>
      evaluatePermission({ ...forged, tenantContext: { ...forged.tenantContext } }),
    ).toThrowError(PermissionEvaluationContractError);
    expect(() => evaluatePermission({ ...forged, action: "synthetic.*" } as never)).toThrowError(
      PermissionEvaluationContractError,
    );
    expect(() => evaluatePermission({ ...forged, extra: true } as never)).toThrowError(
      PermissionEvaluationContractError,
    );
  });

  it("requires exact Brand scope when no Store context exists", () => {
    const result = evaluatePermission(request([item("ExplicitAllow", ids.allow)], false));
    expect(result.effect).toBe("Allow");
    expect(result.scopeKind).toBe("Brand");
  });
});
