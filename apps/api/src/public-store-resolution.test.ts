import { expect, it, vi } from "vitest";
import { createConfiguredPublicStoreResolution } from "./public-store-resolution.js";
const id = (n: number) => "01909981-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-01-15T12:00:00.000Z";
const original = {
  tenantReference: id(1),
  publicStoreReference: id(2),
  brandReference: id(3),
  storeReference: id(4),
  lookupEvidenceReference: id(5),
  validFrom: "2026-01-01T00:00:00.000Z",
  validUntil: "2026-02-01T00:00:00.000Z",
};
function setup() {
  const binding = { ...original };
  const brand = {
    brand_id: id(3),
    code: "DEMO",
    display_name: "Demonstration",
    default_locale: "en-CA",
    currency_code: "CAD",
    lifecycle: "Active",
    version: 1,
    created_at: new Date(original.validFrom),
    updated_at: new Date(original.validFrom),
  };
  const store = {
    store_id: id(4),
    brand_id: id(3),
    code: "DEMO",
    display_name: "Demonstration",
    locale: "en-CA",
    currency_code: "CAD",
    time_zone: "America/Toronto",
    lifecycle: "Active",
    version: 1,
    created_at: new Date(original.validFrom),
    updated_at: new Date(original.validFrom),
  };
  const query = vi.fn(async (sql: string, values: readonly unknown[]) => {
    void values;
    return {
      rows: sql.includes("FROM bop_tenant.brand")
        ? [brand]
        : sql.includes("FROM bop_tenant.store")
          ? [store]
          : [],
    };
  });
  const transaction = { query };
  const authorize = vi.fn(async () => true);
  const service = createConfiguredPublicStoreResolution({ transaction, binding, authorize });
  const request = {
    publicStoreReference: id(2),
    evaluatedAt: at,
    purpose: "CustomerEntry",
  } as Parameters<typeof service.resolve>[0];
  return { binding, brand, store, transaction, query, authorize, service, request };
}
it("resolves current Tenant owner facts in the retained transaction and immutable configured scope", async () => {
  const x = setup();
  x.binding.storeReference = id(99);
  expect(await x.service.resolve(x.request)).toEqual({
    publicStoreReference: id(2),
    brandReference: id(3),
    storeReference: id(4),
    lookupEvidenceReference: id(5),
    validUntil: original.validUntil,
    brandLifecycle: "Active",
    storeLifecycle: "Active",
  });
  expect(x.authorize).toHaveBeenCalledTimes(2);
  expect(x.authorize).toHaveBeenLastCalledWith(x.transaction, original, {
    evaluatedAt: at,
    purpose: "CustomerEntry",
  });
  expect(x.query).toHaveBeenCalledWith(
    "SELECT * FROM bop_tenant.store WHERE brand_id=$1 AND store_id=$2 FOR SHARE",
    [id(3), id(4)],
  );
  expect(await x.service.resolve({ ...x.request, purpose: "CustomerCart" })).not.toBeNull();
});
it("rejects unknown, out-of-window or extended browser input before owner reads", async () => {
  const x = setup();
  for (const change of [
    { publicStoreReference: id(99) },
    { evaluatedAt: "2025-12-31T23:59:59.999Z" },
    { evaluatedAt: original.validUntil },
    { purpose: "Merchant" },
    { storeReference: id(99) },
    { requestedLocale: "fr-CA" },
  ])
    expect(await x.service.resolve({ ...x.request, ...change } as typeof x.request)).toBeNull();
  expect(x.authorize).not.toHaveBeenCalled();
  expect(x.query).not.toHaveBeenCalled();
  const getter = { ...x.request };
  Object.defineProperty(getter, "purpose", {
    get: () => {
      throw new Error("not invoked");
    },
  });
  expect(await x.service.resolve(getter)).toBeNull();
});
it("denies inactive/future organization facts, unavailable sources and withdrawn authorization", async () => {
  for (const lifecycle of ["Draft", "Suspended", "Archived"]) {
    const x = setup();
    x.brand.lifecycle = lifecycle;
    expect(await x.service.resolve(x.request)).toBeNull();
    x.brand.lifecycle = "Active";
    x.store.lifecycle = lifecycle;
    expect(await x.service.resolve(x.request)).toBeNull();
  }
  const future = setup();
  future.store.updated_at = new Date(original.validUntil);
  expect(await future.service.resolve(future.request)).toBeNull();
  const denied = setup();
  denied.authorize.mockResolvedValue(false);
  expect(await denied.service.resolve(denied.request)).toBeNull();
  expect(denied.query).not.toHaveBeenCalled();
  const withdrawn = setup();
  withdrawn.authorize.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  expect(await withdrawn.service.resolve(withdrawn.request)).toBeNull();
  const unavailable = setup();
  unavailable.query.mockRejectedValue(new Error("private database detail"));
  expect(await unavailable.service.resolve(unavailable.request)).toBeNull();
});
