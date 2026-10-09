import { afterEach, beforeEach, expect, it, vi } from "vitest";

const doubles = vi.hoisted(() => ({ identity: vi.fn(), consume: vi.fn() }));
vi.mock("../../packages/rms/ordering/src/index.ts", () => ({
  createPostgresOrderBatchIdentitySource: () => ({ load: doubles.identity }),
}));
vi.mock("../../packages/bop/eventing/src/index.ts", () => ({
  consumeEventInTransaction: doubles.consume,
}));
vi.mock("../../packages/rms/kitchen/src/index.ts", () => ({
  parseKitchenOrderReadyEnvelope: (value) => value,
}));
const { createInternalPickupProofConsumer } = await import("./pilot-pickup-proof-consumer.mjs");

const scope = { brandReference: "brand", storeReference: "store" };
const now = "2026-10-09T12:00:00.000Z";
function setup(state) {
  const ensureIssued = vi.fn(async () => undefined);
  const consumer = createInternalPickupProofConsumer(
    {
      scope,
      now: () => now,
      publicProfile: { binding: { validUntil: "2026-10-20T00:00:00.000Z" } },
    },
    {
      createConfirmation: () => async () => ({ payload: { orderBatchReference: "batch" } }),
      createReadiness: () => ({ repository: { lockPickupHandoffByOrder: async () => state } }),
      createProof: () => ({ issuer: { ensureIssued } }),
    },
  );
  const event = {
    tenantId: "brand",
    storeId: "store",
    eventId: "event",
    correlationId: "correlation",
    payload: { orderReference: "order", orderBatchReference: "batch", readyAt: now },
  };
  return { consumer, ensureIssued, event };
}
afterEach(() => vi.unstubAllEnvs());
const ready = (overrides = {}) => ({
  source: { ...scope, fulfillmentReference: "f", canonicalPhase: "Ready" },
  capability: null,
  notCollected: false,
  ...overrides,
});
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NODE_ENV", "development");
  doubles.identity.mockResolvedValue({ orderType: "Pickup" });
});
it("WP-2423: issues a proof for a ready pickup that has none yet", async () => {
  const f = setup(ready());
  await f.consumer.registration.handler({ transaction: {}, envelope: f.event });
  expect(f.ensureIssued).toHaveBeenCalledTimes(1);
});
it("WP-2423: does not issue again once issued, nor after an in-person handoff or closure", async () => {
  for (const state of [
    ready({ capability: { fulfillmentReference: "f" } }),
    ready({ notCollected: true }),
    ready({ source: { ...scope, fulfillmentReference: "f", canonicalPhase: "Completed" } }),
  ]) {
    const f = setup(state);
    expect(await f.consumer.registration.handler({ transaction: {}, envelope: f.event })).toEqual({
      status: "completed",
    });
    expect(f.ensureIssued).not.toHaveBeenCalled();
  }
  const other = setup(ready({ source: { brandReference: "x", storeReference: "store" } }));
  await expect(
    other.consumer.registration.handler({ transaction: {}, envelope: other.event }),
  ).rejects.toThrow("INTERNAL_PICKUP_PROOF_SOURCE_CONFLICT");
});
