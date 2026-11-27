import { expect, it } from "vitest";
import { createIdentityActor, parseCurrentWorkforceAccount } from "@bop/identity";
import {
  createApprovedPendingWorkforceMembership,
  createInitialBrandMembership,
  createMembership,
  resolveActiveMembership,
  transitionMembership,
} from "../domain/membership.js";
import {
  parseApprovedWorkforceMembership,
  parseCreateApprovedPendingMembership,
  parseActivateApprovedMembership,
} from "../contracts/approved-workforce-membership.js";
import { hashApprovedWorkforceMembershipRequest } from "../infrastructure/persistence/approved-workforce-membership-store.js";
const id = (n: number) => `0190ed60-0000-7000-8000-${String(n).padStart(12, "0")}`;
const at = "2026-10-06T10:00:00.000Z",
  end = "2026-10-07T10:00:00.000Z";
function fixture() {
  const approval = {
    profile: "ApprovedWorkforceMembershipV1",
    operationReference: id(1),
    planDigest: `sha256:${"a".repeat(64)}`,
    operatorReference: id(2),
    approvedByReference: id(3),
    approvalEvidenceReference: id(4),
    environmentReference: id(18),
    brandReference: id(5),
    membershipReference: id(6),
    actorReference: id(7),
    workforceRelationshipReference: id(8),
    relationshipEvidenceReference: id(9),
    relationshipRevision: 1,
    effectiveFrom: at,
    effectiveUntil: end,
    approvedPolicyDigest: `sha256:${"b".repeat(64)}`,
  };
  const input = {
    membershipReference: id(6),
    actorReference: id(7),
    brandReference: id(5),
    workforceRelationshipReference: id(8),
    lifecycle: "PendingActivation",
    effectiveFrom: at,
    effectiveUntil: end,
    version: 1,
    createdAt: at,
    updatedAt: at,
  };
  return { approval, input };
}
it("creates only an inert approved Pending revision without manufacturing an authenticated Actor", () => {
  const f = fixture(),
    approval = parseApprovedWorkforceMembership(f.approval),
    member = createApprovedPendingWorkforceMembership(f.input, approval.actorReference);
  expect(member.lifecycle).toBe("PendingActivation");
  expect(Object.isFrozen(approval)).toBe(true);
  expect(Object.isFrozen(member)).toBe(true);
  expect(() =>
    resolveActiveMembership([member], member.actorReference, member.brandReference, at),
  ).toThrow();
  const active = transitionMembership(member, member.version, "Active", "2026-10-06T10:01:00.000Z");
  expect(active.version).toBe(2);
  expect(active.workforceRelationshipReference).toBe(member.workforceRelationshipReference);
  expect(
    resolveActiveMembership(
      [active],
      active.actorReference,
      active.brandReference,
      active.updatedAt,
    ),
  ).toEqual(active);
});
it.each([
  { lifecycle: "Active" },
  { version: 2 },
  { workforceRelationshipReference: null },
  { effectiveUntil: null },
  { updatedAt: "2026-10-06T10:00:01.000Z" },
])("refuses a non-Pending first revision %j", (change) => {
  const f = fixture();
  expect(() =>
    createApprovedPendingWorkforceMembership({ ...f.input, ...change }, id(7)),
  ).toThrow();
});
it("preserves the old authenticated and initial Active-only entry points", () => {
  const f = fixture(),
    account = parseCurrentWorkforceAccount({
      profile: "CurrentWorkforceAccountV1",
      actorType: "User",
      actorReference: id(7),
      accountKind: "Workforce",
      status: "Active",
      observedAt: at,
      validUntil: "2026-10-06T10:00:05.000Z",
    });
  expect(() => createInitialBrandMembership(f.input, account, at)).toThrow();
  const actor = createIdentityActor({
    actorType: "User",
    actorReference: id(7),
    accountKind: "Workforce",
    status: "Active",
    authenticationMethod: "Oidc",
    verificationLevel: "SingleFactor",
    authenticatedAt: at,
    recentMfaAt: null,
  });
  expect(createMembership(f.input, actor).lifecycle).toBe("PendingActivation");
  expect(() => createApprovedPendingWorkforceMembership(f.input, id(90))).toThrow();
});
it.each([
  { approvedByReference: id(2) },
  { approvedByReference: id(7) },
  { relationshipRevision: 0 },
  { relationshipRevision: 1.1 },
  { effectiveUntil: at },
  { effectiveFrom: "0000-01-01T00:00:00.000Z" },
  { planDigest: "unknown" },
  { approvedPolicyDigest: "unknown" },
  { storeReference: id(90) },
])("rejects malformed or non-independent approval %j", (change) => {
  expect(() => parseApprovedWorkforceMembership({ ...fixture().approval, ...change })).toThrow();
});
it("pins the exact original approval and activation version and does not invoke getters", () => {
  const f = fixture(),
    create = { profile: "CreateApprovedPendingMembershipV1", approval: f.approval },
    activate = {
      profile: "ActivateApprovedMembershipV1",
      operationReference: id(10),
      approval: f.approval,
      expectedVersion: 1,
      pendingCreatedAt: at,
      invitationReference: id(11),
    };
  expect(parseCreateApprovedPendingMembership(create).approval).toEqual(f.approval);
  expect(parseActivateApprovedMembership(activate).expectedVersion).toBe(1);
  expect(() => parseActivateApprovedMembership({ ...activate, expectedVersion: 2 })).toThrow();
  expect(hashApprovedWorkforceMembershipRequest(create)).not.toBe(
    hashApprovedWorkforceMembershipRequest(activate),
  );
  expect(hashApprovedWorkforceMembershipRequest(create)).not.toBe(
    hashApprovedWorkforceMembershipRequest({
      ...create,
      approval: { ...f.approval, relationshipRevision: 2 },
    }),
  );
  let read = false;
  Object.defineProperty(f.approval, "actorReference", {
    enumerable: true,
    get() {
      read = true;
      return id(7);
    },
  });
  expect(() => parseApprovedWorkforceMembership(f.approval)).toThrow();
  expect(read).toBe(false);
  expect(() => hashApprovedWorkforceMembershipRequest(null)).toThrow();
});
