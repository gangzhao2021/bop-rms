import { expect, it } from "vitest";
import { servedStoreFor, servedStoresOf } from "./pilot-served-stores.mjs";

const ref = (n) => "018f4f8a-9c2d-7a11-8d01-" + String(n).padStart(12, "0");
const scopeOf = (store, tenant = 1, brand = 2) => ({
  tenantReference: ref(tenant),
  brandReference: ref(brand),
  storeReference: ref(store),
});
const resources = (others) => ({
  publicProfile: { binding: { tenantReference: ref(1) } },
  scope: { brandReference: ref(2), storeReference: ref(3) },
  ...(others === undefined ? {} : { servedStores: others }),
});

it("DEC-BRAND-MULTI-STORE-ONE-INSTALLATION: one Store unless the installation lists others, its own first", () => {
  expect(servedStoresOf(resources())).toEqual([
    { tenantReference: ref(1), brandReference: ref(2), storeReference: ref(3) },
  ]);
  expect(servedStoresOf(resources([scopeOf(4)])).map((store) => store.storeReference)).toEqual([
    ref(3),
    ref(4),
  ]);
  for (const bad of [
    [scopeOf(3)],
    [scopeOf(4), scopeOf(4)],
    [ref(4)],
    [{ ...scopeOf(4), tenantReference: undefined }],
    "nope",
  ])
    expect(() => servedStoresOf(resources(bad))).toThrow("INTERNAL_SERVED_STORES_INVALID");
});
it("accepts only a served Store with its own Tenant and Brand", () => {
  const served = resources([scopeOf(4)]);
  const selection = (overrides) => ({
    tenantReference: ref(1),
    brandReference: ref(2),
    storeReference: ref(4),
    ...overrides,
  });
  expect(servedStoreFor(served, selection({}))?.storeReference).toBe(ref(4));
  expect(servedStoreFor(served, selection({ storeReference: ref(5) }))).toBeNull();
  expect(servedStoreFor(served, selection({ brandReference: ref(9) }))).toBeNull();
  expect(servedStoreFor(served, selection({ tenantReference: ref(9) }))).toBeNull();
  expect(servedStoreFor(served, null)).toBeNull();
  // A single-Store installation never accepts the other Store.
  expect(servedStoreFor(resources(), selection({}))).toBeNull();
});
it("DEC-MULTI-MERCHANT-ONE-INSTALLATION: each Store keeps its own Tenant and Brand", () => {
  const served = resources([scopeOf(4, 7, 8)]);
  expect(servedStoresOf(served)).toEqual([scopeOf(3), scopeOf(4, 7, 8)]);
  expect(servedStoreFor(served, scopeOf(4, 7, 8))?.storeReference).toBe(ref(4));
  // Another merchant's Tenant or Brand on a served Store is not that Store.
  expect(servedStoreFor(served, scopeOf(4))).toBeNull();
  expect(servedStoreFor(served, scopeOf(3, 7, 8))).toBeNull();
});
