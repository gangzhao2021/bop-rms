import { beforeEach, expect, it, vi } from "vitest";
import { createBrand } from "@bop/tenant";
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
const actor = {
  actorType: "User",
  actorReference: id(2),
  accountKind: "Workforce",
  status: "Active",
  authenticationMethod: "Oidc",
  verificationLevel: "SingleFactor",
  authenticatedAt: at,
  recentMfaAt: null,
};
const selected = () => ({
  selected: { tenantReference: id(3) },
  context: { actor, brand, resolvedAt: at },
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
const resolve = () => createMerchantBrandScope({} as never)({} as never, "synthetic-cookie", id(6));
it("requires a separate Brand decision with no Store assignment", async () => {
  const scope = await resolve();
  expect(scope.context.scopeKind).toBe("Brand");
  expect(scope.context.store).toBeNull();
  expect(await scope.authorizeAction("pricing.price-book.manage")).toMatchObject({
    effect: "Allow",
    scopeKind: "Brand",
  });
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
