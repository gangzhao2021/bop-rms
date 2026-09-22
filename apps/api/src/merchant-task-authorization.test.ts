import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ authorize: vi.fn(), transactions: [] as unknown[] }));
vi.mock("@bop/permission", async (original) => ({
  ...(await original<typeof import("@bop/permission")>()),
  createPostgresCurrentPermissionPolicySource: (tx: unknown) => {
    mocks.transactions.push(tx);
    return { authorize: mocks.authorize };
  },
}));
import { createAuthenticationSession } from "@bop/identity";
import { createMembership, createStoreAssignment } from "@bop/membership";
import { createBrand, createStore, createTenantContext } from "@bop/tenant";
import { createMerchantTaskAuthorization } from "./merchant-task-authorization.js";
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
const scope = { tenantReference: id(8), brandReference: id(3), storeReference: id(4) };
const request = {
  actorReference: id(2),
  action: "task.create",
  scope: { kind: "Store", brandReference: id(3), storeReference: id(4) },
  evaluatedAt: at,
};
const allowed = (action: string) =>
  Object.freeze({
    effect: "Allow",
    reason: "EXPLICIT_ALLOW",
    source: "ExplicitAllow",
    action,
    scopeKind: "Store",
    policySnapshotReference: id(9),
    policyVersion: 1,
    audit: Object.freeze({ effect: "Allow", reason: "EXPLICIT_ALLOW", source: "ExplicitAllow" }),
  });
beforeEach(() => {
  mocks.transactions.length = 0;
  mocks.authorize
    .mockReset()
    .mockImplementation(async (input: { action: string }) => allowed(input.action));
});
function fixture() {
  const tx = { query: vi.fn() },
    now = vi.fn(() => at),
    sessionPort = vi.fn(async () => session),
    context = vi.fn(async () => ({
      tenantReference: id(8),
      context: createTenantContext(session.actor, brand, store, at),
    })),
    findMemberships = vi.fn(async () => [membership]),
    findStoreAssignments = vi.fn(async () => [assignment]);
  const authorization = createMerchantTaskAuthorization(tx, {
    scope,
    sessionCookie: "synthetic-cookie",
    now,
    session: sessionPort,
    context,
    membership: () => ({ findMemberships, findStoreAssignments }),
  });
  return { authorization, tx, now, sessionPort, context, findMemberships, findStoreAssignments };
}
it("uses current identity, membership and policy in the same transaction on every command", async () => {
  const f = fixture();
  expect(await f.authorization.authorize(request)).toEqual(allowed("task.create"));
  await f.authorization.authorize({ ...request, action: "task.assign" });
  expect(f.sessionPort).toHaveBeenCalledTimes(2);
  expect(f.sessionPort).toHaveBeenCalledWith(f.tx, "synthetic-cookie");
  expect(mocks.transactions).toEqual([f.tx, f.tx]);
  expect(mocks.authorize.mock.calls.map(([input]) => input.action)).toEqual([
    "merchant.access",
    "task.create",
    "merchant.access",
    "task.assign",
  ]);
});
it.each([
  { ...request, actorReference: id(99) },
  { ...request, scope: { ...request.scope, storeReference: id(99) } },
  { ...request, scope: { ...request.scope, brandReference: id(99) } },
  { ...request, scope: { ...request.scope, kind: "Brand", storeReference: null } },
  { ...request, action: "task.complete" },
  { ...request, evaluatedAt: "2026-09-20T10:11:00.000Z" },
])("denies mismatched actor/scope, unsupported action or future command %#", async (input) => {
  const f = fixture();
  await expect(f.authorization.authorize(input)).rejects.toThrow(
    "MERCHANT_TASK_AUTHORIZATION_UNAVAILABLE",
  );
  expect(mocks.authorize).not.toHaveBeenCalled();
});
it("rejects expired sessions without consulting policy", async () => {
  const f = fixture();
  f.now.mockReturnValue(end);
  await expect(f.authorization.authorize(request)).rejects.toThrow();
  expect(mocks.authorize).not.toHaveBeenCalled();
});
it("rejects missing current membership", async () => {
  const f = fixture();
  f.findMemberships.mockResolvedValue([]);
  await expect(f.authorization.authorize(request)).rejects.toThrow();
  expect(mocks.authorize).not.toHaveBeenCalled();
});
it("rejects tenant changes between creation and assignment", async () => {
  const f = fixture();
  await f.authorization.authorize(request);
  f.context.mockResolvedValue({
    tenantReference: id(99),
    context: createTenantContext(session.actor, brand, store, at),
  });
  await expect(f.authorization.authorize({ ...request, action: "task.assign" })).rejects.toThrow();
  expect(mocks.authorize).toHaveBeenCalledTimes(2);
});
it("rejects revoked policy and a decision for a different action", async () => {
  const f = fixture();
  mocks.authorize
    .mockResolvedValueOnce(Object.freeze({ ...allowed("task.create"), effect: "Deny" }))
    .mockResolvedValueOnce(allowed("merchant.access"))
    .mockResolvedValueOnce(allowed("task.create"));
  await expect(f.authorization.authorize(request)).rejects.toThrow();
  await expect(f.authorization.authorize({ ...request, action: "task.assign" })).rejects.toThrow();
});

it("authorizes claim through the current policy without enabling terminal actions", async () => {
  const f = fixture();
  expect(await f.authorization.authorize({ ...request, action: "task.claim" })).toEqual(
    allowed("task.claim"),
  );
  await expect(
    f.authorization.authorize({ ...request, action: "task.complete" }),
  ).rejects.toThrow();
});
