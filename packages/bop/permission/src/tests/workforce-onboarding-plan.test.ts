import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { describe, expect, it } from "vitest";
import {
  parseWorkforceOnboardingPlan,
  hashWorkforceOnboardingPlan,
  deriveWorkforceOnboardingPlan,
} from "../contracts/workforce-onboarding-plan.js";
const id = (n: number) => `0190ed60-0000-7000-8000-${String(n).padStart(12, "0")}`;
function input() {
  return {
    profile: "WorkforceOnboardingPlanV1",
    purposeCode: "WORKFORCE_ONBOARDING",
    configuration: {
      environment: "controlled",
      issuer: "https://cognito-idp.ca-central-1.amazonaws.com/ca-central-1_Controlled",
      clientId: "controlledclient",
    },
    environmentReference: id(1),
    operationReference: id(2),
    operatorReference: id(3),
    approvedByReference: id(4),
    approvalEvidenceReference: id(5),
    brandReference: id(6),
    actorReference: id(7),
    membershipReference: id(8),
    workforceRelationshipReference: id(9),
    relationshipEvidenceReference: id(10),
    relationshipRevision: 2,
    effectiveFrom: "2026-10-06T12:00:00.000Z",
    effectiveUntil: "2026-11-06T12:00:00.000Z",
    emailDigest: "a".repeat(64),
    policy: {
      profile: "ApprovedWorkforcePolicyV1",
      brandReference: id(6),
      actorReference: id(7),
      membershipReference: id(8),
      effectiveFrom: "2026-10-06T12:00:00.000Z",
      effectiveUntil: "2026-11-06T12:00:00.000Z",
      roles: [
        {
          roleReference: id(11),
          roleCode: "invited_reviewer",
          effectiveFrom: "2026-10-01T00:00:00.000Z",
          effectiveUntil: "2026-12-01T00:00:00.000Z",
          assignment: {
            assignmentReference: id(12),
            effectiveFrom: "2026-10-06T12:00:00.000Z",
            effectiveUntil: "2026-11-06T12:00:00.000Z",
          },
          grants: [
            {
              grantReference: id(13),
              permissionReference: id(14),
              action: "publishing.review.approve",
              effectiveFrom: "2026-10-01T00:00:00.000Z",
              effectiveUntil: "2026-12-01T00:00:00.000Z",
            },
          ],
        },
      ],
    },
    expectedPolicy: { snapshotReference: id(15), version: 4 },
    policySnapshotReference: id(16),
    reasonCode: "APPROVED_WORKFORCE_ONBOARDING",
  };
}
describe("complete static Workforce onboarding plan", () => {
  it("derives one nonrecursive approval, exact policy request and Brand-only journal original", () => {
    const raw = input(),
      result = deriveWorkforceOnboardingPlan(raw);
    expect(result.planDigest).toBe(`sha256:${sha256Hex(canonicalizeRfc8785(result.plan))}`);
    expect(result.approvedMembership.planDigest).toBe(result.planDigest);
    expect(result.approvalExpected).toEqual({
      environmentReference: id(1),
      operationReference: id(2),
      brandReference: id(6),
      actorReference: id(7),
      membershipReference: id(8),
      operatorReference: id(3),
      planDigest: result.planDigest,
    });
    expect(result.preparePolicy.approval).toEqual(result.approvedMembership);
    expect(result.preparePolicy.policy).toEqual(result.plan.policy);
    expect(result.original).toMatchObject({
      approvedPlanDigest: result.planDigest,
      storeAssignmentReferences: [],
      emailDigest: raw.emailDigest,
      configuration: raw.configuration,
    });
    expect(result.plan.policy.roles[0]?.grants.map((g) => g.action)).toEqual([
      "publishing.review.approve",
    ]);
    expect(Object.keys(result.plan)).toHaveLength(21);
    expect("planDigest" in result.plan).toBe(false);
    expect(Object.isFrozen(result.plan.policy.roles[0]?.grants[0])).toBe(true);
    const role = raw.policy.roles[0],
      grant = role?.grants[0];
    if (!role || !grant) throw new Error("Controlled role/grant missing");
    role.grants.push({
      ...grant,
      grantReference: id(30),
      permissionReference: id(31),
      action: "organization.manage",
    });
    expect(result.plan.policy.roles[0]?.grants).toHaveLength(1);
  });
  it("permits explicit null expected policy without inventing a head or grants", () => {
    const result = deriveWorkforceOnboardingPlan({ ...input(), expectedPolicy: null });
    expect(result.preparePolicy.expectedPolicy).toBeNull();
    expect(result.plan.policy.roles[0]?.effectiveUntil).toBe("2026-12-01T00:00:00.000Z");
  });
  it.each([
    "brandReference",
    "actorReference",
    "membershipReference",
    "effectiveFrom",
    "effectiveUntil",
  ])("rejects nested scope/period mismatch %s", (key) => {
    const raw = input();
    expect(() =>
      parseWorkforceOnboardingPlan({
        ...raw,
        policy: {
          ...raw.policy,
          [key]: key.startsWith("effective") ? "2026-10-07T12:00:00.000Z" : id(99),
        },
      }),
    ).toThrow();
  });
  it.each(["operator", "target"])("rejects nonindependent approval identity %s", (key) => {
    const raw = input();
    expect(() =>
      parseWorkforceOnboardingPlan({
        ...raw,
        approvedByReference: key === "operator" ? raw.operatorReference : raw.actorReference,
      }),
    ).toThrow();
  });
  it.each([
    "recursiveDigest",
    "rawEmail",
    "wrongPurpose",
    "invalidRevision",
    "infinite",
    "sameHead",
    "stringVersion",
    "emptyRoles",
  ])("rejects invalid plan %s", (key) => {
    const raw = input();
    const changed =
      key === "recursiveDigest"
        ? { ...raw, planDigest: `sha256:${"a".repeat(64)}` }
        : key === "rawEmail"
          ? { ...raw, emailDigest: "person@example.invalid" }
          : key === "wrongPurpose"
            ? { ...raw, purposeCode: "BRAND_INITIAL_PROVISIONING" }
            : key === "invalidRevision"
              ? { ...raw, relationshipRevision: 0 }
              : key === "infinite"
                ? { ...raw, effectiveUntil: "infinity" }
                : key === "sameHead"
                  ? { ...raw, policySnapshotReference: raw.expectedPolicy.snapshotReference }
                  : key === "stringVersion"
                    ? { ...raw, expectedPolicy: { ...raw.expectedPolicy, version: "4" } }
                    : { ...raw, policy: { ...raw.policy, roles: [] } };
    expect(() => parseWorkforceOnboardingPlan(changed)).toThrow();
  });
  it("does not execute getters or accept sparse/extra array keys", () => {
    let calls = 0;
    const raw = input();
    Object.defineProperty(raw, "emailDigest", {
      enumerable: true,
      get: () => {
        calls++;
        return "a".repeat(64);
      },
    });
    expect(() => parseWorkforceOnboardingPlan(raw)).toThrow();
    expect(calls).toBe(0);
    const sparse = input();
    delete sparse.policy.roles[0];
    expect(() => parseWorkforceOnboardingPlan(sparse)).toThrow();
    const extra = input();
    Object.defineProperty(extra.policy.roles, "other", { value: true });
    expect(() => parseWorkforceOnboardingPlan(extra)).toThrow();
  });
  it("binds all valid independent top-level approved facts into the digest", () => {
    const raw = input(),
      initial = hashWorkforceOnboardingPlan(raw);
    for (const key of [
      "environmentReference",
      "operationReference",
      "operatorReference",
      "approvedByReference",
      "approvalEvidenceReference",
      "workforceRelationshipReference",
      "relationshipEvidenceReference",
      "policySnapshotReference",
    ] as const)
      expect(hashWorkforceOnboardingPlan({ ...raw, [key]: id(99) })).not.toBe(initial);
    for (const changed of [
      { ...raw, configuration: { ...raw.configuration, clientId: "otherclient" } },
      { ...raw, relationshipRevision: 3 },
      { ...raw, emailDigest: "b".repeat(64) },
      { ...raw, reasonCode: "INDEPENDENT_REASON" },
      { ...raw, expectedPolicy: { ...raw.expectedPolicy, version: 5 } },
    ])
      expect(hashWorkforceOnboardingPlan(changed)).not.toBe(initial);
    expect(hashWorkforceOnboardingPlan(Object.fromEntries(Object.entries(raw).reverse()))).toBe(
      initial,
    );
  });
  it("hashes coherent scope/period changes and exact nested approved policy content", () => {
    const raw = input(),
      initial = hashWorkforceOnboardingPlan(raw);
    for (const key of ["brandReference", "actorReference", "membershipReference"] as const) {
      expect(
        hashWorkforceOnboardingPlan({
          ...raw,
          [key]: id(99),
          policy: { ...raw.policy, [key]: id(99) },
        }),
      ).not.toBe(initial);
    }
    const later = "2026-11-07T12:00:00.000Z";
    expect(
      hashWorkforceOnboardingPlan({
        ...raw,
        effectiveUntil: later,
        policy: { ...raw.policy, effectiveUntil: later },
      }),
    ).not.toBe(initial);
    const role = raw.policy.roles[0],
      grant = role?.grants[0];
    if (!role || !grant) throw new Error("Controlled role/grant missing");
    for (const changed of [
      { ...role, roleCode: "another_reviewer" },
      { ...role, assignment: { ...role.assignment, assignmentReference: id(99) } },
      { ...role, grants: [{ ...grant, action: "organization.manage" }] },
      { ...role, grants: [{ ...grant, grantReference: id(99) }] },
      { ...role, grants: [{ ...grant, effectiveUntil: "2026-12-02T00:00:00.000Z" }] },
    ])
      expect(
        hashWorkforceOnboardingPlan({ ...raw, policy: { ...raw.policy, roles: [changed] } }),
      ).not.toBe(initial);
  });
});

function firstOwnerInput() {
  const base = input(), role = base.policy.roles[0];
  if (!role) throw new Error("Controlled owner role missing");
  return {
    ...base, profile: "FirstOwnerCreationPlanV1", expectedPolicy: null,
    policy: { ...base.policy, roles: [{ ...role, roleCode: "owner" }] },
    creation: {
      brand: { brandReference: base.brandReference, code: "FIRST_OWNER", displayName: "Controlled first Brand", defaultLocale: "en-CA", currencyCode: "CAD" },
      brandAuditReference: id(40), membershipAuditReference: id(41), policyAuditReference: id(42),
    },
    operatingEntityQualification: { operatingEntityReference: id(43), entityVersion: 1, entityDigest: `sha256:${"b".repeat(64)}`, entityEvidenceReference: id(44), reviewEvidenceReference: id(45), materialDigest: `sha256:${"c".repeat(64)}` },
    corporateEmailQualification: { evidenceReference: id(46), operatingEntityReference: id(43), emailDigest: base.emailDigest, materialDigest: `sha256:${"d".repeat(64)}` },
  };
}
describe("complete first Owner creation variant", () => {
  it("keeps the complete variant in one digest through approval, Pending, Policy and callback original", () => {
    const raw = firstOwnerInput(), result = deriveWorkforceOnboardingPlan(raw);
    expect(result.plan).toEqual(raw);
    expect(result.planDigest).toBe(`sha256:${sha256Hex(canonicalizeRfc8785(raw))}`);
    expect(result.approvalExpected.planDigest).toBe(result.planDigest);
    expect(result.approvedMembership.planDigest).toBe(result.planDigest);
    expect(result.preparePolicy.approval.planDigest).toBe(result.planDigest);
    expect(result.original.approvedPlanDigest).toBe(result.planDigest);
    expect(result.original.storeAssignmentReferences).toEqual([]);
    expect(Object.keys(result.plan)).toHaveLength(24);
    if (result.plan.profile !== "FirstOwnerCreationPlanV1") throw new Error("Variant missing");
    raw.creation.brand.displayName = "Changed transient content";
    expect(result.plan.creation.brand.displayName).toBe("Controlled first Brand");
    expect(Object.isFrozen(result.plan.corporateEmailQualification)).toBe(true);
  });
  it("preserves old V1 canonical bytes and rejects creation fields under its old profile", () => {
    const old = input();
    expect(canonicalizeRfc8785(parseWorkforceOnboardingPlan(old))).toBe(canonicalizeRfc8785(old));
    expect(() => parseWorkforceOnboardingPlan({ ...firstOwnerInput(), profile: old.profile })).toThrow();
    expect(() => parseWorkforceOnboardingPlan({ ...old, profile: "FirstOwnerCreationPlanV1" })).toThrow();
  });
  it("binds every creation and material leaf including coherent entity/email changes", () => {
    const raw = firstOwnerInput(), original = hashWorkforceOnboardingPlan(raw);
    const changes = [
      ...["code", "displayName", "defaultLocale"].map((key) => ({ ...raw, creation: { ...raw.creation, brand: { ...raw.creation.brand, [key]: key === "defaultLocale" ? "fr-CA" : "OTHER" } } })),
      ...["brandAuditReference", "membershipAuditReference", "policyAuditReference"].map((key) => ({ ...raw, creation: { ...raw.creation, [key]: id(90) } })),
      ...["entityDigest", "materialDigest"].map((key) => ({ ...raw, operatingEntityQualification: { ...raw.operatingEntityQualification, [key]: `sha256:${"e".repeat(64)}` } })),
      ...["entityEvidenceReference", "reviewEvidenceReference"].map((key) => ({ ...raw, operatingEntityQualification: { ...raw.operatingEntityQualification, [key]: id(90) } })),
      { ...raw, operatingEntityQualification: { ...raw.operatingEntityQualification, entityVersion: 2 } },
      { ...raw, corporateEmailQualification: { ...raw.corporateEmailQualification, evidenceReference: id(90) } },
      { ...raw, corporateEmailQualification: { ...raw.corporateEmailQualification, materialDigest: `sha256:${"e".repeat(64)}` } },
      { ...raw, operatingEntityQualification: { ...raw.operatingEntityQualification, operatingEntityReference: id(90) }, corporateEmailQualification: { ...raw.corporateEmailQualification, operatingEntityReference: id(90) } },
      { ...raw, emailDigest: "e".repeat(64), corporateEmailQualification: { ...raw.corporateEmailQualification, emailDigest: "e".repeat(64) } },
      { ...raw, brandReference: id(90), policy: { ...raw.policy, brandReference: id(90) }, creation: { ...raw.creation, brand: { ...raw.creation.brand, brandReference: id(90) } } },
    ];
    for (const changed of changes) expect(hashWorkforceOnboardingPlan(changed)).not.toBe(original);
  });
  it("rejects mismatched qualifications, old policy heads, non-owner/multiple roles and aliased Audit IDs", () => {
    const raw = firstOwnerInput(), role = raw.policy.roles[0];
    if (!role) throw new Error("Controlled owner role missing");
    for (const changed of [
      { ...raw, creation: { ...raw.creation, brand: { ...raw.creation.brand, brandReference: id(90) } } },
      { ...raw, creation: { ...raw.creation, brand: { ...raw.creation.brand, currencyCode: "USD" } } },
      { ...raw, expectedPolicy: input().expectedPolicy },
      { ...raw, policy: { ...raw.policy, roles: [{ ...role, roleCode: "manager" }] } },
      { ...raw, policy: { ...raw.policy, roles: [role, { ...role, roleReference: id(91), roleCode: "reviewer", assignment: { ...role.assignment, assignmentReference: id(92) }, grants: role.grants.map(g => ({ ...g, grantReference: id(93) })) }] } },
      { ...raw, corporateEmailQualification: { ...raw.corporateEmailQualification, operatingEntityReference: id(90) } },
      { ...raw, corporateEmailQualification: { ...raw.corporateEmailQualification, emailDigest: "e".repeat(64) } },
      { ...raw, operatingEntityQualification: { ...raw.operatingEntityQualification, entityDigest: "raw material" } },
      { ...raw, operatingEntityQualification: { ...raw.operatingEntityQualification, entityVersion: 0 } },
      ...[raw.operationReference, raw.actorReference, role.roleReference, raw.creation.membershipAuditReference, raw.operatingEntityQualification.entityEvidenceReference].map(id => ({ ...raw, creation: { ...raw.creation, brandAuditReference: id } })),
      { ...raw, creation: { ...raw.creation, proof: true } },
      { ...raw, corporateEmailQualification: { ...raw.corporateEmailQualification, corporateEmail: "controlled@example.test" } },
    ]) expect(() => parseWorkforceOnboardingPlan(changed)).toThrow();
  });
  it("never executes a variant discriminator or material getter", () => {
    let calls = 0;
    for (const target of ["profile", "material"]) {
      const raw = firstOwnerInput();
      Object.defineProperty(target === "profile" ? raw : raw.operatingEntityQualification, target === "profile" ? "profile" : "materialDigest", { enumerable: true, get: () => { calls++; return true; } });
      expect(() => parseWorkforceOnboardingPlan(raw)).toThrow();
    }
    expect(calls).toBe(0);
  });
});
