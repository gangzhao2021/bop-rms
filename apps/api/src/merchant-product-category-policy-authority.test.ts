import { expect, it, vi } from "vitest";
import { CatalogError, productCategoryAssignmentFields } from "@rms/catalog";
import { createMerchantProductCategoryPolicyAuthority } from "./merchant-product-category-policy-authority.js";
const native = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock("./merchant-brand-scope.js", () => ({ createMerchantBrandScope: () => native.resolve }));
const id = (n: number) => `01909680-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-10-01T18:00:00.000Z";
function fixture() {
  const control = {
    at,
    denied: "",
    scopeKind: "Brand",
    wrongAction: false,
    tenant: id(1),
    brand: id(2),
    store: id(3),
    actor: id(4),
  };
  const tx = { query: vi.fn(async () => ({ rows: [] })) };
  const authorize = vi.fn(async (action: string) => ({
    effect: control.denied === action ? "Deny" : "Allow",
    scopeKind: control.scopeKind,
    action: control.wrongAction ? "wrong.action" : action,
  }));
  native.resolve.mockReset();
  native.resolve.mockImplementation(async (actual, cookie, session) => {
    expect(actual).toBe(tx);
    expect(cookie).toBe("synthetic-session");
    expect(session).toBe(id(7));
    return {
      tenantReference: control.tenant,
      context: { brand: { brandReference: control.brand } },
      selectedStoreReference: control.store,
      actorReference: control.actor,
      authorizeAction: authorize,
    };
  });
  const hold = vi.fn(async () => ({ allowedLifecycles: ["Draft"] as const }));
  const options = {
    merchant: { now: () => control.at } as never,
    transaction: tx,
    sessionCookie: "synthetic-session",
    sessionReference: id(7),
    scope: {
      tenantReference: id(1),
      brandReference: id(2),
      storeReference: id(3),
      actorReference: id(4),
      productReference: id(5),
    },
    holdPolicyUntilTransactionCompletes: hold,
  };
  const packet = () => ({
    tenantReference: id(1),
    brandReference: id(2),
    actorReference: id(4),
    productReference: id(5),
    productVersionReference: id(6),
    purposeCode: "CATALOG_PRODUCT_CATEGORY_MUTATION" as const,
    permission: "catalog.product.manage" as const,
    referencedPermission: "catalog.manage" as const,
    requiredFields: productCategoryAssignmentFields,
    referencedFields: ["categoryReference", "brandReference", "lifecycle"] as const,
    observedAt: control.at,
  });
  return {
    control,
    tx,
    authorize,
    hold,
    options,
    packet,
    authority: createMerchantProductCategoryPolicyAuthority(options),
  };
}
it("holds native current Brand Product and referenced Category permissions around independent policy", async () => {
  const f = fixture();
  expect(await f.authority(f.tx, f.packet())).toEqual({ allowedLifecycles: ["Draft"] });
  expect(f.authorize.mock.calls.map(([action]) => action)).toEqual([
    "catalog.product.manage",
    "catalog.manage",
    "catalog.product.manage",
    "catalog.manage",
  ]);
  expect(f.hold).toHaveBeenCalledTimes(1);
});
it.each(["tenant", "brand", "store", "actor"] as const)(
  "rejects current changed %s before policy",
  async (key) => {
    const f = fixture();
    f.control[key] = id(99);
    await expect(f.authority(f.tx, f.packet())).rejects.toMatchObject({
      code: "CATALOG_PERMISSION_DENIED",
    });
    expect(f.hold).not.toHaveBeenCalled();
  },
);
it.each(["catalog.product.manage", "catalog.manage"])(
  "rejects independent current %s denial",
  async (action) => {
    const f = fixture();
    f.control.denied = action;
    await expect(f.authority(f.tx, f.packet())).rejects.toMatchObject({
      code: "CATALOG_PERMISSION_DENIED",
    });
    expect(f.hold).not.toHaveBeenCalled();
  },
);
it.each(["Store", "WrongAction"])(
  "refuses non-Brand or wrong-action permission (%s)",
  async (mode) => {
    const f = fixture();
    if (mode === "Store") f.control.scopeKind = mode;
    else f.control.wrongAction = true;
    await expect(f.authority(f.tx, f.packet())).rejects.toMatchObject({
      code: "CATALOG_PERMISSION_DENIED",
    });
    expect(f.hold).not.toHaveBeenCalled();
  },
);
it("rejects referenced grant withdrawn after the awaited field policy and poisons the transaction", async () => {
  const f = fixture();
  f.hold.mockImplementation(async () => {
    f.control.denied = "catalog.manage";
    return { allowedLifecycles: ["Draft"] };
  });
  await expect(f.authority(f.tx, f.packet())).rejects.toMatchObject({
    code: "CATALOG_PERMISSION_DENIED",
  });
  f.control.denied = "";
  await expect(f.authority(f.tx, f.packet())).rejects.toMatchObject({
    code: "CATALOG_DEPENDENCY_UNAVAILABLE",
  });
  expect(f.hold).toHaveBeenCalledTimes(1);
});
it.each(["expiry", "reversal", "query"])(
  "rejects a late %s without renewing source lease",
  async (mode) => {
    const f = fixture();
    f.hold.mockImplementation(async () => {
      if (mode === "query") f.tx.query = vi.fn(async () => ({ rows: [] }));
      else f.control.at = new Date(Date.parse(at) + (mode === "expiry" ? 5000 : -1)).toISOString();
      return { allowedLifecycles: ["Draft"] };
    });
    await expect(f.authority(f.tx, f.packet())).rejects.toMatchObject({
      code: "CATALOG_DEPENDENCY_UNAVAILABLE",
    });
  },
);
it("retains the first transaction deadline across multiple held Read and Write policy calls", async () => {
  const f = fixture();
  await f.authority(f.tx, f.packet());
  f.control.at = new Date(Date.parse(at) + 4999).toISOString();
  await f.authority(f.tx, { ...f.packet(), purposeCode: "CATALOG_PRODUCT_CATEGORY_ACCESS" });
  f.control.at = new Date(Date.parse(at) + 5000).toISOString();
  await expect(f.authority(f.tx, f.packet())).rejects.toMatchObject({
    code: "CATALOG_DEPENDENCY_UNAVAILABLE",
  });
  expect(f.hold).toHaveBeenCalledTimes(2);
});
it.each([
  { productReference: id(99) },
  { requiredFields: [] },
  { purposeCode: "OTHER" },
  { referencedPermission: "merchant.access" },
])("refuses rebound or incomplete packets before a policy grant", async (patch) => {
  const f = fixture();
  await expect(f.authority(f.tx, { ...f.packet(), ...patch } as never)).rejects.toBeInstanceOf(
    CatalogError,
  );
  expect(f.hold).not.toHaveBeenCalled();
});
it("does not evaluate source or packet accessors", async () => {
  const f = fixture(),
    getter = vi.fn();
  const packet = { ...f.packet() };
  Object.defineProperty(packet, "observedAt", { enumerable: true, get: getter });
  await expect(f.authority(f.tx, packet)).rejects.toBeInstanceOf(CatalogError);
  expect(getter).not.toHaveBeenCalled();
  expect(f.hold).not.toHaveBeenCalled();
  const g = fixture();
  g.hold.mockImplementation(
    async () =>
      Object.defineProperty({}, "allowedLifecycles", { enumerable: true, get: getter }) as never,
  );
  await expect(g.authority(g.tx, g.packet())).rejects.toBeInstanceOf(CatalogError);
  expect(getter).not.toHaveBeenCalled();
});
it("requires an independent holder and refuses a foreign transaction", async () => {
  const f = fixture();
  expect(() =>
    createMerchantProductCategoryPolicyAuthority({
      ...f.options,
      holdPolicyUntilTransactionCompletes: undefined,
    } as never),
  ).toThrow(CatalogError);
  await expect(f.authority({ query: f.tx.query }, f.packet())).rejects.toBeInstanceOf(CatalogError);
  expect(f.hold).not.toHaveBeenCalled();
});
