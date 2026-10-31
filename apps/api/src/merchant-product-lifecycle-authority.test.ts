import { expect, it, vi } from "vitest";
import { CatalogError } from "@rms/catalog";
import {
  createMerchantProductLifecycleGuard,
  productLifecycleReadFields,
  skuLifecycleWriteFields,
  type MerchantProductLifecycleAuthority,
} from "./merchant-product-lifecycle-authority.js";
import { resolveMerchantProductLifecycleIntent } from "./merchant-product-lifecycle-intent.js";
import { MerchantProductWriteFeatureDisabled } from "./merchant-product-write-authority.js";
const id = (n: number) => "01902409-0000-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-09-29T12:00:00.000Z";
type Options = Parameters<typeof createMerchantProductLifecycleGuard>[0];
function setup(
  skuReference: string | null = id(8),
  targetLifecycle: Options["targetLifecycle"] = "Active",
) {
  const checks: (() => Promise<void>)[] = [],
    tx = { query: vi.fn() },
    authorize = vi.fn(async (action: string) => ({ action, effect: "Allow", scopeKind: "Brand" })),
    authority = vi.fn<MerchantProductLifecycleAuthority>(async () => "Allowed");
  const options: Options = {
    transaction: tx,
    scope: {
      tenantReference: id(1),
      context: { brand: { brandReference: id(2) } },
      selectedStoreReference: id(3),
      actorReference: id(4),
      authorizeAction: authorize,
    } as unknown as Options["scope"],
    sessionReference: id(5),
    productReference: id(6),
    operationReference: id(7),
    skuReference,
    expectedAggregateVersion: 4,
    targetLifecycle,
    authority,
    now: () => at,
    registerBeforeCommit: async (actual, check) => {
      expect(actual).toBe(tx);
      checks.push(check);
    },
  };
  return {
    options,
    guard: createMerchantProductLifecycleGuard(options),
    checks,
    tx,
    authority,
    authorize,
  };
}
async function commit(f: ReturnType<typeof setup>) {
  const check = f.checks[0];
  if (!check) throw new Error("Missing synthetic commit check");
  await check();
}
it("leases exact scopes and full fields before read, binds original intent once and rechecks COMMIT", async () => {
  const f = setup();
  await f.guard.holdAndRegister();
  expect(f.authority.mock.calls[0]?.[1]).toEqual({
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    actorReference: id(4),
    sessionReference: id(5),
    productReference: id(6),
    skuReference: id(8),
    operationReference: id(7),
    expectedAggregateVersion: 4,
    targetLifecycle: "Active",
    intent: null,
    reasonCode: null,
    permission: "catalog.manage",
    owningAction: "catalog.product.manage",
    phase: "phase_1",
    screenId: "CAT-SKU-DETAIL",
    capability: "catalog.cat_sku_detail",
    purposeCode: "CATALOG_SKU_LIFECYCLE",
    requiredWriteFields: skuLifecycleWriteFields,
    requiredReadFields: productLifecycleReadFields,
    observedAt: at,
  });
  const intent = resolveMerchantProductLifecycleIntent("Sku", "Draft", "Active");
  await f.guard.bindIntent(intent);
  await commit(f);
  expect(f.authority).toHaveBeenCalledTimes(3);
  for (const [actual, input] of f.authority.mock.calls) {
    expect(actual).toBe(f.tx);
    expect(Object.isFrozen(input)).toBe(true);
  }
  expect(f.authority.mock.calls[2]?.[1].intent).toEqual(intent);
  expect(Object.isFrozen(f.authority.mock.calls[2]?.[1].intent)).toBe(true);
  expect(f.authorize.mock.calls.map((x) => x[0])).toEqual([
    "catalog.manage",
    "catalog.product.manage",
    "catalog.manage",
    "catalog.product.manage",
    "catalog.sku.activate",
    "catalog.manage",
    "catalog.product.manage",
    "catalog.sku.activate",
  ]);
});
it.each([null, id(8)])("maps Archive/Restore to canonical Screen for %s", async (sku) => {
  for (const [target, before, suffix] of [
    ["Archived", "Draft", "archive"],
    ["Draft", "Archived", "restore"],
  ] as const) {
    const f = setup(sku, target);
    await f.guard.holdAndRegister();
    await f.guard.bindIntent(
      resolveMerchantProductLifecycleIntent(sku === null ? "Product" : "Sku", before, target),
    );
    await commit(f);
    const input = f.authority.mock.calls[2]?.[1];
    const object = sku === null ? "product" : "sku";
    expect(input?.capability).toBe(`catalog.cat_${object}_${suffix}`);
    expect(input?.screenId).toBe(`CAT-${object.toUpperCase()}-${suffix.toUpperCase()}`);
  }
});
it.each(["catalog.manage", "catalog.product.manage", "catalog.sku.activate"])(
  "requires current exact Brand %s through COMMIT",
  async (required) => {
    for (const mode of ["Deny", "Store", "WrongAction"] as const) {
      const f = setup();
      await f.guard.holdAndRegister();
      await f.guard.bindIntent(resolveMerchantProductLifecycleIntent("Sku", "Draft", "Active"));
      f.authorize.mockImplementation(async (action) => ({
        action: action === required && mode === "WrongAction" ? "catalog.sku.update" : action,
        effect: action === required && mode === "Deny" ? "Deny" : "Allow",
        scopeKind: action === required && mode === "Store" ? "Store" : "Brand",
      }));
      await expect(commit(f)).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
    }
  },
);
it("pending binding never commits", async () => {
  const f = setup();
  await f.guard.holdAndRegister();
  await expect(commit(f)).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
});
it.each(["FeatureDisabled", "Denied", "Missing"] as const)(
  "current field/Phase %s prevents binding and COMMIT",
  async (mode) => {
    for (const stage of ["Bind", "Commit"] as const) {
      const f = setup();
      await f.guard.holdAndRegister();
      if (stage === "Commit")
        await f.guard.bindIntent(resolveMerchantProductLifecycleIntent("Sku", "Draft", "Active"));
      f.authority.mockImplementation(async () => {
        if (mode === "Denied") throw new CatalogError("CATALOG_PERMISSION_DENIED");
        return (mode === "Missing" ? undefined : mode) as never;
      });
      const result =
        stage === "Commit"
          ? commit(f)
          : f.guard.bindIntent(resolveMerchantProductLifecycleIntent("Sku", "Draft", "Active"));
      if (mode === "FeatureDisabled")
        await expect(result).rejects.toBeInstanceOf(MerchantProductWriteFeatureDisabled);
      else
        await expect(result).rejects.toMatchObject({
          code: mode === "Denied" ? "CATALOG_PERMISSION_DENIED" : "CATALOG_DEPENDENCY_UNAVAILABLE",
        });
    }
  },
);
it.each([
  { action: "resume" },
  { kind: "Product" },
  { actionPermission: "catalog.sku.update" },
  { targetLifecycle: "Suspended" },
  { permission: "Allow" },
])("rejects supplied altered intent %s and latches failed binding", async (patch) => {
  const f = setup();
  await f.guard.holdAndRegister();
  await expect(
    f.guard.bindIntent({
      ...resolveMerchantProductLifecycleIntent("Sku", "Draft", "Active"),
      ...patch,
    }),
  ).rejects.toBeInstanceOf(CatalogError);
  await expect(commit(f)).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
});
it("copies original intent and rejects rebind permanently", async () => {
  const f = setup();
  await f.guard.holdAndRegister();
  const value = { ...resolveMerchantProductLifecycleIntent("Sku", "Draft", "Active") };
  await f.guard.bindIntent(value);
  value.action = "resume";
  await commit(f);
  expect(f.authority.mock.calls[2]?.[1].intent?.action).toBe("activate");
  await expect(
    f.guard.bindIntent(resolveMerchantProductLifecycleIntent("Sku", "Draft", "Active")),
  ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  await expect(commit(f)).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
});
it("requires actual scope/source provider and valid clock", async () => {
  const f = setup();
  for (const patch of [
    { authority: undefined },
    { expectedAggregateVersion: 0 },
    { expectedAggregateVersion: 2147483647 },
    { skuReference: "not-a-reference" },
  ])
    expect(() => createMerchantProductLifecycleGuard({ ...f.options, ...patch })).toThrow(
      CatalogError,
    );
  for (const field of ["tenantReference", "selectedStoreReference", "actorReference"] as const)
    expect(() =>
      createMerchantProductLifecycleGuard({
        ...f.options,
        scope: { ...f.options.scope, [field]: undefined },
      }),
    ).toThrow(CatalogError);
  await expect(
    createMerchantProductLifecycleGuard({ ...f.options, now: () => "invalid" }).holdAndRegister(),
  ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
});

it("holds a copied provided reason and its write field through COMMIT", async () => {
  const f = setup();
  const guard = createMerchantProductLifecycleGuard({
    ...f.options,
    reasonCode: "SYNTHETIC_REASON",
  });
  await guard.holdAndRegister();
  await guard.bindIntent(resolveMerchantProductLifecycleIntent("Sku", "Draft", "Active"));
  await commit(f);
  for (const [, input] of f.authority.mock.calls) {
    expect(input.reasonCode).toBe("SYNTHETIC_REASON");
    expect(input.requiredWriteFields).toContain("reasonCode");
  }
});
