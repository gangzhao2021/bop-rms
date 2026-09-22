import { beforeEach, expect, it, vi } from "vitest";
import { createCustomerDiningCartInventoryAuthorization } from "./customer-dining-cart-inventory-authorization.js";
const f = vi.hoisted(() => ({ load: vi.fn(), scopes: [] as unknown[] }));
vi.mock("@rms/ordering", async (original) => ({
  ...(await original<typeof import("@rms/ordering")>()),
  createPostgresDiningCartCommandQueryStore: (_runner: unknown, scope: unknown) => {
    f.scopes.push(scope);
    return { load: f.load };
  },
}));
const id = (n: number) => ("01902408-0000-7000-8000-" + n.toString(16).padStart(12, "0")) as never;
const at = "2026-09-19T09:00:00.000Z";
const scope = { brandReference: id(1), storeReference: id(2) };
const context = {
  cartReference: id(3),
  cartVersion: 2,
  guestSessionReference: id(4),
  diningSessionReference: id(5),
  quantity: 2,
};
const input = {
  sellableReference: id(6),
  productVersionReference: id(7),
  quantity: 2,
  selections: [],
  observedAt: at,
};
const cart = {
  ...scope,
  cartReference: id(3),
  aggregateVersion: 2,
  createdByActorReference: id(99),
  orderType: "DineIn",
  diningSessionReference: id(5),
  sourceChannel: "Qr",
  updatedAt: at,
  lifecycle: {
    status: "Active",
    policyVersionReference: id(8),
    policyDigest: "sha256:" + "a".repeat(64),
    idleTimeoutSeconds: 3600,
    absoluteTimeoutSeconds: 86400,
    idleExpiresAt: "2026-09-19T10:00:00.000Z",
    absoluteExpiresAt: "2026-09-20T09:00:00.000Z",
    terminalAt: null,
    terminalReason: null,
  },
};
beforeEach(() => {
  vi.resetAllMocks();
  f.scopes.length = 0;
  f.load.mockResolvedValue(cart);
});
const tx = { query: vi.fn() };
it("uses the authorized shared Dining session, not the Cart creator", async () => {
  expect(
    await createCustomerDiningCartInventoryAuthorization(scope, () => at)(tx, input, context),
  ).toBe(true);
  expect(f.scopes).toEqual([{ ...scope, diningSessionReference: id(5) }]);
});
it.each([
  { diningSessionReference: id(10) },
  { aggregateVersion: 3 },
  { orderType: "Pickup" },
  { lifecycle: { ...cart.lifecycle, idleExpiresAt: at } },
])("denies mismatched or inactive Cart %o", async (patch) => {
  f.load.mockResolvedValue({ ...cart, ...patch });
  expect(
    await createCustomerDiningCartInventoryAuthorization(scope, () => at)(tx, input, context),
  ).toBe(false);
});
it("does not infer a Dining session when it is missing", async () => {
  expect(
    await createCustomerDiningCartInventoryAuthorization(scope, () => at)(tx, input, {
      ...context,
      diningSessionReference: null,
    }),
  ).toBe(false);
  expect(f.load).not.toHaveBeenCalled();
});
