import { expect, it } from "vitest";
import { resolveMerchantProductLifecycleIntent } from "./merchant-product-lifecycle-intent.js";
for (const kind of ["Product", "Sku"] as const) {
  it.each([
    ["Draft", "Archived", "archive"],
    ["Active", "Suspended", "suspend"],
    ["Suspended", "Active", "resume"],
    ["Active", "Discontinued", "discontinue"],
    ["Suspended", "Discontinued", "discontinue"],
    ["Discontinued", "Archived", "archive"],
    ["Archived", "Draft", "restore"],
  ] as const)(`${kind} %s→%s requires exact %s action`, (before, target, action) => {
    const intent = resolveMerchantProductLifecycleIntent(kind, before, target);
    expect(intent).toEqual({
      kind,
      beforeLifecycle: before,
      targetLifecycle: target,
      action,
      actionPermission: `catalog.${kind === "Product" ? "product" : "sku"}.${action}`,
    });
    expect(Object.isFrozen(intent)).toBe(true);
  });
  it.each(["Draft", "Active", "Suspended", "Discontinued", "Archived"])(
    `${kind} same-state %s is not a new authorized transition`,
    (state) => {
      expect(() => resolveMerchantProductLifecycleIntent(kind, state, state)).toThrowError(
        expect.objectContaining({ code: "CATALOG_LIFECYCLE_CONFLICT" }),
      );
    },
  );
  it(`${kind} Archived→Discontinued is not canonical Restore`, () => {
    expect(() =>
      resolveMerchantProductLifecycleIntent(kind, "Archived", "Discontinued"),
    ).toThrowError(expect.objectContaining({ code: "CATALOG_LIFECYCLE_CONFLICT" }));
  });
}
it("SKU initial activation and resume are distinct permissions", () => {
  expect(resolveMerchantProductLifecycleIntent("Sku", "Draft", "Active").actionPermission).toBe(
    "catalog.sku.activate",
  );
  expect(resolveMerchantProductLifecycleIntent("Sku", "Suspended", "Active").actionPermission).toBe(
    "catalog.sku.resume",
  );
});
it("Product Draft activation cannot bypass canonical publish through lifecycle", () => {
  expect(() => resolveMerchantProductLifecycleIntent("Product", "Draft", "Active")).toThrowError(
    expect.objectContaining({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" }),
  );
});
it.each(["invalid", null, 1])("invalid source lifecycle %s is not guessed", (before) => {
  expect(() => resolveMerchantProductLifecycleIntent("Sku", before, "Active")).toThrowError(
    expect.objectContaining({ code: "CATALOG_INPUT_INVALID" }),
  );
});
