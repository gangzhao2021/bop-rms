import { expect, it, vi } from "vitest";
import { CatalogError } from "@rms/catalog";
import {
  createMerchantProductWriteGuard,
  MerchantProductWriteFeatureDisabled,
  productCreateWriteFields,
  productDraftWriteFields,
  productCreateResultFields,
  productDraftResultFields,
  type MerchantProductWriteAuthority,
} from "./merchant-product-write-authority.js";
const id = (n: number) => "01902409-0000-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-09-28T12:00:00.000Z";
type Options = Parameters<typeof createMerchantProductWriteGuard>[0];
function setup(action: "Create" | "ReplaceDraft" = "Create") {
  const checks: (() => Promise<void>)[] = [],
    tx = { query: vi.fn() },
    authorize = vi.fn(async (requested: string) => ({
      effect: "Allow",
      scopeKind: "Brand",
      action: requested,
    })),
    authority = vi.fn<MerchantProductWriteAuthority>(async () => "Allowed");
  // Scope is a synthetic current resolver result; real IAM/SQL composition is separately tested.
  const scope = {
    tenantReference: id(1),
    context: { brand: { brandReference: id(2) } },
    selectedStoreReference: id(3),
    actorReference: id(4),
    authorizeAction: authorize,
  } as unknown as Options["scope"];
  const register = vi.fn(async (actual: Options["transaction"], check: () => Promise<void>) => {
    expect(actual).toBe(tx);
    checks.push(check);
  });
  const options: Options = {
    transaction: tx,
    scope,
    sessionReference: id(5),
    productReference: id(6),
    operationReference: id(7),
    intent:
      action === "Create"
        ? { action, expectedAggregateVersion: null, createsSkus: true }
        : { action, expectedAggregateVersion: 4 },
    authority,
    now: () => at,
    registerBeforeCommit: register,
  };
  return {
    options,
    guard: createMerchantProductWriteGuard(options),
    checks,
    authority,
    authorize,
    register,
    tx,
  };
}
it.each(["Create", "ReplaceDraft"] as const)(
  "holds exact %s parent/target and all independent permissions through COMMIT",
  async (action) => {
    const f = setup(action);
    if (action === "ReplaceDraft")
      await f.guard.bindSkuDraftIntent({ createdSkuReferences: [], updatedSkuReferences: [] });
    await f.guard.holdAndRegister();
    expect(f.register).toHaveBeenCalledTimes(1);
    const check = f.checks[0];
    if (!check) throw new Error("Missing synthetic commit check");
    await check();
    expect(f.authority).toHaveBeenCalledTimes(2);
    expect(f.authorize.mock.calls.map((x) => x[0])).toEqual([
      "catalog.manage",
      "catalog.product.manage",
      action === "Create" ? "catalog.product.create" : "catalog.product.update",
      ...(action === "Create" ? ["catalog.sku.create"] : []),
      "catalog.manage",
      "catalog.product.manage",
      action === "Create" ? "catalog.product.create" : "catalog.product.update",
      ...(action === "Create" ? ["catalog.sku.create"] : []),
    ]);
    const call = f.authority.mock.calls[0];
    if (!call) throw new Error("Missing synthetic authority call");
    expect(call[0]).toBe(f.tx);
    expect(call[1]).toEqual({
      tenantReference: id(1),
      brandReference: id(2),
      storeReference: id(3),
      actorReference: id(4),
      sessionReference: id(5),
      productReference: id(6),
      operationReference: id(7),
      permission: "catalog.manage",
      owningAction: "catalog.product.manage",
      phase: "phase_1",
      observedAt: at,
      action,
      actionPermission: action === "Create" ? "catalog.product.create" : "catalog.product.update",
      ...(action === "Create"
        ? { skuCreationPermission: "catalog.sku.create" }
        : { skuDraftIntent: { createdSkuReferences: [], updatedSkuReferences: [] } }),
      screenId: action === "Create" ? "CAT-PRODUCT-CREATE" : "CAT-PRODUCT-EDIT",
      capability: action === "Create" ? "catalog.cat_product_create" : "catalog.cat_product_edit",
      purposeCode: action === "Create" ? "CATALOG_PRODUCT_CREATE" : "CATALOG_PRODUCT_DRAFT_REPLACE",
      expectedAggregateVersion: action === "Create" ? null : 4,
      requiredWriteFields: action === "Create" ? productCreateWriteFields : productDraftWriteFields,
      requiredReadFields:
        action === "Create" ? productCreateResultFields : productDraftResultFields,
    });
    expect(Object.isFrozen(call[1])).toBe(true);
  },
);
it.each(["catalog.manage", "catalog.product.manage"])(
  "independently denies %s",
  async (required) => {
    const f = setup();
    f.authorize.mockImplementation(async (action) => ({
      action,
      effect: action === required ? "Deny" : "Allow",
      scopeKind: "Brand",
    }));
    await expect(f.guard.holdAndRegister()).rejects.toMatchObject({
      code: "CATALOG_PERMISSION_DENIED",
    });
    expect(f.authority).not.toHaveBeenCalled();
    expect(f.register).not.toHaveBeenCalled();
  },
);
it("rejects Store grant for required Brand action", async () => {
  const f = setup();
  f.authorize.mockResolvedValue({ effect: "Allow", scopeKind: "Store", action: "catalog.manage" });
  await expect(f.guard.hold()).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
});
it.each(["fields", "permission", "phase"])("denies %s at COMMIT", async (kind) => {
  const f = setup("ReplaceDraft");
  await f.guard.bindSkuDraftIntent({ createdSkuReferences: [], updatedSkuReferences: [] });
  await f.guard.holdAndRegister();
  if (kind === "fields")
    f.authority.mockRejectedValue(new CatalogError("CATALOG_PERMISSION_DENIED"));
  if (kind === "permission")
    f.authorize.mockResolvedValue({ effect: "Deny", scopeKind: "Brand", action: "catalog.manage" });
  if (kind === "phase") f.authority.mockResolvedValue("FeatureDisabled");
  const check = f.checks[0];
  if (!check) throw new Error("Missing check");
  await expect(check()).rejects.toMatchObject(
    kind === "phase"
      ? { name: "MerchantProductWriteFeatureDisabled" }
      : { code: "CATALOG_PERMISSION_DENIED" },
  );
});
it("does not treat missing or void holder as permission", async () => {
  const f = setup();
  expect(() => createMerchantProductWriteGuard({ ...f.options, authority: undefined })).toThrow(
    expect.objectContaining({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" }),
  );
  f.authority.mockResolvedValue(undefined as unknown as "Allowed");
  await expect(f.guard.hold()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
});
it("returns explicit feature disabled before registration", async () => {
  const f = setup();
  f.authority.mockResolvedValue("FeatureDisabled");
  await expect(f.guard.holdAndRegister()).rejects.toBeInstanceOf(
    MerchantProductWriteFeatureDisabled,
  );
  expect(f.register).not.toHaveBeenCalled();
});
it.each([0, -1, 2147483647, 2147483648, 1.5])("bounds version %s", (version) => {
  const f = setup("ReplaceDraft");
  expect(() =>
    createMerchantProductWriteGuard({
      ...f.options,
      intent: { action: "ReplaceDraft", expectedAggregateVersion: version },
    }),
  ).toThrow();
});
it("captures immutable identity, intent and holder without following later reconfiguration", async () => {
  const f = setup("ReplaceDraft");
  Object.assign(f.options, {
    intent: { action: "ReplaceDraft", expectedAggregateVersion: 99 },
    authority: async () => "FeatureDisabled",
  });
  await f.guard.hold();
  expect(f.authority.mock.calls[0]?.[1].expectedAggregateVersion).toBe(4);
});
it("rejects invalid trusted clock rather than echo provider error", async () => {
  const f = setup();
  Object.assign(f.options, { now: () => "invalid" });
  await expect(f.guard.hold()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(f.authority).not.toHaveBeenCalled();
});

it.each(["Create", "ReplaceDraft"] as const)(
  "does not inherit %s intent from manage or the other action",
  async (intent) => {
    const f = setup(intent);
    const required = intent === "Create" ? "catalog.product.create" : "catalog.product.update";
    f.authorize.mockImplementation(async (action) => ({
      action,
      scopeKind: "Brand",
      effect: action === required ? "Deny" : "Allow",
    }));
    await expect(f.guard.holdAndRegister()).rejects.toMatchObject({
      code: "CATALOG_PERMISSION_DENIED",
    });
    expect(f.authority).not.toHaveBeenCalled();
    expect(f.register).not.toHaveBeenCalled();
  },
);
it.each(["Create", "ReplaceDraft"] as const)(
  "rechecks exact %s intent before outer COMMIT",
  async (intent) => {
    const f = setup(intent);
    if (intent === "ReplaceDraft")
      await f.guard.bindSkuDraftIntent({ createdSkuReferences: [], updatedSkuReferences: [] });
    await f.guard.holdAndRegister();
    const required = intent === "Create" ? "catalog.product.create" : "catalog.product.update";
    f.authorize.mockImplementation(async (action) => ({
      action,
      scopeKind: "Brand",
      effect: action === required ? "Deny" : "Allow",
    }));
    const check = f.checks[0];
    if (!check) throw new Error("Missing commit check");
    await expect(check()).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
    expect(f.authority).toHaveBeenCalledTimes(1);
  },
);
it.each(["Store", "wrong-action"])(
  "rejects %s evidence for canonical mutation permission",
  async (kind) => {
    const f = setup("ReplaceDraft");
    f.authorize.mockImplementation(async (action) => ({
      action:
        action === "catalog.product.update" && kind === "wrong-action"
          ? "catalog.product.create"
          : action,
      effect: "Allow",
      scopeKind: action === "catalog.product.update" && kind === "Store" ? "Store" : "Brand",
    }));
    await expect(f.guard.hold()).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
    expect(f.authority).not.toHaveBeenCalled();
  },
);

it.each(["Deny", "Store", "wrong-action"])(
  "requires independent exact Brand SKU creation, %s",
  async (kind) => {
    const f = setup();
    f.authorize.mockImplementation(async (action) => ({
      action:
        action === "catalog.sku.create" && kind === "wrong-action"
          ? "catalog.product.create"
          : action,
      effect: action === "catalog.sku.create" && kind === "Deny" ? "Deny" : "Allow",
      scopeKind: action === "catalog.sku.create" && kind === "Store" ? "Store" : "Brand",
    }));
    await expect(f.guard.holdAndRegister()).rejects.toMatchObject({
      code: "CATALOG_PERMISSION_DENIED",
    });
    expect(f.authority).not.toHaveBeenCalled();
    expect(f.register).not.toHaveBeenCalled();
  },
);
it("rechecks nested SKU creation before COMMIT", async () => {
  const f = setup();
  await f.guard.holdAndRegister();
  f.authorize.mockImplementation(async (action) => ({
    action,
    scopeKind: "Brand",
    effect: action === "catalog.sku.create" ? "Deny" : "Allow",
  }));
  await expect(f.checks[0]?.()).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
  expect(f.authority).toHaveBeenCalledTimes(1);
});
it("captures SKU target and does not require SKU creation for an empty Product Draft", async () => {
  const f = setup();
  const intent = { action: "Create", expectedAggregateVersion: null, createsSkus: false } as const;
  const guard = createMerchantProductWriteGuard({ ...f.options, intent });
  Object.assign(intent, { createsSkus: true });
  f.authorize.mockImplementation(async (action) => ({
    action,
    scopeKind: "Brand",
    effect: action === "catalog.sku.create" ? "Deny" : "Allow",
  }));
  await guard.holdAndRegister();
  await f.checks[0]?.();
  expect(f.authorize.mock.calls.some(([action]) => action === "catalog.sku.create")).toBe(false);
  expect(f.authority.mock.calls[0]?.[1]).toMatchObject({ skuCreationPermission: null });
});

it("unbound Draft SKU intent cannot COMMIT", async () => {
  const f = setup("ReplaceDraft");
  await f.guard.holdAndRegister();
  await expect(f.checks[0]?.()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
});
it.each(["catalog.sku.create", "catalog.sku.update"])(
  "Draft independently holds %s before writing and COMMIT",
  async (required) => {
    const f = setup("ReplaceDraft");
    await f.guard.holdAndRegister();
    await f.guard.bindSkuDraftIntent({
      createdSkuReferences: [id(8)],
      updatedSkuReferences: [id(9)],
    });
    f.authorize.mockImplementation(async (action) => ({
      action,
      scopeKind: "Brand",
      effect: action === required ? "Deny" : "Allow",
    }));
    await expect(f.checks[0]?.()).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
    expect(f.authority).toHaveBeenCalledTimes(1);
  },
);
it.each(["Deny", "Store", "wrong-action"])(
  "Draft SKU binding rejects %s permission",
  async (kind) => {
    const f = setup("ReplaceDraft");
    f.authorize.mockImplementation(async (action) => ({
      action:
        action === "catalog.sku.update" && kind === "wrong-action"
          ? "catalog.product.update"
          : action,
      scopeKind: action === "catalog.sku.update" && kind === "Store" ? "Store" : "Brand",
      effect: action === "catalog.sku.update" && kind === "Deny" ? "Deny" : "Allow",
    }));
    await expect(
      f.guard.bindSkuDraftIntent({ createdSkuReferences: [], updatedSkuReferences: [id(9)] }),
    ).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
    await expect(
      f.guard.bindSkuDraftIntent({ createdSkuReferences: [], updatedSkuReferences: [] }),
    ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
    await expect(f.guard.hold()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  },
);
it("captures immutable SKU IDs and exposes them to COMMIT holder", async () => {
  const f = setup("ReplaceDraft");
  const intent = { createdSkuReferences: [id(8)], updatedSkuReferences: [id(9)] };
  await f.guard.holdAndRegister();
  await f.guard.bindSkuDraftIntent(intent);
  intent.createdSkuReferences.length = 0;
  intent.updatedSkuReferences.length = 0;
  await f.checks[0]?.();
  const input = f.authority.mock.calls[1]?.[1];
  expect(input).toMatchObject({
    skuDraftIntent: { createdSkuReferences: [id(8)], updatedSkuReferences: [id(9)] },
  });
  if (!input || input.action !== "ReplaceDraft") throw new Error("Missing Draft holder");
  expect(Object.isFrozen(input.skuDraftIntent)).toBe(true);
  expect(Object.isFrozen(input.skuDraftIntent?.createdSkuReferences)).toBe(true);
  await expect(
    f.guard.bindSkuDraftIntent({ createdSkuReferences: [], updatedSkuReferences: [] }),
  ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  await expect(f.checks[0]?.()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
});
