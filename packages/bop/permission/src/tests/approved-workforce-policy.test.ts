import { describe, expect, it } from "vitest";
import { parseApprovedWorkforceMembership } from "@bop/membership";
import {
  ApprovedWorkforcePolicyError,
  hashApprovedWorkforcePolicyPlan,
  hashApprovedWorkforcePolicyRequest,
  parseApprovedWorkforcePolicyPlan,
  parsePrepareApprovedWorkforcePolicy,
  parseHoldApprovedWorkforcePolicy,
} from "../contracts/approved-workforce-policy.js";
import * as f from "./current-policy.fixture.js";
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Controlled fixture missing");
  return value;
}
function policy() {
  return {
    profile: "ApprovedWorkforcePolicyV1",
    brandReference: f.BRAND,
    actorReference: f.ACTOR,
    membershipReference: f.MEMBERSHIP,
    effectiveFrom: f.FROM,
    effectiveUntil: f.UNTIL,
    roles: [
      {
        roleReference: f.BRAND_ROLE,
        roleCode: "invited_reviewer",
        effectiveFrom: "2026-07-01T00:00:00.000Z",
        effectiveUntil: f.LATER,
        assignment: {
          assignmentReference: f.BRAND_ASSIGNMENT,
          effectiveFrom: f.AT,
          effectiveUntil: f.UNTIL,
        },
        grants: [
          {
            grantReference: f.BRAND_GRANT,
            permissionReference: f.PERMISSION,
            action: "publishing.review.approve",
            effectiveFrom: f.FROM,
            effectiveUntil: f.LATER,
          },
        ],
      },
    ],
  };
}
function approval() {
  return parseApprovedWorkforceMembership({
    profile: "ApprovedWorkforceMembershipV1",
    operationReference: f.uuid("51"),
    planDigest: `sha256:${"1".repeat(64)}`,
    operatorReference: f.uuid("52"),
    approvedByReference: f.uuid("53"),
    approvalEvidenceReference: f.uuid("54"),
    environmentReference: f.uuid("55"),
    brandReference: f.BRAND,
    membershipReference: f.MEMBERSHIP,
    actorReference: f.ACTOR,
    workforceRelationshipReference: f.WORKFORCE,
    relationshipEvidenceReference: f.uuid("56"),
    relationshipRevision: 2,
    effectiveFrom: f.FROM,
    effectiveUntil: f.UNTIL,
    approvedPolicyDigest: hashApprovedWorkforcePolicyPlan(policy()),
  });
}
function prepare() {
  return {
    profile: "PrepareApprovedWorkforcePolicyV1",
    operationReference: f.uuid("51"),
    approval: approval(),
    policy: policy(),
    expectedPolicy: { snapshotReference: f.SNAPSHOT, version: 4 },
    policySnapshotReference: f.NEXT_SNAPSHOT,
  };
}

describe("approved Workforce policy contract", () => {
  it("binds independent finite role/grant/assignment periods without manufacturing organization.manage", () => {
    const parsed = parseApprovedWorkforcePolicyPlan(policy());
    expect(parsed.roles[0]?.grants.map((g) => g.action)).toEqual(["publishing.review.approve"]);
    expect(parsed.roles[0]?.effectiveUntil).toBe(f.LATER);
    expect(parsed.roles[0]?.assignment.effectiveUntil).toBe(f.UNTIL);
    expect(Object.isFrozen(parsed.roles[0]?.assignment)).toBe(true);
    expect(parsePrepareApprovedWorkforcePolicy(prepare()).expectedPolicy?.version).toBe(4);
    expect(
      parseHoldApprovedWorkforcePolicy({
        profile: "HoldApprovedWorkforcePolicyV1",
        approval: approval(),
        policy: policy(),
      }).approval.approvedPolicyDigest,
    ).toBe(hashApprovedWorkforcePolicyPlan(parsed));
  });
  it("canonicalizes order while binding every grant ID and independent period", () => {
    const first = policy();
    const role = first.roles[0];
    if (!role) throw new Error("Controlled role missing");
    role.grants.push({
      ...required(role.grants[0]),
      grantReference: f.uuid("71"),
      permissionReference: f.uuid("72"),
      action: "organization.manage",
    });
    const reordered = structuredClone(first);
    reordered.roles[0]?.grants.reverse();
    expect(hashApprovedWorkforcePolicyPlan(first)).toBe(hashApprovedWorkforcePolicyPlan(reordered));
    const changed = structuredClone(first);
    required(required(changed.roles[0]).grants[0]).effectiveUntil = "2026-07-28T13:30:00.000Z";
    expect(hashApprovedWorkforcePolicyPlan(changed)).not.toBe(
      hashApprovedWorkforcePolicyPlan(first),
    );
    expect(hashApprovedWorkforcePolicyRequest(prepare())).toMatch(/^sha256:[a-f0-9]{64}$/u);
  });
  it.each([
    (v: ReturnType<typeof policy>) => ({ ...v, storeReference: null }),
    (v: ReturnType<typeof policy>) => ({ ...v, roles: [] }),
    (v: ReturnType<typeof policy>) => ({ ...v, effectiveUntil: null }),
    (v: ReturnType<typeof policy>) => ({ ...v, effectiveUntil: v.effectiveFrom }),
    (v: ReturnType<typeof policy>) => ({ ...v, roles: [...v.roles, ...v.roles] }),
    (v: ReturnType<typeof policy>) => ({
      ...v,
      roles: [
        { ...v.roles[0], grants: [{ ...v.roles[0]?.grants[0], action: "identity.role.create" }] },
      ],
    }),
    (v: ReturnType<typeof policy>) => ({
      ...v,
      roles: [
        { ...v.roles[0], assignment: { ...v.roles[0]?.assignment, effectiveUntil: f.LATER } },
      ],
    }),
  ])(
    "rejects unapproved scope, empty/duplicate roles, nonfinite periods and action expansion",
    (mutate) => {
      expect(() => parseApprovedWorkforcePolicyPlan(mutate(policy()))).toThrow(
        ApprovedWorkforcePolicyError,
      );
    },
  );
  it("rejects sparse/accessor arrays and closed-record getters without executing them", () => {
    let calls = 0;
    const sparse = Array(1);
    expect(() => parseApprovedWorkforcePolicyPlan({ ...policy(), roles: sparse })).toThrow();
    const getter = Object.defineProperty(policy(), "brandReference", {
      enumerable: true,
      get() {
        calls++;
        return f.BRAND;
      },
    });
    expect(() => parseApprovedWorkforcePolicyPlan(getter)).toThrow();
    const entries = policy().roles;
    Object.defineProperty(entries, "0", {
      enumerable: true,
      get() {
        calls++;
        return undefined;
      },
    });
    expect(() => parseApprovedWorkforcePolicyPlan({ ...policy(), roles: entries })).toThrow();
    expect(calls).toBe(0);
  });
  it.each([
    (v: ReturnType<typeof prepare>) => ({ ...v, operationReference: f.uuid("60") }),
    (v: ReturnType<typeof prepare>) => ({
      ...v,
      approval: { ...v.approval, approvedPolicyDigest: `sha256:${"2".repeat(64)}` },
    }),
    (v: ReturnType<typeof prepare>) => ({
      ...v,
      policy: { ...v.policy, actorReference: f.uuid("60") },
    }),
    (v: ReturnType<typeof prepare>) => ({
      ...v,
      expectedPolicy: { ...v.expectedPolicy, version: 0 },
    }),
    (v: ReturnType<typeof prepare>) => ({
      ...v,
      expectedPolicy: { ...v.expectedPolicy, snapshotReference: v.policySnapshotReference },
    }),
  ])("rejects original, approval digest, target or CAS mismatch", (mutate) => {
    expect(() => parsePrepareApprovedWorkforcePolicy(mutate(prepare()))).toThrow();
  });
});
