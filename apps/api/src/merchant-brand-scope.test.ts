import { createIdentityActor } from "@bop/identity";
import { beforeEach, expect, it, vi } from "vitest";
import { createBrand, createStore, createTenantContext } from "@bop/tenant";
import { createMerchantBrandScope } from "./merchant-brand-scope.js";
const ports = vi.hoisted(() => ({
  resolve: vi.fn(),
  find: vi.fn(),
  membership: vi.fn(),
  authorize: vi.fn(),
  source: vi.fn(),
}));
vi.mock("./merchant-store-scope.js", () => ({ createMerchantStoreScope: () => ports.resolve }));
vi.mock("@bop/membership", () => ({
  createPostgresCurrentMembershipSource: (...args: unknown[]) => {
    ports.source(...args);
    return { findMemberships: ports.find };
  },
  resolveActiveMembership: ports.membership,
}));
vi.mock("@bop/permission", () => ({
  createPostgresCurrentPermissionPolicySource: () => ({ authorize: ports.authorize }),
}));
const id = (n: number) => "0190ab55-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-09-14T08:00:00.000Z";
const brand = createBrand({
  brandReference: id(1),
  code: "DEMO",
  displayName: "Synthetic Brand",
  defaultLocale: "en-CA",
  currencyCode: "CAD",
  lifecycle: "Active",
  version: 1,
  createdAt: at,
  updatedAt: at,
});
const actor = createIdentityActor({
  actorType: "User",
  actorReference: id(2),
  accountKind: "Workforce",
  status: "Active",
  authenticationMethod: "Oidc",
  verificationLevel: "SingleFactor",
  authenticatedAt: at,
  recentMfaAt: null,
});
const store = createStore({
  storeReference: id(4),
  brandReference: id(1),
  code: "SYNTH_STORE",
  displayName: "Synthetic Store",
  timeZone: "America/Toronto",
  locale: "en-CA",
  currencyCode: "CAD",
  lifecycle: "Active",
  version: 1,
  createdAt: at,
  updatedAt: at,
});
const selected = () => ({
  selected: { tenantReference: id(3) },
  context: createTenantContext(actor, brand, store, at),
  store: { storeReference: id(4) },
  actorReference: id(2),
  allowed: async () => true,
});
beforeEach(() => {
  vi.clearAllMocks();
  ports.resolve.mockResolvedValue(selected());
  ports.find.mockResolvedValue([]);
  ports.membership.mockReturnValue({ membershipReference: id(5) });
  ports.authorize.mockImplementation(async (request) => ({
    effect: "Allow",
    scopeKind: "Brand",
    action: request.action,
  }));
});
const resolve = () =>
  createMerchantBrandScope({ now: () => at } as never)({} as never, "synthetic-cookie", id(6));
it("requires a separate Brand decision with no Store assignment", async () => {
  const scope = await resolve();
  expect(scope.context.scopeKind).toBe("Brand");
  expect(scope.context.store).toBeNull();
  expect(scope.selectedStoreReference).toBe(id(4));
  expect(await scope.authorizeAction("pricing.price-book.manage")).toMatchObject({
    effect: "Allow",
    scopeKind: "Brand",
  });
  expect(ports.source).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({
      scopeKind: "Store",
      store: expect.objectContaining({ storeReference: id(4) }),
    }),
  );
  expect(ports.authorize).toHaveBeenCalledWith(
    expect.objectContaining({
      storeAssignment: null,
      tenantContext: expect.objectContaining({ scopeKind: "Brand", store: null }),
      action: "pricing.price-book.manage",
    }),
  );
  expect(ports.resolve).toHaveBeenLastCalledWith(
    expect.anything(),
    "synthetic-cookie",
    "merchant.access",
    id(6),
  );
});
it("does not elevate a Store-only approval", async () => {
  ports.authorize.mockResolvedValue({
    effect: "Allow",
    scopeKind: "Store",
    action: "pricing.price-book.approve",
  });
  expect(await (await resolve()).authorizeAction("pricing.price-book.approve")).toBeNull();
});
it("preserves a current Brand denial", async () => {
  ports.authorize.mockResolvedValue({
    effect: "Deny",
    scopeKind: "Brand",
    action: "pricing.price-book.manage",
  });
  expect(await (await resolve()).authorizeAction("pricing.price-book.manage")).toMatchObject({
    effect: "Deny",
  });
});
it.each(["tenant", "store", "actor", "revoked"])(
  "rejects changed %s before Brand policy",
  async (changed) => {
    const scope = await resolve(),
      next = selected();
    if (changed === "tenant") next.selected.tenantReference = id(90);
    if (changed === "store") next.store.storeReference = id(90);
    if (changed === "actor") next.actorReference = id(90);
    if (changed === "revoked") next.allowed = async () => false;
    ports.resolve.mockResolvedValue(next);
    expect(await scope.authorizeAction("pricing.price-book.manage")).toBeNull();
    expect(ports.authorize).not.toHaveBeenCalled();
  },
);
it("rejects inaccessible initial selection", async () => {
  ports.resolve.mockResolvedValue({ ...selected(), allowed: async () => false });
  await expect(resolve()).rejects.toThrow("BRAND_SERVICE_PERMISSION_DENIED");
});
it("requires the authenticated session identity anchor", async () => {
  await expect(
    createMerchantBrandScope({} as never)({} as never, "synthetic-cookie", undefined as never),
  ).rejects.toThrow("BRAND_SERVICE_PERMISSION_DENIED");
  expect(ports.resolve).not.toHaveBeenCalled();
});

it("reads each current Brand permission with current membership and checks navigation before/after one batch", async () => {
  const scope = await resolve();
  const prior = ports.resolve.mock.calls.length;
  const actions = ["catalog.product.validate", "catalog.option_set.read"];
  expect(await scope.authorizeActions(actions)).toMatchObject(
    actions.map((action) => ({ action, effect: "Allow", scopeKind: "Brand" })),
  );
  expect(ports.resolve).toHaveBeenCalledTimes(prior + 2);
  expect(ports.find).toHaveBeenCalledTimes(3);
  expect(
    ports.source.mock.calls.every(
      ([, context]) => context.scopeKind === "Store" && context.store.storeReference === id(4),
    ),
  ).toBe(true);
  expect(ports.authorize.mock.calls.map(([r]) => r.action)).toEqual([
    ...actions,
    actions[actions.length - 1],
  ]);
  expect(
    ports.authorize.mock.calls.every(
      ([r]) => r.storeAssignment === null && r.tenantContext.store === null,
    ),
  ).toBe(true);
  ports.authorize.mockImplementation(async (r) => ({
    action: r.action,
    effect: r.action === "catalog.option_set.read" ? "Deny" : "Allow",
    scopeKind: "Brand",
  }));
  expect(await scope.authorizeActions(actions)).toMatchObject([
    { effect: "Allow" },
    { effect: "Deny" },
  ]);
  expect(ports.find).toHaveBeenCalledTimes(6);
});
it.each(["tenant", "store", "actor", "revoked"])(
  "refuses late %s during an admission batch",
  async (changed) => {
    const scope = await resolve();
    const next = selected();
    if (changed === "tenant") next.selected.tenantReference = id(90);
    if (changed === "store") next.store.storeReference = id(90);
    if (changed === "actor") next.actorReference = id(90);
    if (changed === "revoked") next.allowed = async () => false;
    ports.authorize.mockImplementation(async (r) => {
      ports.resolve.mockResolvedValue(next);
      return { action: r.action, effect: "Allow", scopeKind: "Brand" };
    });
    expect(await scope.authorizeActions(["catalog.option_set.read"])).toBeNull();
  },
);
it("rejects malformed/getter action groups without invoking getters or reading sources", async () => {
  const scope = await resolve();
  ports.resolve.mockClear();
  const getter = vi.fn(() => "catalog.manage");
  const values = [] as string[];
  Object.defineProperty(values, "0", { get: getter, enumerable: true });
  for (const actions of [[], ["catalog.manage", "catalog.manage"], [""], values])
    expect(await scope.authorizeActions(actions)).toBeNull();
  expect(getter).not.toHaveBeenCalled();
  expect(ports.resolve).not.toHaveBeenCalled();
});
it("refuses a Store decision in a Brand batch", async () => {
  const scope = await resolve();
  ports.authorize.mockImplementation(async (r) => ({
    action: r.action,
    effect: "Allow",
    scopeKind: "Store",
  }));
  expect(await scope.authorizeActions(["catalog.option_set.read"])).toBeNull();
});

it("captures the original clock rather than accepting a replaced permission instant", async () => {
  const original = vi.fn(() => at),
    replacement = vi.fn(() => "2020-01-01T00:00:00.000Z"),
    configuration = { now: original };
  const scope = await createMerchantBrandScope(configuration as never)(
    {} as never,
    "synthetic-cookie",
    id(6),
  );
  configuration.now = replacement;
  expect(await scope.authorizeActions(["catalog.option_set.read"])).toMatchObject([
    { effect: "Allow" },
  ]);
  expect(replacement).not.toHaveBeenCalled();
  expect(original).toHaveBeenCalledTimes(2);
  expect(ports.authorize).toHaveBeenCalledWith(
    expect.objectContaining({ tenantContext: expect.objectContaining({ resolvedAt: at }) }),
  );
});
