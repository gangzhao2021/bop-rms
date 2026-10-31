import { expect, it } from "vitest";
import { servedStoreFor, servedStoresOf } from "./pilot-served-stores.mjs";

const ref = (n) => "018f4f8a-9c2d-7a11-8d01-" + String(n).padStart(12, "0");
const resources = (others) => ({
  publicProfile: { binding: { tenantReference: ref(1) } },
  scope: { brandReference: ref(2), storeReference: ref(3) },
  ...(others === undefined ? {} : { servedStoreReferences: others }),
});

it("DEC-BRAND-MULTI-STORE-ONE-INSTALLATION: one Store unless the installation lists others, its own first", () => {
  expect(servedStoresOf(resources())).toEqual([
    { tenantReference: ref(1), brandReference: ref(2), storeReference: ref(3) },
  ]);
  expect(servedStoresOf(resources([ref(4)])).map((store) => store.storeReference)).toEqual([
    ref(3),
    ref(4),
  ]);
  for (const bad of [[ref(3)], [ref(4), ref(4)], ["store-2"], "nope"])
    expect(() => servedStoresOf(resources(bad))).toThrow("INTERNAL_SERVED_STORES_INVALID");
});
it("accepts only a served Store of the installation's Tenant and Brand", () => {
  const served = resources([ref(4)]);
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
