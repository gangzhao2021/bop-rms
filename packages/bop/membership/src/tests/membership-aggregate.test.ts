import { createIdentityActor } from "@bop/identity";
import { createStore, parseBrandReference, parseStoreReference } from "@bop/tenant";
import { describe, expect, it } from "vitest";
import {
  MembershipContractError,
  createMembership,
  createStoreAssignment,
  parseMembershipVersion,
  resolveActiveMembership,
  resolveActiveStoreAssignment,
  suspendMembershipAccess,
  transitionMembership,
} from "../index.js";

const ACTOR = "018f3f7a-8b1c-7a11-8d01-000000000001";
const BRAND = "018f3f7a-8b1c-7a11-8d01-000000000002";
const OTHER_BRAND = "018f3f7a-8b1c-7a11-8d01-000000000003";
const STORE = "018f3f7a-8b1c-7a11-8d01-000000000004";
const MEMBERSHIP = "018f3f7a-8b1c-7a11-8d01-000000000005";
const RELATIONSHIP = "018f3f7a-8b1c-7a11-8d01-000000000006";
const ASSIGNMENT = "018f3f7a-8b1c-7a11-8d01-000000000007";
const OTHER_ASSIGNMENT = "018f3f7a-8b1c-7a11-8d01-000000000008";
const FROM = "2026-07-28T12:00:00.000Z";
const AT = "2026-07-28T12:30:00.000Z";
const UNTIL = "2026-07-28T13:00:00.000Z";
const LATER = "2026-07-28T14:00:00.000Z";

const actor = (accountKind = "Workforce") =>
  createIdentityActor({
    actorType: "User",
    actorReference: ACTOR,
    accountKind,
    status: "Active",
    authenticationMethod: "Oidc",
    verificationLevel: "SingleFactor",
    authenticatedAt: FROM,
    recentMfaAt: null,
  });

const membershipInput = (overrides: Readonly<Record<string, unknown>> = {}) => ({
  membershipReference: MEMBERSHIP,
  actorReference: ACTOR,
  brandReference: BRAND,
  workforceRelationshipReference: RELATIONSHIP,
  lifecycle: "Active",
  effectiveFrom: FROM,
  effectiveUntil: UNTIL,
  version: 1,
  createdAt: FROM,
  updatedAt: FROM,
  ...overrides,
});

const store = (brandReference = BRAND) =>
  createStore({
    storeReference: STORE,
    brandReference,
    code: "TORONTO_1",
    displayName: "Synthetic Toronto",
    timeZone: "America/Toronto",
    locale: "en-CA",
    currencyCode: "CAD",
    lifecycle: "Active",
    version: 1,
    createdAt: FROM,
    updatedAt: FROM,
  });

const assignmentInput = (overrides: Readonly<Record<string, unknown>> = {}) => ({
  storeAssignmentReference: ASSIGNMENT,
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
  ...overrides,
});

describe("Membership and Store Assignment aggregate contract", () => {
  it("creates frozen membership and assignment facts for an active Workforce User", () => {
    const membership = createMembership(membershipInput(), actor());
    const assignment = createStoreAssignment(assignmentInput(), membership, store());
    expect(Object.isFrozen(membership)).toBe(true);
    expect(Object.isFrozen(assignment)).toBe(true);
    expect(assignment).toMatchObject({
      actorReference: membership.actorReference,
      brandReference: membership.brandReference,
      membershipReference: membership.membershipReference,
    });
  });

  it("rejects non-Workforce actors, identity mismatch, and active membership without evidence", () => {
    expect(() => createMembership(membershipInput(), actor("Customer"))).toThrowError(
      "membership actor is invalid",
    );
    expect(() =>
      createMembership(
        membershipInput({ actorReference: "018f3f7a-8b1c-7a11-8d01-000000000009" }),
        actor(),
      ),
    ).toThrowError("membership actor is invalid");
    expect(() =>
      createMembership(membershipInput({ workforceRelationshipReference: null }), actor()),
    ).toThrowError("membership evidence is required");
    expect(() =>
      createMembership(membershipInput(), {
        ...actor(),
        accountKind: "Workforce",
        unexpected: "not an Identity Actor",
      } as never),
    ).toThrowError("membership actor is invalid");
  });

  it("rejects unknown fields, exotic prototypes and accessors without invoking them", () => {
    expect(() => createMembership({ ...membershipInput(), permission: "admin" }, actor())).toThrow(
      MembershipContractError,
    );
    let invoked = false;
    const input = Object.create(null);
    Object.defineProperty(input, "membershipReference", {
      enumerable: true,
      get() {
        invoked = true;
        return MEMBERSHIP;
      },
    });
    expect(() => createMembership(input, actor())).toThrowError("membership shape is invalid");
    expect(invoked).toBe(false);
  });

  it("requires the public Store fact to belong to the immutable Membership Brand", () => {
    const membership = createMembership(membershipInput(), actor());
    expect(() =>
      createStoreAssignment(assignmentInput(), membership, store(OTHER_BRAND)),
    ).toThrowError("store does not belong to membership brand");
    expect(() =>
      createStoreAssignment(assignmentInput(), membership, {
        ...store(),
        unexpected: "not a Store",
      } as never),
    ).toThrowError("store assignment shape is invalid");
  });

  it("resolves exact active facts using half-open UTC periods and fails closed", () => {
    const membership = createMembership(membershipInput(), actor());
    const assignment = createStoreAssignment(assignmentInput(), membership, store());
    expect(
      resolveActiveMembership(
        [membership],
        membership.actorReference,
        membership.brandReference,
        AT,
      ),
    ).toBe(membership);
    expect(
      resolveActiveStoreAssignment(membership, [assignment], assignment.storeReference, AT),
    ).toBe(assignment);
    expect(() =>
      resolveActiveMembership(
        [membership],
        membership.actorReference,
        membership.brandReference,
        UNTIL,
      ),
    ).toThrowError("active membership was not found");
    expect(() =>
      resolveActiveMembership(
        [membership, membership],
        membership.actorReference,
        membership.brandReference,
        AT,
      ),
    ).toThrowError("active membership is ambiguous");
  });

  it("lets the parent membership dominate assignment resolution", () => {
    const membership = createMembership(membershipInput(), actor());
    const assignment = createStoreAssignment(assignmentInput(), membership, store());
    const suspended = transitionMembership(membership, parseMembershipVersion(1), "Suspended", AT);
    expect(() =>
      resolveActiveStoreAssignment(suspended, [assignment], assignment.storeReference, AT),
    ).toThrowError("active store assignment was not found");
  });

  it("enforces expected version, lifecycle graph and monotonic update time", () => {
    const membership = createMembership(membershipInput(), actor());
    expect(() =>
      transitionMembership(membership, parseMembershipVersion(2), "Suspended", AT),
    ).toThrowError("membership version conflict");
    const suspended = transitionMembership(membership, parseMembershipVersion(1), "Suspended", AT);
    expect(suspended).toMatchObject({ lifecycle: "Suspended", version: 2 });
    expect(() =>
      transitionMembership(suspended, parseMembershipVersion(2), "PendingActivation", LATER),
    ).toThrowError("membership transition is invalid");
  });

  it("suspends active assignments atomically and returns bounded invalidation facts", () => {
    const membership = createMembership(membershipInput({ effectiveUntil: null }), actor());
    const active = createStoreAssignment(
      assignmentInput({ effectiveUntil: null }),
      membership,
      store(),
    );
    const alreadySuspended = createStoreAssignment(
      assignmentInput({
        storeAssignmentReference: OTHER_ASSIGNMENT,
        lifecycle: "Suspended",
        effectiveUntil: null,
      }),
      membership,
      store(),
    );
    const result = suspendMembershipAccess(
      membership,
      parseMembershipVersion(1),
      [active, alreadySuspended],
      new Map([[active.storeAssignmentReference, parseMembershipVersion(1)]]),
      AT,
    );
    expect(result.membership.lifecycle).toBe("Suspended");
    expect(result.assignments.map((item) => item.lifecycle)).toEqual(["Suspended", "Suspended"]);
    expect(result.invalidation).toEqual({
      actorReference: membership.actorReference,
      membershipReference: membership.membershipReference,
      occurredAt: AT,
      storeAssignmentReferences: [active.storeAssignmentReference],
    });
    expect(Object.keys(result.invalidation).sort()).toEqual([
      "actorReference",
      "membershipReference",
      "occurredAt",
      "storeAssignmentReferences",
    ]);
  });

  it("exports compatible public reference parsers from owning Domains", () => {
    expect(parseBrandReference(BRAND)).toBe(BRAND);
    expect(parseStoreReference(STORE)).toBe(STORE);
  });
});
