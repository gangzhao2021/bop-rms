import { expect, it, vi } from "vitest";
import { createInternalRefundReconciliationConfiguration as configure } from "./pilot-refund-reconciliation.mjs";
const scope = {
  tenantReference: "synthetic-tenant",
  brandReference: "synthetic-brand",
  storeReference: "synthetic-store",
};
function fixture() {
  const resources = {
    publicProfile: {
      binding: { tenantReference: scope.tenantReference, validUntil: "2026-10-01T00:00:00.000Z" },
    },
    scope: { brandReference: scope.brandReference, storeReference: scope.storeReference },
    now: () => "2026-09-21T00:00:00.000Z",
  };
  const close = vi.fn(),
    lookupRefund = vi.fn(async () => "observation");
  const dependencies = {
    providerAccountReference: "synthetic-account",
    createSimulatedProvider: vi.fn(async () => ({ adapter: { lookupRefund }, close })),
    refreshOrderReceiptObservations: vi.fn(async () => 1),
  };
  return { resources, dependencies, close, lookupRefund, context: { scope } };
}
it("does not open the provider during configuration and uses supplied account", async () => {
  const f = fixture(),
    config = configure(f.resources, f.context, f.dependencies);
  expect(config.providerAccountReference).toBe("synthetic-account");
  expect(f.dependencies.createSimulatedProvider).not.toHaveBeenCalled();
  await expect(config.provider.lookupRefund({ synthetic: true })).resolves.toBe("observation");
  expect(f.lookupRefund).toHaveBeenCalledExactlyOnceWith({ synthetic: true });
  expect(f.close).toHaveBeenCalledTimes(1);
});
it("closes provider after lookup failure", async () => {
  const f = fixture();
  f.lookupRefund.mockRejectedValue(new Error("unavailable"));
  await expect(
    configure(f.resources, f.context, f.dependencies).provider.lookupRefund({}),
  ).rejects.toThrow("unavailable");
  expect(f.close).toHaveBeenCalledTimes(1);
});
it.each(["tenantReference", "brandReference", "storeReference"])(
  "rejects foreign %s before opening dependencies",
  (field) => {
    const f = fixture();
    expect(() =>
      configure(f.resources, { scope: { ...scope, [field]: "foreign" } }, f.dependencies),
    ).toThrow("INTERNAL_REFUND_RECONCILIATION_SCOPE_DENIED");
    expect(f.dependencies.createSimulatedProvider).not.toHaveBeenCalled();
    expect(f.dependencies.refreshOrderReceiptObservations).not.toHaveBeenCalled();
  },
);
