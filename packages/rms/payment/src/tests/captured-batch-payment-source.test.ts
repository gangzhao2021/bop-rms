import { expect, it, vi } from "vitest";
import { createPostgresCapturedBatchPaymentSource } from "../infrastructure/persistence/captured-batch-payment-source.js";
const id = (n: number) => "01909966-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const scope = {
  brandReference: id(1),
  storeReference: id(2),
  providerAccountReference: id(3),
  environment: "Test" as const,
};
const input = {
  orderReference: id(4),
  orderBatchReference: id(5),
  observedAt: "2026-09-14T00:00:00.000Z",
};
it("returns no capture only after authorization and account-scoped lookup", async () => {
  const query = vi.fn().mockResolvedValue({ rows: [] });
  const authorize = vi.fn().mockResolvedValue(true);
  expect(
    await createPostgresCapturedBatchPaymentSource({ scope, authorize }).load({ query }, input),
  ).toBeNull();
  expect(query.mock.calls[1]?.[1]).toEqual([
    scope.brandReference,
    scope.storeReference,
    input.orderReference,
    input.orderBatchReference,
    scope.providerAccountReference,
    "Test",
    input.observedAt,
  ]);
  expect(authorize).toHaveBeenCalledTimes(2);
});
it("rejects denied access before any database read", async () => {
  const query = vi.fn();
  await expect(
    createPostgresCapturedBatchPaymentSource({ scope, authorize: async () => false }).load(
      { query },
      input,
    ),
  ).rejects.toThrow("CAPTURED_BATCH_PAYMENT_UNAVAILABLE");
  expect(query).not.toHaveBeenCalled();
});
it("does not expose even absence after authorization is revoked", async () => {
  let calls = 0;
  await expect(
    createPostgresCapturedBatchPaymentSource({ scope, authorize: async () => ++calls === 1 }).load(
      { query: async () => ({ rows: [] }) },
      input,
    ),
  ).rejects.toThrow("CAPTURED_BATCH_PAYMENT_UNAVAILABLE");
});
it("rejects ambiguous successful batch payments instead of picking one", async () => {
  let calls = 0;
  await expect(
    createPostgresCapturedBatchPaymentSource({ scope, authorize: async () => true }).load(
      { query: async () => ({ rows: ++calls === 1 ? [] : [{}, {}] }) },
      input,
    ),
  ).rejects.toThrow("CAPTURED_BATCH_PAYMENT_UNAVAILABLE");
});
it("sanitizes database failures", async () => {
  await expect(
    createPostgresCapturedBatchPaymentSource({ scope, authorize: async () => true }).load(
      {
        query: async () => {
          throw new Error("synthetic-sensitive-detail");
        },
      },
      input,
    ),
  ).rejects.toThrow(/^CAPTURED_BATCH_PAYMENT_UNAVAILABLE$/);
});
