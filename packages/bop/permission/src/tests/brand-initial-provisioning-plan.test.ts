import { createBrand, parseBrandAdministrationReference } from "@bop/tenant";
import { describe, expect, it } from "vitest";
import { createIdentityActor, parseCurrentWorkforceAccount } from "@bop/identity";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { parseBrandInitialPolicyRequest } from "../contracts/brand-initial-policy.js";
import { parseInitialBrandMembershipRequest } from "@bop/membership";
import { brandAdministrationPermissionActions } from "../contracts/brand-administration-permission.js";
import {
  assertBrandInitialProvisioningOriginal,
  deriveBrandInitialProvisioningRequests,
  hashBrandInitialProvisioningPlan,
  parseBrandInitialProvisioningMembers,
  parseBrandInitialProvisioningOperator,
  parseBrandInitialProvisioningPlan,
} from "../contracts/brand-initial-provisioning-plan.js";

const uuid = (n: number) => `018f4f8a-9c2d-7a11-8d01-${String(n).padStart(12, "0")}`;
const at = "2026-10-06T12:00:00.000Z",
  until = "2026-10-06T12:00:05.000Z",
  end = "2026-10-07T12:00:00.000Z";
function input() {
  return {
    profile: "BrandInitialProvisioningPlanV1",
    purposeCode: "BRAND_INITIAL_PROVISIONING",
    environmentReference: uuid(1),
    operationReference: uuid(2),
    operatorReference: uuid(3),
    approvedByReference: uuid(4),
    approvalEvidenceReference: uuid(5),
    brand: {
      brandReference: uuid(6),
      code: "SYNTHETIC",
      displayName: "Controlled test Brand",
      defaultLocale: "en-CA",
      currencyCode: "CAD",
    },
    brandAuditReference: uuid(7),
    membershipAuditReference: uuid(8),
    policyAuditReference: uuid(9),
    policySnapshotReference: uuid(10),
    recipients: [
      {
        actorReference: uuid(11),
        membershipReference: uuid(12),
        workforceRelationshipReference: uuid(13),
        relationshipEvidenceReference: uuid(14),
        invitationEvidenceReference: uuid(15),
        membershipEffectiveUntil: end,
        roleEffectiveUntil: end,
        roleReference: uuid(16),
        roleCode: "initial_admin",
        assignmentReference: uuid(17),
        grants: [
          {
            grantReference: uuid(18),
            permissionReference: uuid(19),
            action: "organization.manage",
          },
        ],
      },
    ],
  };
}
function operator(accountKind: "Platform" | "Workforce" = "Platform") {
  return createIdentityActor({
    actorType: "User",
    actorReference: uuid(3),
    accountKind,
    status: "Active",
    authenticationMethod: "Oidc",
    verificationLevel: "RecentMfa",
    authenticatedAt: at,
    recentMfaAt: at,
  });
}
function packet() {
  return {
    validUntil: until,
    members: [
      {
        membershipReference: uuid(12),
        account: parseCurrentWorkforceAccount({
          profile: "CurrentWorkforceAccountV1",
          actorType: "User",
          actorReference: uuid(11),
          accountKind: "Workforce",
          status: "Active",
          observedAt: at,
          validUntil: until,
        }),
        workforceRelationshipReference: uuid(13),
        relationshipEvidenceReference: uuid(14),
        invitationEvidenceReference: uuid(15),
        invitationQualified: true,
        relationshipEffectiveFrom: at,
        relationshipEffectiveUntil: end,
      },
    ],
  };
}
describe("signed static initial Brand plan", () => {
  it("derives actual Draft and owning requests at one actual observation", () => {
    const p = input(),
      d = deriveBrandInitialProvisioningRequests(p, at);
    expect(d.planDigest).toBe(
      `sha256:${sha256Hex(canonicalizeRfc8785(parseBrandInitialProvisioningPlan(p)))}`,
    );
    expect(d.brand).toMatchObject({ lifecycle: "Draft", version: 1, createdAt: at, updatedAt: at });
    expect(d.brandOperation).toEqual({
      command: "CreateBrand",
      operationReference: p.operationReference,
      brandReference: p.brand.brandReference,
      intentDigest: d.planDigest,
      brandVersion: 1,
      artifact: d.brand,
    });
    expect(d.approvalExpected).toEqual({
      environmentReference: p.environmentReference,
      operationReference: p.operationReference,
      brandReference: p.brand.brandReference,
      planDigest: d.planDigest,
      operatorReference: p.operatorReference,
    });
    expect(d.membershipRequest).toEqual(parseInitialBrandMembershipRequest(d.membershipRequest));
    expect(d.policyRequest).toEqual(parseBrandInitialPolicyRequest(d.policyRequest));
    expect(d.policyRequest.recipients[0]?.effectiveFrom).toBe(at);
    expect(d.policyRequest.occurredAt).toBe(at);
    expect(d.policyRequest.auditReference).toBe(p.policyAuditReference);
    expect(d.membershipRequest.members[0]?.effectiveUntil).toBe(end);
  });
  it("detaches and freezes every nested row and grant", () => {
    const raw = input(),
      p = parseBrandInitialProvisioningPlan(raw);
    raw.brand.displayName = "Changed";
    const r = raw.recipients[0];
    if (!r) throw new Error("Missing fixture");
    r.grants.push({
      grantReference: uuid(90),
      permissionReference: uuid(91),
      action: "organization.read",
    });
    expect(p.brand.displayName).toBe("Controlled test Brand");
    expect(p.recipients[0]?.grants).toHaveLength(1);
    expect(Object.isFrozen(p)).toBe(true);
    expect(Object.isFrozen(p.brand)).toBe(true);
    expect(Object.isFrozen(p.recipients)).toBe(true);
    expect(Object.isFrozen(p.recipients[0])).toBe(true);
    expect(Object.isFrozen(p.recipients[0]?.grants[0])).toBe(true);
    expect(hashBrandInitialProvisioningPlan(Object.fromEntries(Object.entries(p).reverse()))).toBe(
      hashBrandInitialProvisioningPlan(p),
    );
  });
  const leaves = [
    "environmentReference",
    "operationReference",
    "operatorReference",
    "approvedByReference",
    "approvalEvidenceReference",
    "brandAuditReference",
    "membershipAuditReference",
    "policyAuditReference",
    "policySnapshotReference",
  ];
  it.each(leaves)("hash binds top-level %s", (key) => {
    const p = input(),
      changed = { ...p, [key]: uuid(99) };
    expect(hashBrandInitialProvisioningPlan(changed)).not.toBe(hashBrandInitialProvisioningPlan(p));
  });
  it.each(["brandReference", "code", "displayName", "defaultLocale"])(
    "hash binds Brand %s",
    (key) => {
      const p = input(),
        next =
          key === "brandReference"
            ? uuid(99)
            : key === "code"
              ? "OTHER"
              : key === "displayName"
                ? "Other controlled Brand"
                : "fr-CA";
      expect(
        hashBrandInitialProvisioningPlan({ ...p, brand: { ...p.brand, [key]: next } }),
      ).not.toBe(hashBrandInitialProvisioningPlan(p));
    },
  );
  it.each([
    "actorReference",
    "membershipReference",
    "workforceRelationshipReference",
    "relationshipEvidenceReference",
    "invitationEvidenceReference",
    "membershipEffectiveUntil",
    "roleEffectiveUntil",
    "roleReference",
    "roleCode",
    "assignmentReference",
  ])("hash binds recipient %s", (key) => {
    const p = input(),
      r = p.recipients[0];
    if (!r) throw new Error("Missing fixture");
    const next =
      key === "roleCode"
        ? "other_admin"
        : key === "membershipEffectiveUntil"
          ? "2026-10-08T12:00:00.000Z"
          : key === "roleEffectiveUntil"
            ? "2026-10-07T11:00:00.000Z"
            : uuid(99);
    expect(
      hashBrandInitialProvisioningPlan({ ...p, recipients: [{ ...r, [key]: next }] }),
    ).not.toBe(hashBrandInitialProvisioningPlan(p));
  });
  it.each(["grantReference", "permissionReference"])("hash binds grant %s", (key) => {
    const p = input(),
      r = p.recipients[0],
      g = r?.grants[0];
    if (!r || !g) throw new Error("Missing fixture");
    expect(
      hashBrandInitialProvisioningPlan({
        ...p,
        recipients: [{ ...r, grants: [{ ...g, [key]: uuid(99) }] }],
      }),
    ).not.toBe(hashBrandInitialProvisioningPlan(p));
  });
  it("permits exactly the six owning actions and hashes every grant action", () => {
    const p = input(),
      r = p.recipients[0];
    if (!r) throw new Error("Missing fixture");
    const full = {
      ...p,
      recipients: [
        {
          ...r,
          grants: brandAdministrationPermissionActions.map((action, i) => ({
            grantReference: uuid(40 + i),
            permissionReference: uuid(50 + i),
            action,
          })),
        },
      ],
    };
    expect(parseBrandInitialProvisioningPlan(full).recipients[0]?.grants).toHaveLength(6);
    const reduced = {
      ...full,
      recipients: [
        {
          ...full.recipients[0],
          grants: full.recipients[0]?.grants.filter((g) => g.action === "organization.manage"),
        },
      ],
    };
    expect(hashBrandInitialProvisioningPlan(reduced)).not.toBe(
      hashBrandInitialProvisioningPlan(full),
    );
  });
  it.each([
    null,
    {},
    { ...input(), extra: true },
    { ...input(), profile: "Other" },
    { ...input(), purposeCode: "PLATFORM_BRAND_TEMPLATE" },
    { ...input(), operatorReference: uuid(4) },
    { ...input(), environmentReference: "bad" },
    { ...input(), recipients: [] },
    { ...input(), recipients: Array.from({ length: 21 }, () => input().recipients[0]) },
    { ...input(), brand: { ...input().brand, currencyCode: "USD" } },
    { ...input(), brand: { ...input().brand, code: "bad code" } },
    { ...input(), brand: { ...input().brand, defaultLocale: "en" } },
    { ...input(), brandAuditReference: uuid(8) },
  ])("rejects invalid closed metadata/identity/shape %#", (value) => {
    expect(() => parseBrandInitialProvisioningPlan(value)).toThrow();
  });
  it.each([null, "infinity", "0000-01-01T00:00:00.000Z", "2026-10-07T12:00:00Z"])(
    "requires finite canonical member and role end %s",
    (value) => {
      const p = input(),
        r = p.recipients[0];
      if (!r) throw new Error("Missing fixture");
      for (const key of ["membershipEffectiveUntil", "roleEffectiveUntil"])
        expect(() =>
          parseBrandInitialProvisioningPlan({ ...p, recipients: [{ ...r, [key]: value }] }),
        ).toThrow();
    },
  );
  it("rejects later role end, duplicates and unapproved rights", () => {
    const p = input(),
      r = p.recipients[0];
    if (!r) throw new Error("Missing fixture");
    for (const replacement of [
      { ...r, roleEffectiveUntil: "2026-10-08T12:00:00.000Z" },
      {
        ...r,
        grants: [
          { grantReference: uuid(90), permissionReference: uuid(91), action: "platform.operate" },
        ],
      },
      {
        ...r,
        grants: [
          { grantReference: uuid(90), permissionReference: uuid(91), action: "organization.read" },
        ],
      },
      { ...r, roleReference: r.membershipReference },
      { ...r, grants: [r.grants[0], r.grants[0]] },
    ])
      expect(() =>
        parseBrandInitialProvisioningPlan({ ...p, recipients: [replacement] }),
      ).toThrow();
    expect(() => parseBrandInitialProvisioningPlan({ ...p, recipients: [r, r] })).toThrow();
  });
  it("supports twenty distinct recipients and coherent shared permission definitions", () => {
    const p = input(),
      base = p.recipients[0];
    if (!base) throw new Error("Missing fixture");
    const recipients = Array.from({ length: 20 }, (_, i) => ({
      ...base,
      actorReference: uuid(100 + i),
      membershipReference: uuid(200 + i),
      workforceRelationshipReference: uuid(300 + i),
      relationshipEvidenceReference: uuid(400 + i),
      invitationEvidenceReference: uuid(500 + i),
      roleReference: uuid(600 + i),
      roleCode: `admin_${i}`,
      assignmentReference: uuid(700 + i),
      grants: [
        {
          grantReference: uuid(800 + i),
          permissionReference: uuid(19),
          action: "organization.manage",
        },
      ],
    }));
    expect(parseBrandInitialProvisioningPlan({ ...p, recipients }).recipients).toHaveLength(20);
    const first = recipients[0],
      second = recipients[1];
    if (!first || !second) throw new Error("Missing fixture");
    for (const key of [
      "actorReference",
      "membershipReference",
      "roleReference",
      "roleCode",
      "assignmentReference",
    ] as const)
      expect(() =>
        parseBrandInitialProvisioningPlan({
          ...p,
          recipients: [first, { ...second, [key]: first[key] }],
        }),
      ).toThrow();
    expect(() =>
      parseBrandInitialProvisioningPlan({
        ...p,
        recipients: [
          first,
          {
            ...second,
            grants: [
              {
                grantReference: uuid(999),
                permissionReference: uuid(998),
                action: "organization.manage",
              },
            ],
          },
        ],
      }),
    ).toThrow();
  });
  it("hash binds an allowed grant action while preserving required manage", () => {
    const p = input(),
      base = p.recipients[0];
    if (!base) throw new Error("Missing fixture");
    const make = (action: string) => ({
      ...p,
      recipients: [
        {
          ...base,
          grants: [
            ...base.grants,
            { grantReference: uuid(90), permissionReference: uuid(91), action },
          ],
        },
      ],
    });
    expect(hashBrandInitialProvisioningPlan(make("publishing.review.submit"))).not.toBe(
      hashBrandInitialProvisioningPlan(make("publishing.draft.create")),
    );
  });
  it("rejects accessors without evaluating them and closed sparse arrays", () => {
    let calls = 0;
    const p = input();
    Object.defineProperty(p, "brand", {
      enumerable: true,
      get() {
        calls++;
        throw new Error("getter");
      },
    });
    expect(() => parseBrandInitialProvisioningPlan(p)).toThrow();
    expect(calls).toBe(0);
    const rows = [input().recipients[0]];
    Object.defineProperty(rows, "0", {
      enumerable: true,
      get() {
        calls++;
        throw new Error("getter");
      },
    });
    expect(() => parseBrandInitialProvisioningPlan({ ...input(), recipients: rows })).toThrow();
    expect(calls).toBe(0);
    const sparse = new Array(1);
    expect(() => parseBrandInitialProvisioningPlan({ ...input(), recipients: sparse })).toThrow();
    const extra = Object.assign([input().recipients[0]], { extra: true });
    expect(() => parseBrandInitialProvisioningPlan({ ...input(), recipients: extra })).toThrow();
  });
  it("keeps static hash while runtime original changes, and rejects expired request", () => {
    const p = input(),
      a = deriveBrandInitialProvisioningRequests(p, at),
      b = deriveBrandInitialProvisioningRequests(p, "2026-10-06T12:00:01.000Z");
    expect(a.planDigest).toBe(b.planDigest);
    expect(a.brand.createdAt).not.toBe(b.brand.createdAt);
    expect(() => deriveBrandInitialProvisioningRequests(p, end)).toThrow();
    expect(() => deriveBrandInitialProvisioningRequests(p, "infinity")).toThrow();
  });
});
describe("actual initialization participant bindings", () => {
  it.each(["Platform", "Workforce"] as const)("accepts held RecentMfa %s operator", (kind) => {
    expect(
      parseBrandInitialProvisioningOperator(
        { actor: operator(kind), validUntil: until },
        input(),
        at,
      ).actor.accountKind,
    ).toBe(kind);
  });
  it("rejects wrong identity, status, authentication/MFA and overlong leases", () => {
    const a = operator();
    for (const actor of [
      { ...a, actorReference: uuid(99) },
      { ...a, status: "Disabled" },
      { ...a, verificationLevel: "SingleFactor", recentMfaAt: null },
      { ...a, authenticatedAt: until, recentMfaAt: until },
      {
        ...a,
        authenticatedAt: "2026-10-06T11:45:00.000Z",
        recentMfaAt: "2026-10-06T11:45:00.000Z",
      },
    ])
      expect(() =>
        parseBrandInitialProvisioningOperator({ actor, validUntil: until }, input(), at),
      ).toThrow();
    for (const validUntil of [at, "2026-10-06T12:00:05.001Z", "infinity"])
      expect(() =>
        parseBrandInitialProvisioningOperator({ actor: a, validUntil }, input(), at),
      ).toThrow();
    expect(() =>
      parseBrandInitialProvisioningOperator(
        { actor: a, validUntil: until, extra: true },
        input(),
        at,
      ),
    ).toThrow();
    expect(() =>
      parseBrandInitialProvisioningOperator(
        {
          actor: {
            ...a,
            authenticatedAt: "2026-10-06T11:45:01.000Z",
            recentMfaAt: "2026-10-06T11:45:01.000Z",
          },
          validUntil: until,
        },
        input(),
        at,
      ),
    ).toThrow();
  });
  it("binds real owning members with exact signed relationship and invitation evidence", () => {
    const a = parseBrandInitialProvisioningMembers(input(), at, at, operator(), packet());
    expect(a.brand.lifecycle).toBe("Draft");
    expect(a.members[0]?.relationshipEvidenceReference).toBe(uuid(14));
    expect(a.members[0]?.invitationEvidenceReference).toBe(uuid(15));
    const p = packet(),
      m = p.members[0];
    if (!m) throw new Error("Missing fixture");
    for (const key of [
      "relationshipEvidenceReference",
      "invitationEvidenceReference",
      "workforceRelationshipReference",
    ])
      expect(() =>
        parseBrandInitialProvisioningMembers(input(), at, at, operator(), {
          ...p,
          members: [{ ...m, [key]: uuid(99) }],
        }),
      ).toThrow();
    expect(() =>
      parseBrandInitialProvisioningMembers(input(), at, at, operator(), {
        ...p,
        members: [{ ...m, invitationQualified: false }],
      }),
    ).toThrow();
    expect(() =>
      parseBrandInitialProvisioningMembers(input(), at, at, operator(), {
        ...p,
        members: [{ ...m, account: { ...m.account, status: "Disabled" } }],
      }),
    ).toThrow();
    expect(() =>
      parseBrandInitialProvisioningMembers(input(), at, at, operator(), { ...p, extra: true }),
    ).toThrow();
  });
  it("bounds qualified accounts without inventing target authentication claims", () => {
    const p = packet(),
      m = p.members[0];
    if (!m) throw new Error("Missing fixture");
    const shorter = "2026-10-06T12:00:01.000Z";
    const parsed = parseBrandInitialProvisioningMembers(input(), at, at, operator(), {
      ...p,
      members: [{ ...m, account: { ...m.account, validUntil: shorter } }],
    });
    expect(parsed.validUntil).toBe(shorter);
    for (const account of [
      { ...m.account, profile: "IdentityActorV1" },
      { ...m.account, accountKind: "Platform" },
      { ...m.account, authenticatedAt: at },
      {
        ...m.account,
        observedAt: "2026-10-06T11:59:59.999Z",
        validUntil: "2026-10-06T12:00:04.999Z",
      },
      { ...m.account, observedAt: "2026-10-06T12:00:00.001Z" },
      { ...m.account, validUntil: "2026-10-06T12:00:05.001Z" },
    ])
      expect(() =>
        parseBrandInitialProvisioningMembers(input(), at, at, operator(), {
          ...p,
          members: [{ ...m, account }],
        }),
      ).toThrow();
  });
  it("does not renew the original member lease on later reads", () => {
    expect(() =>
      parseBrandInitialProvisioningMembers(input(), at, "2026-10-06T12:00:01.000Z", operator(), {
        ...packet(),
        validUntil: "2026-10-06T12:00:06.000Z",
      }),
    ).toThrow();
    expect(() =>
      parseBrandInitialProvisioningMembers(
        input(),
        at,
        "2026-10-06T11:59:59.000Z",
        operator(),
        packet(),
      ),
    ).toThrow();
  });
});

describe("immutable initial Brand original", () => {
  it("accepts exact original without today's recipient-period qualification", () => {
    const plan = input(),
      original = deriveBrandInitialProvisioningRequests(plan, at).brandOperation;
    expect(() => assertBrandInitialProvisioningOriginal(plan, original)).not.toThrow();
    // No now input or request derivation: these signed ends may now be past.
    const expiredPlan = {
      ...plan,
      recipients: plan.recipients.map((r) => ({
        ...r,
        membershipEffectiveUntil: "2020-01-02T00:00:00.000Z",
        roleEffectiveUntil: "2020-01-02T00:00:00.000Z",
      })),
    };
    const historical = deriveBrandInitialProvisioningRequests(
      expiredPlan,
      "2020-01-01T00:00:00.000Z",
    ).brandOperation;
    expect(() => assertBrandInitialProvisioningOriginal(expiredPlan, historical)).not.toThrow();
    expect(() => deriveBrandInitialProvisioningRequests(expiredPlan, at)).toThrow();
  });
  it("rejects valid differing Brand metadata despite a claimed matching digest", () => {
    const plan = input(),
      derived = deriveBrandInitialProvisioningRequests(plan, at);
    for (const change of [
      { code: "OTHER" },
      { displayName: "Different valid name" },
      { defaultLocale: "fr-CA" },
      { brandReference: uuid(99) },
    ]) {
      const artifact = createBrand({ ...derived.brand, ...change });
      expect(() =>
        assertBrandInitialProvisioningOriginal(plan, { ...derived.brandOperation, artifact }),
      ).toThrow();
    }
  });
  it("rejects different command, receipt identities, digest, version or lifecycle", () => {
    const plan = input(),
      d = deriveBrandInitialProvisioningRequests(plan, at);
    for (const original of [
      { ...d.brandOperation, command: "ActivateBrand" as const },
      { ...d.brandOperation, operationReference: parseBrandAdministrationReference(uuid(99)) },
      {
        ...d.brandOperation,
        brandReference: createBrand({ ...d.brand, brandReference: uuid(99) }).brandReference,
      },
      { ...d.brandOperation, intentDigest: `sha256:${"0".repeat(64)}` },
      { ...d.brandOperation, brandVersion: createBrand({ ...d.brand, version: 2 }).version },
      { ...d.brandOperation, artifact: createBrand({ ...d.brand, version: 2 }) },
      { ...d.brandOperation, artifact: createBrand({ ...d.brand, lifecycle: "Active" }) },
      { ...d.brandOperation, artifact: createBrand({ ...d.brand, updatedAt: until }) },
    ])
      expect(() => assertBrandInitialProvisioningOriginal(plan, original)).toThrow();
  });
  it("rejects noncanonical original chronology and accessors without evaluating them", () => {
    const plan = input(),
      d = deriveBrandInitialProvisioningRequests(plan, at);
    const artifact = createBrand({
      ...d.brand,
      createdAt: "0000-01-01T00:00:00.000Z",
      updatedAt: "0000-01-01T00:00:00.000Z",
    });
    expect(() =>
      assertBrandInitialProvisioningOriginal(plan, { ...d.brandOperation, artifact }),
    ).toThrow();
    let calls = 0;
    const original = { ...d.brandOperation };
    Object.defineProperty(original, "artifact", {
      enumerable: true,
      get() {
        calls++;
        return d.brand;
      },
    });
    expect(() => assertBrandInitialProvisioningOriginal(plan, original)).toThrow();
    expect(calls).toBe(0);
  });
});
