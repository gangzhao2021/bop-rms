import type { ConsumerTransaction } from "@bop/eventing";
import { expect, it, vi } from "vitest";
import { createOrderListPointReads } from "../infrastructure/persistence/order-list-point-reads.js";
import { orderInitialPointStatements } from "../infrastructure/persistence/order-termination-store.js";

const brand = "01a1a943-3f11-73d5-97eb-2bec032b0259";
const store = "01a1a943-3f11-75d8-8e8d-890a56dbaaef";
/** The fake transaction as the type the readers take. */
const asTransaction = (value: unknown) => value as ConsumerTransaction;
const order = (n: number) => "01a1f882-feed-73bc-8921-31a128e9" + String(n).padStart(4, "0");

it("batch 37: the Orders list point reads match their readers' statements and read one Store", async () => {
  const tx = {
    query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
  };
  const reads = createOrderListPointReads(
    asTransaction(tx),
    { brandReference: brand, storeReference: store },
    [
      {
        orderReference: order(1),
        initialBatchReference: order(2),
        initialSubmissionReference: order(3),
      },
    ],
  );
  for (const statement of Object.values(orderInitialPointStatements))
    await reads.query(statement, [
      brand,
      store,
      order(1),
      ...(statement.includes("$4") ? [order(2)] : []),
    ]);
  const batches = tx.query.mock.calls.map((call) => String((call as unknown[])[0]));
  expect(batches).toHaveLength(Object.keys(orderInitialPointStatements).length);
  for (const sql of batches) {
    expect(sql).toMatch(/^SELECT [a-z.]*order_id::text AS prefetch_order,/u);
    expect(sql).toMatch(
      /brand_id=\$1 AND [a-z.]*store_id=\$2 AND [a-z.]*order_id=ANY\(\$3::uuid\[\]\)/u,
    );
    expect(sql).toMatch(/ LIMIT 10001$/u);
  }
  for (const call of tx.query.mock.calls)
    expect((call as unknown[])[1]).toEqual([brand, store, [order(1)]]);
});
