import { createPostgresCurrentPermissionPolicySource } from "@bop/permission";
import { createIdentityActor } from "@bop/identity";
import { createBrand, createStore, createTenantContext } from "@bop/tenant";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMerchantStoreScope,
  createInitiallyAuthorizedMerchantStoreScope,
} from "./merchant-store-scope.js";

const ports = vi.hoisted(() => ({
  session: vi.fn(),
  selected: vi.fn(),
  memberships: vi.fn(),
  assignments: vi.fn(),
  membership: vi.fn(),
  assignment: vi.fn(),
  authorize: vi.fn(),
  validity: vi.fn(),
  source: vi.fn(),
}));
vi.mock("@bop/identity", async (original) => ({
  ...(await original<typeof import("@bop/identity")>()),
  createPostgresCurrentBrowserSessionSource: () => ports.session,
}));
vi.mock("./merchant-selected-context.js", () => ({
  createMerchantSelectedContext: () => ports.selected,
}));
vi.mock("@bop/membership", () => ({
  createPostgresCurrentMembershipSource: (...args: unknown[]) => {
    ports.source(...args);
    return { findMemberships: ports.memberships, findStoreAssignments: ports.assignments };
  },
  resolveActiveMembership: ports.membership,
  resolveActiveStoreAssignment: ports.assignment,
}));
vi.mock("@bop/permission", () => ({
  createPostgresCurrentPermissionPolicySource: () => ({
    authorize: ports.authorize,
    async authorizeWithRoles(request: unknown) {
      return {
        decision: await ports.authorize(request),
        validUntil: await ports.validity(request),
        activeRoleCodes: [],
      };
    },
  }),
}));
const id = (n: number) => "0190ab56-0000-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-10-04T12:00:00.000Z";
function actor(n = 2) {
  return createIdentityActor({
    actorType: "User",
    actorReference: id(n),
    accountKind: "Workforce",
    status: "Active",
    authenticationMethod: "Oidc",
    verificationLevel: "SingleFactor",
    authenticatedAt: at,
    recentMfaAt: null,
  });
}
function selection(changed?: "tenant" | "brand" | "store" | "actor") {
  const brandReference = id(changed === "brand" ? 90 : 1),
    brand = createBrand({
      brandReference,
      code: "SYNTHETIC",
      displayName: "Synthetic Brand",
      defaultLocale: "en-CA",
      currencyCode: "CAD",
      lifecycle: "Active",
      version: 1,
      createdAt: at,
      updatedAt: at,
    }),
    store = createStore({
      storeReference: id(changed === "store" ? 90 : 4),
      brandReference,
      code: "SYNTHETIC",
      displayName: "Synthetic Store",
      timeZone: "America/Toronto",
      locale: "en-CA",
      currencyCode: "CAD",
      lifecycle: "Active",
      version: 1,
      createdAt: at,
      updatedAt: at,
    });
  return {
    tenantReference: id(changed === "tenant" ? 90 : 3),
    context: createTenantContext(actor(changed === "actor" ? 90 : 2), brand, store, at),
  };
}
const session = (n = 2, policyCode = "WorkforceStandard") => ({
  sessionReference: id(6),
  actor: actor(n),
  policy: { code: policyCode },
  idleExpiresAt: "2026-10-04T12:30:00.000Z",
  absoluteExpiresAt: "2026-10-04T20:00:00.000Z",
});
const tx = { query: vi.fn(async () => ({ rows: [] })) },
  membership = { membershipReference: id(5) },
  assignment = { storeAssignmentReference: id(7) };
beforeEach(() => {
  vi.resetAllMocks();
  ports.session.mockResolvedValue(session());
  ports.selected.mockResolvedValue(selection());
  ports.memberships.mockResolvedValue([membership]);
  ports.assignments.mockResolvedValue([assignment]);
  ports.membership.mockReturnValue(membership);
  ports.assignment.mockReturnValue(assignment);
  ports.validity.mockResolvedValue(null);
  ports.authorize.mockImplementation(async (request: { action: string }) => ({
    effect: "Allow",
    scopeKind: "Store",
    action: request.action,
  }));
});
// The owning ports are controlled; this composition test proves no current
// navigation decision is reused across an independent allowed/action invocation.
const resolve = (action = "merchant.access", expectedSession = id(6)) =>
  createMerchantStoreScope({ identity: {}, now: () => at } as never)(
    tx,
    "synthetic-cookie",
    action,
    expectedSession,
  );
it("returns the first actual navigation decision once for the identical merchant.access request", async () => {
  const decision = { effect: "Allow", scopeKind: "Store", action: "merchant.access" };
  ports.authorize.mockResolvedValue(decision);
  const scope = await resolve();
  expect(await scope.authorizeAction("merchant.access")).toBe(decision);
  expect(ports.authorize).toHaveBeenCalledOnce();
  expect(ports.authorize).toHaveBeenCalledWith({
    tenantContext: selection().context,
    membership,
    storeAssignment: assignment,
    action: "merchant.access",
  });
  expect(ports.session).toHaveBeenCalledTimes(2);
  expect(ports.selected).toHaveBeenCalledTimes(2);
  expect(ports.memberships).toHaveBeenCalledWith(id(2), id(1));
  expect(ports.assignments).toHaveBeenCalledWith(id(5), id(4));
});
it("rereads all current owners on every allowed call and observes later navigation revocation", async () => {
  const scope = await resolve();
  expect(await scope.allowed()).toBe(true);
  ports.authorize.mockResolvedValue({
    effect: "Deny",
    scopeKind: "Store",
    action: "merchant.access",
  });
  expect(await scope.allowed()).toBe(false);
  expect(ports.authorize.mock.calls.map(([request]) => request.action)).toEqual([
    "merchant.access",
    "merchant.access",
  ]);
  expect(ports.session).toHaveBeenCalledTimes(3);
  expect(ports.selected).toHaveBeenCalledTimes(3);
  expect(ports.memberships).toHaveBeenCalledTimes(2);
  expect(ports.assignments).toHaveBeenCalledTimes(2);
});
it("preserves both decisions for a different action and returns its actual denial", async () => {
  const denied = { effect: "Deny", scopeKind: "Store", action: "catalog.manage" };
  ports.authorize.mockImplementation(async (request: { action: string }) =>
    request.action === "merchant.access"
      ? { ...denied, effect: "Allow", action: request.action }
      : denied,
  );
  const scope = await resolve("catalog.manage");
  expect(await scope.authorizeAction("catalog.manage")).toBe(denied);
  expect(ports.authorize.mock.calls.map(([request]) => request.action)).toEqual([
    "merchant.access",
    "catalog.manage",
  ]);
  expect(ports.authorize.mock.calls[0]?.[0].tenantContext).toBe(
    ports.authorize.mock.calls[1]?.[0].tenantContext,
  );
  expect(ports.authorize.mock.calls[0]?.[0].membership).toBe(
    ports.authorize.mock.calls[1]?.[0].membership,
  );
  expect(ports.authorize.mock.calls[0]?.[0].storeAssignment).toBe(
    ports.authorize.mock.calls[1]?.[0].storeAssignment,
  );
});
it.each(["merchant.access", "catalog.manage"])(
  "navigation denial stops %s without a second policy request",
  async (action) => {
    const scope = await resolve(action);
    ports.authorize.mockResolvedValue({
      effect: "Deny",
      scopeKind: "Store",
      action: "merchant.access",
    });
    expect(await scope.authorizeAction(action)).toBeNull();
    expect(ports.authorize).toHaveBeenCalledOnce();
  },
);
it("rejects a replaced session before resolving its selected context or policies", async () => {
  const scope = await resolve();
  ports.session.mockResolvedValue({ ...session(), sessionReference: id(90) });
  expect(await scope.allowed()).toBe(false);
  expect(ports.selected).toHaveBeenCalledOnce();
  expect(ports.memberships).not.toHaveBeenCalled();
  expect(ports.authorize).not.toHaveBeenCalled();
});
it.each(["tenant", "brand", "store", "actor"] as const)(
  "rejects a changed current %s before membership/policy access",
  async (changed) => {
    const scope = await resolve();
    if (changed === "actor") ports.session.mockResolvedValue(session(90));
    ports.selected.mockResolvedValue(selection(changed));
    expect(await scope.allowed()).toBe(false);
    expect(ports.session).toHaveBeenCalledTimes(2);
    expect(ports.selected).toHaveBeenCalledTimes(2);
    expect(ports.memberships).not.toHaveBeenCalled();
    expect(ports.authorize).not.toHaveBeenCalled();
  },
);
it("requires the expected original session at initial resolution", async () => {
  await expect(resolve("merchant.access", id(90))).rejects.toThrow(
    "STORE_SERVICE_PERMISSION_DENIED",
  );
  expect(ports.selected).not.toHaveBeenCalled();
  expect(ports.authorize).not.toHaveBeenCalled();
});

it("exposes the original session limit before any policy read and never renews it", async () => {
  const first = { ...session(), idleExpiresAt: "2026-10-04T12:00:02.000Z" };
  ports.session.mockResolvedValue(first);
  const scope = await resolve();
  expect(scope.authorizationValidUntil()).toBe(first.idleExpiresAt);
  ports.session.mockResolvedValue(session());
  expect(await scope.allowed()).toBe(true);
  expect(scope.authorizationValidUntil()).toBe(first.idleExpiresAt);
  expect(ports.authorize).toHaveBeenCalledOnce();
});
it.each(["idleExpiresAt", "absoluteExpiresAt"] as const)(
  "retains the actual %s session boundary",
  async (field) => {
    ports.session.mockResolvedValue({ ...session(), [field]: "2026-10-04T12:00:01.000Z" });
    const scope = await resolve();
    expect(await scope.allowed()).toBe(true);
    expect(scope.authorizationValidUntil()).toBe("2026-10-04T12:00:01.000Z");
  },
);
it("merges actual navigation and requested policy boundaries without repeating an action", async () => {
  ports.validity.mockImplementation(async (request: { action: string }) =>
    request.action === "merchant.access" ? "2026-10-04T12:00:03.000Z" : "2026-10-04T12:00:01.000Z",
  );
  const scope = await resolve("catalog.manage");
  expect(await scope.allowed()).toBe(true);
  expect(scope.authorizationValidUntil()).toBe("2026-10-04T12:00:01.000Z");
  expect(ports.authorize.mock.calls.map(([value]) => value.action)).toEqual([
    "merchant.access",
    "catalog.manage",
  ]);
  ports.validity.mockResolvedValue(null);
  expect(await scope.allowed()).toBe(true);
  expect(scope.authorizationValidUntil()).toBe("2026-10-04T12:00:01.000Z");
});
it("retains future membership/assignment boundaries provided by the owning policy result", async () => {
  const scope = await resolve();
  ports.validity.mockResolvedValue("2026-10-04T12:00:00.500Z");
  expect(await scope.allowed()).toBe(true);
  expect(scope.authorizationValidUntil()).toBe("2026-10-04T12:00:00.500Z");
  expect(ports.validity).toHaveBeenCalledWith(
    expect.objectContaining({ membership, storeAssignment: assignment }),
  );
});
it.each([undefined, "invalid", at, "2026-10-04T11:59:59.000Z"])(
  "rejects missing or nonfuture owning metadata %s",
  async (value) => {
    const scope = await resolve();
    ports.validity.mockResolvedValue(value);
    await expect(scope.allowed()).rejects.toThrow("STORE_SERVICE_PERMISSION_DENIED");
  },
);
it("does not read a hostile session-expiry accessor", async () => {
  let calls = 0;
  const hostile = session();
  Object.defineProperty(hostile, "idleExpiresAt", {
    enumerable: true,
    get() {
      calls++;
      return session().idleExpiresAt;
    },
  });
  ports.session.mockResolvedValue(hostile);
  await expect(resolve()).rejects.toThrow("STORE_SERVICE_PERMISSION_DENIED");
  expect(calls).toBe(0);
  expect(ports.selected).not.toHaveBeenCalled();
});
it("rejects an actual boundary crossed during policy evaluation", async () => {
  let now = at;
  const scope = await createMerchantStoreScope({ identity: {}, now: () => now } as never)(
    tx,
    "synthetic-cookie",
    "merchant.access",
    id(6),
  );
  ports.validity.mockImplementation(async () => {
    now = "2026-10-04T12:00:01.000Z";
    return now;
  });
  await expect(scope.allowed()).rejects.toThrow("STORE_SERVICE_PERMISSION_DENIED");
});

it.each(["idleExpiresAt", "absoluteExpiresAt"] as const)(
  "refuses a current session missing %s metadata",
  async (field) => {
    const incomplete: Record<string, unknown> = { ...session() };
    Reflect.deleteProperty(incomplete, field);
    ports.session.mockResolvedValue(incomplete);
    await expect(resolve()).rejects.toThrow("STORE_SERVICE_PERMISSION_DENIED");
    expect(ports.selected).not.toHaveBeenCalled();
    expect(ports.authorize).not.toHaveBeenCalled();
  },
);

const initiallyAuthorized = (expectedSession = id(6)) =>
  createInitiallyAuthorizedMerchantStoreScope({ identity: {}, now: () => at } as never)(
    tx,
    "synthetic-cookie",
    expectedSession,
  );
it("initial authorization consumes one actual Session and Selection and returns its owning navigation decision", async () => {
  const decision = Object.freeze({
    effect: "Allow",
    scopeKind: "Store",
    action: "merchant.access",
  });
  ports.authorize.mockResolvedValue(decision);
  const scope = await initiallyAuthorized();
  expect(scope.initialAuthorization).toBe(decision);
  expect(scope.initialObservedAt).toBe(at);
  expect(Object.isFrozen(scope)).toBe(true);
  expect(ports.session).toHaveBeenCalledOnce();
  expect(ports.selected).toHaveBeenCalledOnce();
  expect(ports.memberships).toHaveBeenCalledOnce();
  expect(ports.assignments).toHaveBeenCalledOnce();
  expect(ports.authorize).toHaveBeenCalledOnce();
  expect(await scope.allowed()).toBe(true);
  expect(ports.session).toHaveBeenCalledTimes(2);
  expect(ports.selected).toHaveBeenCalledTimes(2);
  expect(ports.authorize).toHaveBeenCalledTimes(2);
});
it("initial permission does not hide a later navigation refusal or changed selection", async () => {
  const scope = await initiallyAuthorized();
  ports.authorize.mockResolvedValue({
    effect: "Deny",
    scopeKind: "Store",
    action: "merchant.access",
  });
  expect(await scope.allowed()).toBe(false);
  ports.selected.mockResolvedValue(selection("store"));
  expect(await scope.allowed()).toBe(false);
  expect(ports.session).toHaveBeenCalledTimes(3);
});
it("initial navigation refusal is not converted into an initial allow", async () => {
  ports.authorize.mockResolvedValue({
    effect: "Deny",
    scopeKind: "Store",
    action: "merchant.access",
  });
  const scope = await initiallyAuthorized();
  expect(scope.initialAuthorization).toBeNull();
  expect(ports.authorize).toHaveBeenCalledOnce();
});
it("initial admission refuses a changed Session or mismatched Actor before permission assessment", async () => {
  await expect(initiallyAuthorized(id(90))).rejects.toThrow("STORE_SERVICE_PERMISSION_DENIED");
  expect(ports.authorize).not.toHaveBeenCalled();
  ports.selected.mockResolvedValue(selection("actor"));
  await expect(initiallyAuthorized()).rejects.toThrow("STORE_SERVICE_PERMISSION_DENIED");
  expect(ports.authorize).not.toHaveBeenCalled();
});
it("initial admission retains the actual policy deadline and refuses expiry during or after its read", async () => {
  let clock = at;
  const until = new Date(Date.parse(at) + 200).toISOString();
  ports.validity.mockResolvedValue(until);
  const resolveInitial = createInitiallyAuthorizedMerchantStoreScope({
    identity: {},
    now: () => clock,
  } as never);
  const scope = await resolveInitial(tx, "synthetic-cookie", id(6));
  expect(scope.authorizationValidUntil()).toBe(until);
  clock = until;
  await expect(scope.allowed()).rejects.toThrow("STORE_SERVICE_PERMISSION_DENIED");
  clock = at;
  ports.validity.mockImplementation(async () => {
    clock = until;
    return until;
  });
  await expect(resolveInitial(tx, "synthetic-cookie", id(6))).rejects.toThrow(
    "STORE_SERVICE_PERMISSION_DENIED",
  );
});

it("shares one transaction Permission owner for navigation and later actions without retaining Allow", async () => {
  const policy = createPostgresCurrentPermissionPolicySource(tx),
    read = vi.spyOn(policy, "authorizeWithRoles"),
    source = { identity: {}, now: () => at } as never;
  const scope = await createInitiallyAuthorizedMerchantStoreScope(source, policy)(
    tx,
    "synthetic-cookie",
    id(6),
  );
  expect(read).toHaveBeenCalledTimes(1);
  expect(await scope.allowed()).toBe(true);
  expect(await scope.authorizeAction("catalog.option_set.read")).toMatchObject({ effect: "Allow" });
  expect(read.mock.calls.map(([request]) => request.action)).toEqual([
    "merchant.access",
    "merchant.access",
    "merchant.access",
    "catalog.option_set.read",
  ]);
  ports.authorize.mockImplementation(async (request: { action: string }) => ({
    effect: "Deny",
    scopeKind: "Store",
    action: request.action,
  }));
  expect(await scope.allowed()).toBe(false);
  expect(ports.session).toHaveBeenCalledTimes(4);
  expect(ports.selected).toHaveBeenCalledTimes(4);
});
it("keeps the later policy boundary when the shared source expires", async () => {
  let clock = at;
  const until = new Date(Date.parse(at) + 200).toISOString();
  const policy = createPostgresCurrentPermissionPolicySource(tx);
  ports.validity.mockResolvedValue(until);
  const scope = await createInitiallyAuthorizedMerchantStoreScope(
    { identity: {}, now: () => clock } as never,
    policy,
  )(tx, "synthetic-cookie", id(6));
  expect(scope.authorizationValidUntil()).toBe(until);
  clock = until;
  await expect(scope.allowed()).rejects.toThrow("STORE_SERVICE_PERMISSION_DENIED");
});

describe("IDR-0039 named KDS Operator profile", () => {
  it("allows workspace entry and Kitchen operation", async () => {
    ports.session.mockResolvedValue(session(2, "NamedKdsOperator"));
    const scope = await resolve("kitchen.operate");
    expect(await scope.allowed()).toBe(true);
    expect(ports.authorize.mock.calls.map(([request]) => request.action)).toEqual([
      "merchant.access",
      "kitchen.operate",
    ]);
  });
  it.each(["fulfillment.operate", "payment.refund", "catalog.manage", "kitchen.production.manage"])(
    "denies %s even when the Actor's roles allow it, before any policy read",
    async (action) => {
      ports.session.mockResolvedValue(session(2, "NamedKdsOperator"));
      const scope = await resolve(action);
      expect(await scope.allowed()).toBe(false);
      expect(await scope.authorizeAction(action)).toBeNull();
      expect(ports.authorize.mock.calls.map(([request]) => request.action)).not.toContain(action);
    },
  );
  it("leaves ordinary Workforce Sessions to their role policy", async () => {
    const scope = await resolve("fulfillment.operate");
    expect(await scope.allowed()).toBe(true);
  });
});
