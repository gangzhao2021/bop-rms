import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  context: vi.fn(),
  memberships: vi.fn(),
  assignments: vi.fn(),
  authorize: vi.fn(),
  roles: vi.fn(),
  transactions: [] as unknown[],
}));
vi.mock("@bop/identity", async (original) => ({
  ...(await original<typeof import("@bop/identity")>()),
  createPostgresCurrentBrowserSessionSource: () => async (tx: unknown) => {
    mocks.transactions.push(tx);
    return mocks.session();
  },
}));
vi.mock("@bop/membership", async (original) => ({
  ...(await original<typeof import("@bop/membership")>()),
  createPostgresCurrentMembershipSource: () => ({
    findMemberships: mocks.memberships,
    findStoreAssignments: mocks.assignments,
  }),
}));
vi.mock("@bop/permission", async (original) => ({
  ...(await original<typeof import("@bop/permission")>()),
  createPostgresCurrentPermissionPolicySource: () => ({
    authorize: mocks.authorize,
    authorizeWithRoles: mocks.roles,
  }),
}));
vi.mock("./merchant-selected-context.js", () => ({
  createMerchantSelectedContext: () => mocks.context,
}));
import { createAuthenticationSession } from "@bop/identity";
import { createMembership, createStoreAssignment } from "@bop/membership";
import { createBrand, createStore, createTenantContext } from "@bop/tenant";
import { prepareMerchantManagerQueueEligibility } from "./merchant-manager-queue-eligibility.js";
const id = (n: number) => "0190fac9-0000-7000-8000-" + String(n).padStart(12, "0");
const from = "2026-09-20T10:00:00.000Z",
  at = "2026-09-20T10:10:00.000Z",
  end = "2026-09-20T10:30:00.000Z";
const session = createAuthenticationSession({
  sessionReference: id(1),
  actor: {
    actorType: "User",
    actorReference: id(2),
    accountKind: "Workforce",
    status: "Active",
    authenticationMethod: "Oidc",
    verificationLevel: "SingleFactor",
    authenticatedAt: from,
    recentMfaAt: null,
  },
  status: "Active",
  policyCode: "WorkforceStandard",
  maxActiveSessions: 5,
  idleTimeoutMinutes: 30,
  absoluteTimeoutMinutes: 720,
  version: 1,
  authenticatedAt: from,
  createdAt: from,
  lastSeenAt: from,
  idleExpiresAt: end,
  absoluteExpiresAt: "2026-09-20T22:00:00.000Z",
  rotatedFromSessionReference: null,
  revocationReason: null,
  revokedAt: null,
});
const brand = createBrand({
  brandReference: id(3),
  code: "SYNTHETIC",
  displayName: "Synthetic",
  defaultLocale: "en-CA",
  currencyCode: "CAD",
  lifecycle: "Active",
  version: 1,
  createdAt: from,
  updatedAt: from,
});
const store = createStore({
  storeReference: id(4),
  brandReference: id(3),
  code: "SYNTHETIC",
  displayName: "Synthetic",
  timeZone: "America/Toronto",
  locale: "en-CA",
  currencyCode: "CAD",
  lifecycle: "Active",
  version: 1,
  createdAt: from,
  updatedAt: from,
});
const membership = createMembership(
  {
    membershipReference: id(5),
    actorReference: id(2),
    brandReference: id(3),
    workforceRelationshipReference: id(6),
    lifecycle: "Active",
    effectiveFrom: from,
    effectiveUntil: end,
    version: 1,
    createdAt: from,
    updatedAt: from,
  },
  session.actor,
);
const assignment = createStoreAssignment(
  {
    storeAssignmentReference: id(7),
    membershipReference: id(5),
    actorReference: id(2),
    brandReference: id(3),
    storeReference: id(4),
    lifecycle: "Active",
    effectiveFrom: from,
    effectiveUntil: end,
    version: 1,
    createdAt: from,
    updatedAt: from,
  },
  membership,
  store,
);

const policy = {
  tenantReference: id(8),
  brandReference: id(3),
  storeReference: id(4),
  queueReference: id(10),
  managerRoleCode: "synthetic_manager",
  effectiveFrom: from,
  effectiveUntil: "2026-09-20T10:20:00.000Z",
};
const input = {
  sessionCookie: "synthetic-cookie",
  actorReference: id(2),
  evidenceReference: id(11),
  policy,
};
const tx = { query: vi.fn() };
const source = {
  now: () => at,
  identity: { hasher: {} },
  currentActor: vi.fn(),
  validateAssociation: async () => true,
} as unknown as Parameters<typeof prepareMerchantManagerQueueEligibility>[1];
beforeEach(() => {
  mocks.transactions.length = 0;
  mocks.session.mockReset().mockResolvedValue(session);
  mocks.context.mockReset().mockResolvedValue({
    tenantReference: id(8),
    context: createTenantContext(session.actor, brand, store, at),
  });
  mocks.memberships.mockReset().mockResolvedValue([membership]);
  mocks.assignments.mockReset().mockResolvedValue([assignment]);
  mocks.authorize.mockReset().mockResolvedValue({ effect: "Allow", action: "merchant.access" });
  mocks.roles.mockReset().mockResolvedValue({
    decision: { effect: "Allow", action: "task.claim", scopeKind: "Store" },
    activeRoleCodes: ["synthetic_manager"],
  });
});
it("prepares exact immutable Queue eligibility with current membership and shortest validity", async () => {
  const evidence = await prepareMerchantManagerQueueEligibility(tx, source, input);
  expect(evidence).toMatchObject({
    actorReference: id(2),
    target: { kind: "Queue", reference: id(10) },
    eligible: true,
    checkedAt: at,
    validUntil: policy.effectiveUntil,
    membershipReference: id(5),
    storeAssignmentReference: id(7),
  });
  expect(Object.isFrozen(evidence)).toBe(true);
  expect(Object.isFrozen(evidence.target)).toBe(true);
  expect(mocks.transactions).toEqual([tx]);
});
it("does not accept task permission without the configured Manager role", async () => {
  mocks.roles.mockResolvedValue({
    decision: { effect: "Allow", action: "task.claim", scopeKind: "Store" },
    activeRoleCodes: ["cashier"],
  });
  await expect(prepareMerchantManagerQueueEligibility(tx, source, input)).rejects.toThrow(
    "MERCHANT_QUEUE_ELIGIBILITY_UNAVAILABLE",
  );
});
it("does not accept the Manager role without claim permission", async () => {
  mocks.roles.mockResolvedValue({
    decision: { effect: "Deny", action: "task.claim", scopeKind: "Store" },
    activeRoleCodes: ["synthetic_manager"],
  });
  await expect(prepareMerchantManagerQueueEligibility(tx, source, input)).rejects.toThrow();
});
it.each([
  { ...input, actorReference: id(99) },
  { ...input, policy: { ...policy, storeReference: id(99) } },
  { ...input, policy: { ...policy, tenantReference: id(99) } },
  { ...input, policy: { ...policy, effectiveUntil: at } },
  { ...input, policy: { ...policy, effectiveFrom: "2026-09-20T11:00:00.000Z" } },
])("denies foreign actor/scope or invalid policy window %#", async (value) => {
  await expect(prepareMerchantManagerQueueEligibility(tx, source, value)).rejects.toThrow();
  expect(mocks.roles).not.toHaveBeenCalled();
});
it("denies absent current Store assignment", async () => {
  mocks.assignments.mockResolvedValue([]);
  await expect(prepareMerchantManagerQueueEligibility(tx, source, input)).rejects.toThrow();
  expect(mocks.roles).not.toHaveBeenCalled();
});
