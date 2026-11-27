import { expect, it, vi } from "vitest";
import { createPostgresOrderBatchIdentitySource } from "../infrastructure/persistence/order-batch-identity-source.js";
const id = (n: number) => "01909965-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const scope = { brandReference: id(1), storeReference: id(2) };
const input = {
  orderReference: id(3),
  orderBatchReference: id(4),
  observedAt: "2026-09-14T00:00:00.000Z",
};
it.each(["Initial", "Additional"])(
  "reads persisted %s identity with scoped order and batch",
  async (kind) => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({
        rows: [{ submission_id: id(5), submission_kind: kind, order_type: "DineIn" }],
        rowCount: 1,
      });
    const result = await createPostgresOrderBatchIdentitySource({
      ...scope,
      authorize: async () => true,
    }).load({ query }, input);
    expect(result).toMatchObject({ ...scope, ...input, kind, submissionReference: id(5) });
    expect(query.mock.calls[1]?.[1]).toEqual([
      scope.brandReference,
      scope.storeReference,
      input.orderReference,
      input.orderBatchReference,
      input.observedAt,
    ]);
  },
);
it("denies before SQL when authorization fails", async () => {
  const query = vi.fn();
  await expect(
    createPostgresOrderBatchIdentitySource({ ...scope, authorize: async () => false }).load(
      { query },
      input,
    ),
  ).rejects.toThrow("ORDER_BATCH_IDENTITY_UNAVAILABLE");
  expect(query).not.toHaveBeenCalled();
});
it("rejects revoked authorization after lookup", async () => {
  let calls = 0;
  const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
  await expect(
    createPostgresOrderBatchIdentitySource({ ...scope, authorize: async () => ++calls === 1 }).load(
      { query },
      input,
    ),
  ).rejects.toThrow("ORDER_BATCH_IDENTITY_UNAVAILABLE");
});
it("rejects Additional identity on Pickup", async () => {
  const query = vi
    .fn()
    .mockResolvedValueOnce({ rows: [], rowCount: 0 })
    .mockResolvedValueOnce({
      rows: [{ submission_id: id(5), submission_kind: "Additional", order_type: "Pickup" }],
      rowCount: 1,
    });
  await expect(
    createPostgresOrderBatchIdentitySource({ ...scope, authorize: async () => true }).load(
      { query },
      input,
    ),
  ).rejects.toThrow("ORDER_BATCH_IDENTITY_UNAVAILABLE");
});
