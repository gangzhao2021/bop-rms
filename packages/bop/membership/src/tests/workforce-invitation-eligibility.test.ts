import { createIdentityActor } from "@bop/identity";
import { createBrand, createStore, parseStoreReference } from "@bop/tenant";
import { expect, it, vi } from "vitest";
import {
  createMembership,
  createStoreAssignment,
  MembershipContractError,
  resolveActiveMembership,
  resolveActiveStoreAssignment,
  resolveWorkforceInvitationMembership,
  resolveWorkforceInvitationStoreAssignments,
  type Membership,
  type StoreAssignment,
} from "../index.js";

const id = (n: number) => `0190ed60-0010-7000-8000-${n.toString(16).padStart(12, "0")}`;
const from = "2026-10-01T10:00:00.000Z",
  at = "2026-10-01T11:00:00.000Z",
  until = "2026-10-01T12:00:00.000Z";
// Controlled owning constructors establish snapshot shape, not real account or approval evidence.
const actor = createIdentityActor({
  actorType: "User",
  actorReference: id(1),
  accountKind: "Workforce",
  status: "Active",
  authenticationMethod: "Oidc",
  verificationLevel: "SingleFactor",
  authenticatedAt: from,
  recentMfaAt: null,
});
const actorReference = (() => {
  if (actor.actorReference === null) throw new Error("controlled actor required");
  return actor.actorReference;
})();
const brand = createBrand({
  brandReference: id(2),
  code: "SYNTHETIC",
  displayName: "Synthetic Brand",
  defaultLocale: "en-CA",
  currencyCode: "CAD",
  lifecycle: "Draft",
  version: 1,
  createdAt: from,
  updatedAt: from,
});
const store = createStore({
  storeReference: id(3),
  brandReference: brand.brandReference,
  code: "SYNTHETIC",
  displayName: "Synthetic Store",
  timeZone: "America/Toronto",
  locale: "en-CA",
  currencyCode: "CAD",
  lifecycle: "Active",
  version: 1,
  createdAt: from,
  updatedAt: from,
});
const member = (changes: Readonly<Record<string, unknown>> = {}) =>
  createMembership(
    {
      membershipReference: id(4),
      actorReference,
      brandReference: brand.brandReference,
      workforceRelationshipReference: null,
      lifecycle: "PendingActivation",
      effectiveFrom: from,
      effectiveUntil: until,
      version: 1,
      createdAt: from,
      updatedAt: from,
      ...changes,
    },
    actor,
  );
const assignment = (membership: Membership, changes: Readonly<Record<string, unknown>> = {}) =>
  createStoreAssignment(
    {
      storeAssignmentReference: id(5),
      membershipReference: membership.membershipReference,
      actorReference,
      brandReference: brand.brandReference,
      storeReference: store.storeReference,
      lifecycle: "Active",
      effectiveFrom: from,
      effectiveUntil: until,
      version: 1,
      createdAt: from,
      updatedAt: from,
      ...changes,
    },
    membership,
    store,
  );
const resolve = (members: readonly Membership[], observed: unknown = at) =>
  resolveWorkforceInvitationMembership(members, actorReference, brand.brandReference, observed);

it("accepts an effective Pending owning Membership without authenticating or activating the target", () => {
  const pending = member();
  expect(resolve([pending])).toBe(pending);
  expect(pending.lifecycle).toBe("PendingActivation");
  expect(pending.version).toBe(1);
  expect(pending.workforceRelationshipReference).toBeNull();
  expect(() =>
    resolveActiveMembership([pending], actorReference, brand.brandReference, at),
  ).toThrow();
  const granted = assignment(pending);
  expect(
    resolveWorkforceInvitationStoreAssignments(pending, [granted], [store.storeReference], at),
  ).toEqual([granted]);
  expect(() =>
    resolveActiveStoreAssignment(pending, [granted], store.storeReference, at),
  ).toThrow();
});
it("preserves actual Active eligibility and explicit no-Store invitation scope", () => {
  const active = member({ lifecycle: "Active", workforceRelationshipReference: id(9) });
  expect(resolve([active], from)).toBe(active);
  expect(resolveActiveMembership([active], actorReference, brand.brandReference, at)).toBe(active);
  const result = resolveWorkforceInvitationStoreAssignments(active, [assignment(active)], [], at);
  expect(result).toEqual([]);
  expect(Object.isFrozen(result)).toBe(true);
});
it("rejects suspended, ended, expired, future and ambiguous effective Memberships", () => {
  for (const value of [
    member({ lifecycle: "Suspended" }),
    member({ lifecycle: "Ended" }),
    member({ effectiveUntil: at }),
    member({ effectiveFrom: until, effectiveUntil: null }),
    member({ updatedAt: until }),
  ])
    expect(() => resolve([value])).toThrow(MembershipContractError);
  expect(() => resolve([])).toThrow();
  const pending = member(),
    active = member({
      membershipReference: id(6),
      lifecycle: "Active",
      workforceRelationshipReference: id(9),
    });
  expect(() => resolve([pending, active])).toThrow();
  expect(() => resolve([pending, pending])).toThrow();
  expect(() => resolve([pending], "2026-10-01T11:00:00Z")).toThrow();
});
it("does not use a different Actor or Brand as invitation authority", () => {
  const pending = member();
  expect(() =>
    resolveWorkforceInvitationMembership(
      [pending],
      actorReference,
      createBrand({ ...brand, brandReference: id(8) }).brandReference,
      at,
    ),
  ).toThrow();
  const foreign = Object.freeze({ ...pending, actorReference: id(8) }) as Membership;
  expect(() => resolve([foreign])).toThrow();
});
it("requires closed frozen snapshots and rejects getters without reading them", () => {
  const pending = member(),
    getter = vi.fn(() => actorReference);
  const accessor = Object.freeze(
    Object.defineProperty({ ...pending }, "actorReference", { enumerable: true, get: getter }),
  );
  for (const invalid of [
    { ...pending },
    Object.freeze({ ...pending, approved: true }),
    accessor,
    Object.freeze({ ...pending, lifecycle: "Active" }),
    Object.freeze({ ...pending, version: 0 }),
    Object.freeze({ ...pending, effectiveUntil: from }),
  ])
    expect(() => resolve([invalid as Membership])).toThrow();
  expect(getter).not.toHaveBeenCalled();
});
it("rejects sparse, extra-property, accessor and oversized source arrays", () => {
  const pending = member(),
    getter = vi.fn(() => pending),
    accessor: Membership[] = [];
  Object.defineProperty(accessor, "0", { enumerable: true, get: getter });
  for (const values of [
    new Array<Membership>(1),
    accessor,
    Object.assign([pending], { extra: true }),
    Array.from({ length: 1025 }, () => pending),
  ])
    expect(() => resolve(values)).toThrow();
  expect(getter).not.toHaveBeenCalled();
});
it("requires every exact requested Store once and refuses ambiguous active assignments", () => {
  const pending = member(),
    granted = assignment(pending);
  expect(() =>
    resolveWorkforceInvitationStoreAssignments(
      pending,
      [granted],
      [store.storeReference, store.storeReference],
      at,
    ),
  ).toThrow();
  expect(() =>
    resolveWorkforceInvitationStoreAssignments(
      pending,
      [granted],
      [parseStoreReference(id(90))],
      at,
    ),
  ).toThrow();
  expect(() =>
    resolveWorkforceInvitationStoreAssignments(
      pending,
      [granted, assignment(pending, { storeAssignmentReference: id(6) })],
      [store.storeReference],
      at,
    ),
  ).toThrow();
  expect(() =>
    resolveWorkforceInvitationStoreAssignments(
      pending,
      [granted, granted],
      [store.storeReference],
      at,
    ),
  ).toThrow();
});
it("refuses inactive, out-of-period and wrong tuple Store assignments for Pending Membership", () => {
  const pending = member(),
    granted = assignment(pending);
  for (const changes of [
    { lifecycle: "Suspended" },
    { lifecycle: "Ended" },
    { effectiveUntil: at },
    { effectiveFrom: until, effectiveUntil: null },
    { updatedAt: until },
    { membershipReference: id(8) },
    { actorReference: id(8) },
    { brandReference: id(8) },
  ]) {
    const value = Object.freeze({ ...granted, ...changes }) as StoreAssignment;
    expect(() =>
      resolveWorkforceInvitationStoreAssignments(pending, [value], [store.storeReference], at),
    ).toThrow();
  }
  expect(() =>
    resolveWorkforceInvitationStoreAssignments(
      member({ lifecycle: "Suspended" }),
      [granted],
      [],
      at,
    ),
  ).toThrow();
});
it("bounds requested Stores and validates Store snapshot descriptors even for an empty request", () => {
  const pending = member(),
    granted = assignment(pending),
    getter = vi.fn(() => "Active");
  const accessor = Object.freeze(
    Object.defineProperty({ ...granted }, "lifecycle", { enumerable: true, get: getter }),
  );
  for (const invalid of [{ ...granted }, Object.freeze({ ...granted, allow: true }), accessor])
    expect(() =>
      resolveWorkforceInvitationStoreAssignments(pending, [invalid as StoreAssignment], [], at),
    ).toThrow();
  expect(getter).not.toHaveBeenCalled();
  expect(() =>
    resolveWorkforceInvitationStoreAssignments(pending, [granted], new Array(1), at),
  ).toThrow();
  expect(() =>
    resolveWorkforceInvitationStoreAssignments(
      pending,
      [granted],
      Array.from({ length: 101 }, () => store.storeReference),
      at,
    ),
  ).toThrow();
});
