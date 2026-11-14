import { beforeEach, expect, it, vi } from "vitest";
import { createCustomerPickupCartInventoryAuthorization } from "./customer-pickup-cart-inventory-authorization.js";
const f = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("@rms/ordering", async (original) => ({
  ...(await original<typeof import("@rms/ordering")>()),
  createPostgresCartQueryStore: () => ({ load: f.load }),
}));
const id = (n: number) => ("01902408-0000-7000-8000-" + n.toString(16).padStart(12, "0")) as never;
const at = "2026-09-19T09:00:00.000Z";
const scope = { brandReference: id(1), storeReference: id(2) };
const context = {
  cartReference: id(3),
  cartVersion: 2,
  guestSessionReference: id(4),
  diningSessionReference: null,
  quantity: 5,
};
const input = {
  sellableReference: id(6),
  productVersionReference: id(7),
  quantity: 5,
  selections: [],
  observedAt: at,
};
const cart = {
  ...scope,
  cartReference: id(3),
  aggregateVersion: 2,
  createdByActorReference: id(4),
  orderType: "Pickup",
  diningSessionReference: null,
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
const tx = { query: vi.fn() };
beforeEach(() => {
  vi.resetAllMocks();
  f.load.mockResolvedValue(cart);
});
it("allows the command's quantity and a smaller stock probe, never a larger or empty one", async () => {
  const authorize = createCustomerPickupCartInventoryAuthorization(scope, () => at);
  expect(await authorize(tx, input, context)).toBe(true);
  expect(await authorize(tx, { ...input, quantity: 2 }, context)).toBe(true);
  expect(await authorize(tx, { ...input, quantity: 6 }, context)).toBe(false);
  expect(await authorize(tx, { ...input, quantity: 0 }, context)).toBe(false);
});
it("denies another guest's or a changed Cart", async () => {
  const authorize = createCustomerPickupCartInventoryAuthorization(scope, () => at);
  f.load.mockResolvedValue({ ...cart, createdByActorReference: id(9) });
  expect(await authorize(tx, input, context)).toBe(false);
  f.load.mockResolvedValue({ ...cart, aggregateVersion: 3 });
  expect(await authorize(tx, input, context)).toBe(false);
});
