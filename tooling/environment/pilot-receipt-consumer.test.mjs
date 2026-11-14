import { beforeEach, expect, it, vi } from "vitest";

// WP-2423 D2: which card-machine payments start a digital receipt. Owner reads are stand-ins.
const state = vi.hoisted(() => ({ card: null, identity: null }));
vi.mock("../../packages/rms/payment/src/index.ts", () => ({
  parsePaymentSucceededEnvelope: (value) => value,
  createPostgresCardMachinePaymentStore: () => ({ loadByIntent: async () => state.card }),
}));
vi.mock("../../packages/rms/ordering/src/index.ts", () => ({
  createPostgresOrderBatchIdentitySource: () => ({ load: async () => state.identity }),
}));
vi.mock("../../packages/bop/eventing/src/index.ts", () => ({
  consumeEventInTransaction: async () => ({ status: "processed" }),
}));
const { createInternalReceiptConsumer } = await import("./pilot-receipt-consumer.mjs");

const scope = { brandReference: "brand", storeReference: "store" };
const event = {
  tenantId: "brand",
  storeId: "store",
  occurredAt: "2026-10-15T15:00:00.000Z",
  payload: { orderReference: "order", paymentIntentReference: "intent" },
};
const issued = [];
const consumer = () =>
  createInternalReceiptConsumer(
    {
      scope,
      now: () => "2026-10-15T15:00:01.000Z",
      publicProfile: { binding: { validUntil: "2099-01-01T00:00:00.000Z" } },
    },
    {
      createReceipt: async () => ({
        issueOriginal: async (request) => {
          issued.push(request.orderReference);
        },
      }),
    },
  ).registration.handler({ transaction: {}, envelope: event });

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "development");
  issued.length = 0;
  state.card = { orderReference: "order", orderBatchReference: "batch" };
});

it("issues the table's receipt for a dine-in first round paid on the card machine", async () => {
  state.identity = { kind: "Initial", orderType: "DineIn" };
  await expect(consumer()).resolves.toEqual({ status: "completed" });
  expect(issued).toEqual(["order"]);
});

it("leaves counter pickups (machine slip) and later rounds (additional receipt) alone", async () => {
  for (const identity of [
    { kind: "Initial", orderType: "Pickup" },
    { kind: "Additional", orderType: "DineIn" },
  ]) {
    state.identity = identity;
    await expect(consumer()).resolves.toEqual({ status: "completed" });
  }
  expect(issued).toEqual([]);
  state.identity = null;
  await expect(consumer()).rejects.toThrow("INTERNAL_RECEIPT_BATCH_UNAVAILABLE");
});

it("issues as before for an online payment", async () => {
  state.card = null;
  await consumer();
  expect(issued).toEqual(["order"]);
});
