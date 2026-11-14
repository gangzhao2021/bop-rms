import { expect, it, vi } from "vitest";
import type { ConsumerTransaction } from "@bop/eventing";
import { createPostgresMerchantOrderItemLabels } from "../infrastructure/persistence/merchant-order-item-labels.js";
const id = (n: number) => "01909968-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const row = {
  order_item_id: id(4),
  order_batch_id: id(5),
  ordinal: 1,
  display_name: "DEMO meal",
  submission_kind: "Initial",
  batch_sequence: null,
};
function setup(rows: unknown[]) {
  const query = vi.fn(async (sql: string) => ({
    rows: sql.startsWith("SELECT i.") ? rows : [],
    rowCount: rows.length,
  }));
  const authorize = vi.fn(async () => true);
  return {
    query,
    authorize,
    tx: { query } as unknown as ConsumerTransaction,
    reader: createPostgresMerchantOrderItemLabels({
      brandReference: id(1),
      storeReference: id(2),
      locale: "en",
      authorize,
    }),
  };
}
it("returns immutable names and batch ordinals without private snapshot content", async () => {
  const f = setup([
    {
      ...row,
      order_item_id: id(6),
      order_batch_id: id(7),
      submission_kind: "Additional",
      batch_sequence: 2,
    },
    row,
  ]);
  const result = await f.reader.load({ transaction: f.tx, orderReference: id(3) });
  expect(result.map((item) => item.batchSequence)).toEqual([1, 2]);
  expect(result[0]).toEqual({
    orderItemReference: id(4),
    orderBatchReference: id(5),
    batchSequence: 1,
    itemOrdinal: 1,
    displayName: "DEMO meal",
  });
  expect(f.query.mock.calls[1]?.[0]).toContain("i.brand_id=$1 AND i.store_id=$2 AND i.order_id=$3");
});
it.each([
  { display_name: null },
  { display_name: "x\nsecret" },
  { batch_sequence: 2 },
  { ordinal: 0 },
  { submission_kind: "Additional", batch_sequence: 1 },
])("rejects invalid display source %j", async (change) => {
  const f = setup([{ ...row, ...change }]);
  await expect(f.reader.load({ transaction: f.tx, orderReference: id(3) })).rejects.toThrow();
});
it("rejects duplicate item membership", async () => {
  const f = setup([row, row]);
  await expect(f.reader.load({ transaction: f.tx, orderReference: id(3) })).rejects.toThrow();
});
it("checks access before SQL and after reading", async () => {
  const f = setup([row]);
  f.authorize.mockResolvedValue(false);
  await expect(f.reader.load({ transaction: f.tx, orderReference: id(3) })).rejects.toThrow();
  expect(f.query).not.toHaveBeenCalled();
  f.authorize.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  await expect(f.reader.load({ transaction: f.tx, orderReference: id(3) })).rejects.toThrow();
});
