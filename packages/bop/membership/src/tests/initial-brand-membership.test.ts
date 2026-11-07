import { createInitialBrandMembership, createMembership } from "../domain/membership.js";
import { expect, it } from "vitest";
import { createIdentityActor, parseCurrentWorkforceAccount } from "@bop/identity";
import { createBrand } from "@bop/tenant";
import {
  parseInitialBrandMembershipRequest,
  parseInitialBrandMembershipAuthority,
} from "../contracts/initial-brand-membership.js";
import { hashInitialBrandMembershipRequest } from "../infrastructure/persistence/initial-brand-membership-store.js";
const id = (n: number) => "0190ed60-0000-7000-8000-" + String(n).padStart(12, "0");
const at = "2026-10-06T10:00:00.000Z",
  until = "2026-10-07T10:00:00.000Z",
  lease = "2026-10-06T10:00:05.000Z";
function fixture() {
  const actor = createIdentityActor({
    actorType: "User",
    actorReference: id(1),
    accountKind: "Workforce",
    status: "Active",
    authenticationMethod: "Oidc",
    verificationLevel: "SingleFactor",
    authenticatedAt: at,
    recentMfaAt: null,
  });
  const member = {
    membershipReference: id(6),
    actorReference: id(1),
    workforceRelationshipReference: id(7),
    effectiveUntil: until,
  };
  const qualified = {
    membershipReference: id(6),
    account: parseCurrentWorkforceAccount({
      profile: "CurrentWorkforceAccountV1",
      actorType: "User",
      actorReference: id(1),
      accountKind: "Workforce",
      status: "Active",
      observedAt: at,
      validUntil: lease,
    }),
    workforceRelationshipReference: id(7),
    relationshipEvidenceReference: id(8),
    invitationEvidenceReference: id(9),
    invitationQualified: true,
    relationshipEffectiveFrom: at,
    relationshipEffectiveUntil: until,
  };
  const request = {
    profile: "InitialBrandMembershipRequestV1",
    operationReference: id(2),
    brandReference: id(3),
    planDigest: "sha256:" + "a".repeat(64),
    approvalEvidenceReference: id(4),
    operatorReference: id(1),
    approvedByReference: id(5),
    members: [member],
  };
  const authority = {
    brand: createBrand({
      brandReference: id(3),
      code: "SYNTHETIC",
      displayName: "Synthetic Draft",
      defaultLocale: "en-CA",
      currencyCode: "CAD",
      lifecycle: "Draft",
      version: 1,
      createdAt: at,
      updatedAt: at,
    }),
    operator: actor,
    operationReference: id(2),
    brandReference: id(3),
    planDigest: request.planDigest,
    requestDigest: hashInitialBrandMembershipRequest(request),
    approvalEvidenceReference: id(4),
    approvedByReference: id(5),
    members: [qualified],
    observedAt: at,
    validUntil: lease,
  };
  return { request, authority, member, qualified };
}
it("parses detached closed initial members and separates business end from the authorization lease", () => {
  const f = fixture(),
    request = parseInitialBrandMembershipRequest(f.request);
  const actual = parseInitialBrandMembershipAuthority(
    f.authority,
    request,
    at,
    at,
    hashInitialBrandMembershipRequest(request),
  );
  f.member.effectiveUntil = lease;
  expect(request.members[0]?.effectiveUntil).toBe(until);
  expect(actual.validUntil).toBe(lease);
  expect(Object.isFrozen(request.members)).toBe(true);
  expect(Object.isFrozen(actual.members[0]?.account)).toBe(true);
});
it.each([
  "extra",
  "sparse",
  "duplicateActor",
  "duplicateMembership",
  "sameApprover",
  "missingRelationship",
  "infinite",
  "overflow",
])("rejects unsafe initial request %s", (reason) => {
  const f = fixture();
  let value: unknown = f.request;
  if (reason === "extra") value = { ...f.request, passed: true };
  if (reason === "sparse") f.request.members.length = 2;
  if (reason === "duplicateActor")
    f.request.members.push({ ...f.member, membershipReference: id(10) });
  if (reason === "duplicateMembership")
    f.request.members.push({ ...f.member, actorReference: id(10) });
  if (reason === "sameApprover") f.request.approvedByReference = id(1);
  if (reason === "missingRelationship")
    value = { ...f.request, members: [{ ...f.member, workforceRelationshipReference: null }] };
  if (reason === "infinite") f.member.effectiveUntil = "infinity";
  if (reason === "overflow") f.request.members = Array(21).fill(f.member);
  expect(() => parseInitialBrandMembershipRequest(value)).toThrow();
});
it.each([
  "Brand",
  "version",
  "oldDraft",
  "operator",
  "inactiveOperator",
  "unauthenticatedOperator",
  "Actor",
  "inactiveMember",
  "sessionFieldsOnAccount",
  "relationship",
  "invitation",
  "evidence",
  "businessPeriod",
  "future",
  "expired",
  "extended",
  "plan",
])("refuses rebound or unqualified held fact %s", (reason) => {
  const f = fixture(),
    member = f.qualified;
  let actual: unknown = f.authority;
  if (reason === "Brand")
    actual = { ...f.authority, brand: { ...f.authority.brand, lifecycle: "Active" } };
  if (reason === "version")
    actual = { ...f.authority, brand: { ...f.authority.brand, version: 2 } };
  if (reason === "oldDraft")
    actual = {
      ...f.authority,
      brand: {
        ...f.authority.brand,
        createdAt: "2026-10-06T09:59:59.000Z",
        updatedAt: "2026-10-06T09:59:59.000Z",
      },
    };
  if (reason === "inactiveOperator")
    actual = { ...f.authority, operator: { ...f.authority.operator, status: "Suspended" } };
  if (reason === "unauthenticatedOperator")
    actual = { ...f.authority, operator: { ...f.authority.operator, authenticatedAt: null } };
  if (reason === "inactiveMember")
    actual = {
      ...f.authority,
      members: [{ ...member, account: { ...member.account, status: "Suspended" } }],
    };
  if (reason === "sessionFieldsOnAccount")
    actual = {
      ...f.authority,
      members: [{ ...member, account: { ...member.account, authenticatedAt: null } }],
    };
  if (reason === "operator")
    actual = { ...f.authority, operator: { ...f.authority.operator, actorReference: id(99) } };
  if (reason === "Actor")
    actual = {
      ...f.authority,
      members: [{ ...member, account: { ...member.account, actorReference: id(99) } }],
    };
  if (reason === "relationship") member.workforceRelationshipReference = id(99);
  if (reason === "invitation") member.invitationQualified = false;
  if (reason === "evidence") member.relationshipEvidenceReference = "invalid";
  if (reason === "businessPeriod") member.relationshipEffectiveUntil = lease;
  if (reason === "future") f.authority.observedAt = "2026-10-06T10:00:00.001Z";
  if (reason === "expired") f.authority.validUntil = at;
  if (reason === "extended") f.authority.validUntil = "2026-10-06T10:00:05.001Z";
  if (reason === "plan") f.authority.planDigest = "sha256:" + "b".repeat(64);
  expect(() =>
    parseInitialBrandMembershipAuthority(
      actual,
      parseInitialBrandMembershipRequest(f.request),
      at,
      at,
      hashInitialBrandMembershipRequest(f.request),
    ),
  ).toThrow();
});
it("does not invoke accessor facts or accept a Customer as initial Workforce Member", () => {
  const f = fixture();
  let touched = false;
  Object.defineProperty(f.authority, "operator", {
    enumerable: true,
    get() {
      touched = true;
      return null;
    },
  });
  expect(() =>
    parseInitialBrandMembershipAuthority(
      f.authority,
      parseInitialBrandMembershipRequest(f.request),
      at,
      at,
      hashInitialBrandMembershipRequest(f.request),
    ),
  ).toThrow();
  expect(touched).toBe(false);
  const g = fixture();
  const changed = {
    ...g.authority,
    members: [{ ...g.qualified, account: { ...g.qualified.account, accountKind: "Customer" } }],
  };
  expect(() =>
    parseInitialBrandMembershipAuthority(
      changed,
      parseInitialBrandMembershipRequest(g.request),
      at,
      at,
      hashInitialBrandMembershipRequest(g.request),
    ),
  ).toThrow();
});
it("hashes the complete normalized request independently of incoming object key order", () => {
  const f = fixture(),
    original = hashInitialBrandMembershipRequest(f.request);
  expect(
    hashInitialBrandMembershipRequest(Object.fromEntries(Object.entries(f.request).reverse())),
  ).toBe(original);
  expect(
    hashInitialBrandMembershipRequest({
      ...f.request,
      members: [{ ...f.member, effectiveUntil: lease }],
    }),
  ).not.toBe(original);
  expect(() =>
    parseInitialBrandMembershipAuthority(
      { ...f.authority, requestDigest: "sha256:" + "b".repeat(64) },
      parseInitialBrandMembershipRequest(f.request),
      at,
      at,
      original,
    ),
  ).toThrow();
});

it("admits real account-only initial members and keeps operational authenticated construction", () => {
  const f = fixture(),
    account = f.qualified.account;
  const value = {
    membershipReference: id(6),
    actorReference: id(1),
    brandReference: id(3),
    workforceRelationshipReference: id(7),
    lifecycle: "Active",
    effectiveFrom: at,
    effectiveUntil: until,
    version: 1,
    createdAt: at,
    updatedAt: at,
  };
  const initial = createInitialBrandMembership(value, account, at);
  expect(initial).toMatchObject({ lifecycle: "Active", version: 1, createdAt: at });
  expect(createMembership(value, f.authority.operator)).toEqual(initial);
  expect(() => Reflect.apply(createMembership, undefined, [value, account])).toThrow();
  expect(() => createIdentityActor(account)).toThrow();
  for (const patch of [
    { lifecycle: "Suspended" },
    { lifecycle: "Pending" },
    { version: 2 },
    { updatedAt: lease },
    { createdAt: lease },
    { effectiveFrom: lease },
    { effectiveUntil: null },
    { workforceRelationshipReference: null },
    { actorReference: id(99) },
  ])
    expect(() => createInitialBrandMembership({ ...value, ...patch }, account, at)).toThrow();
});
it("requires current account origin, observation and actual validity, and shrinks authority", () => {
  const f = fixture(),
    request = parseInitialBrandMembershipRequest(f.request),
    digest = hashInitialBrandMembershipRequest(request);
  const read = (account: unknown, now = at) =>
    parseInitialBrandMembershipAuthority(
      { ...f.authority, members: [{ ...f.qualified, account }] },
      request,
      at,
      now,
      digest,
    );
  const short = parseCurrentWorkforceAccount({
    ...f.qualified.account,
    validUntil: "2026-10-06T10:00:03.000Z",
  });
  expect(read(short).validUntil).toBe(short.validUntil);
  for (const patch of [
    { observedAt: "2026-10-06T09:59:59.999Z" },
    { observedAt: "2026-10-06T10:00:00.001Z" },
    { validUntil: at },
    { authenticatedAt: at },
    { recentMfaAt: at },
    { verificationLevel: "Mfa" },
    { status: "Disabled" },
  ])
    expect(() => read({ ...f.qualified.account, ...patch })).toThrow();
  expect(() => read(short, "2026-10-06T10:00:03.000Z")).toThrow();
});
