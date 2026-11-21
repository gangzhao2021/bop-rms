import type { ConsumerTransaction } from "../contracts/consumer-inbox.js";
import { expect, it, vi } from "vitest";
import {
  createSnapshotPointReads,
  pointReadReference,
  type SnapshotPointRead,
} from "../infrastructure/persistence/snapshot-point-reads.js";

const brand = "01a1a943-3f11-73d5-97eb-2bec032b0259";
const store = "01a1a943-3f11-75d8-8e8d-890a56dbaaef";
const otherStore = "01a1a943-3f11-75d8-8e8d-890a56dbaaf0";
/** The fake transaction as the type the readers take. */
const asTransaction = (value: unknown) => value as ConsumerTransaction;
const order = (n: number) => "01a1f882-feed-73bc-8921-31a128e9" + String(n).padStart(4, "0");

const point =
  "SELECT record FROM owner.records WHERE brand_id=$1 AND store_id=$2 AND order_id=$3 LIMIT 2";
const read = (overrides: Partial<SnapshotPointRead> = {}): SnapshotPointRead => ({
  statement: point,
  batchStatement: "SELECT order_id::text AS prefetch_key,record FROM owner.records WHERE ...",
  keyColumns: ["prefetch_key"],
  limit: 2,
  maximumRows: 10,
  key: (values) =>
    values.length === 3 && values[0] === brand && values[1] === store
      ? pointReadReference(values[2])
      : null,
  batchValues: (keys) => [brand, store, [...keys]],
  ...overrides,
});
function transaction(rows: Record<string, unknown>[]) {
  return {
    query: vi.fn(async (sql: string, values: readonly unknown[]) => {
      if (sql.startsWith("SELECT order_id::text AS prefetch_key"))
        return { rows, rowCount: rows.length };
      return { rows: [{ sent: sql, values }], rowCount: 1 };
    }),
  };
}

it("batch 37: answers each listed key's point read from one batch read, with its own rows and limit", async () => {
  const tx = transaction([
    { prefetch_key: order(1), record: "a" },
    { prefetch_key: order(1), record: "b" },
    { prefetch_key: order(1), record: "c" },
    { prefetch_key: order(2), record: "d" },
  ]);
  const reads = createSnapshotPointReads(asTransaction(tx), [
    { read: read(), keys: async () => [order(1), order(2), order(3)] },
  ]);
  // A trailing row-locking clause is left out (a snapshot read takes no row locks).
  const one = await reads.query(point + " FOR SHARE", [brand, store, order(1)]);
  const two = await reads.query(point, [brand, store, order(2)]);
  const none = await reads.query(point, [brand, store, order(3)]);
  expect(one).toEqual({ rows: [{ record: "a" }, { record: "b" }], rowCount: 2 });
  expect(two).toEqual({ rows: [{ record: "d" }], rowCount: 1 });
  expect(none).toEqual({ rows: [], rowCount: 0 });
  expect(tx.query).toHaveBeenCalledTimes(1);
  expect(tx.query.mock.calls[0]?.[1]).toEqual([brand, store, [order(1), order(2), order(3)]]);
});

it("batch 37: sends every other point read as it was (another Store, an unlisted key, another text, a repeat)", async () => {
  const tx = transaction([{ prefetch_key: order(1), record: "a" }]);
  const reads = createSnapshotPointReads(asTransaction(tx), [
    { read: read(), keys: async () => [order(1)] },
  ]);
  await reads.query(point, [brand, otherStore, order(1)]);
  await reads.query(point, [brand, store, order(9)]);
  await reads.query(point + " AND hidden", [brand, store, order(1)]);
  await reads.query(point, [brand, store, order(1).toUpperCase()]);
  expect(tx.query.mock.calls.filter(([sql]) => sql.startsWith("SELECT record"))).toHaveLength(4);
  // The listed key is answered once; the same point read sent again runs as before.
  expect((await reads.query(point, [brand, store, order(1)])).rows).toEqual([{ record: "a" }]);
  expect((await reads.query(point, [brand, store, order(1)])).rows).toEqual([
    { sent: point, values: [brand, store, order(1)] },
  ]);
});

it("batch 37: a repeated read answers a copy each time; a batch past its limit answers nothing", async () => {
  const tx = transaction([{ prefetch_key: order(1), record: { nested: 1 } }]);
  const reads = createSnapshotPointReads(asTransaction(tx), [
    { read: read({ repeated: true }), keys: async () => [order(1)] },
  ]);
  const first = await reads.query<{ record: { nested: number } }>(point, [brand, store, order(1)]);
  const changed = first.rows[0];
  if (changed) changed.record.nested = 2;
  const second = await reads.query<{ record: { nested: number } }>(point, [brand, store, order(1)]);
  expect(second.rows).toEqual([{ record: { nested: 1 } }]);
  expect(tx.query).toHaveBeenCalledTimes(1);

  const full = transaction(
    Array.from({ length: 10 }, (_, n) => ({ prefetch_key: order(1), record: n })),
  );
  const overflow = createSnapshotPointReads(asTransaction(full), [
    { read: read(), keys: async () => [order(1)] },
  ]);
  expect((await overflow.query(point, [brand, store, order(1)])).rows).toEqual([
    { sent: point, values: [brand, store, order(1)] },
  ]);
});
