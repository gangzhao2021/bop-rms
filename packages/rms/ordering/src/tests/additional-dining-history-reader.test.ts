import { createHash } from "node:crypto";
import { expect, it, vi, beforeEach } from "vitest";
import type { ConsumerTransaction } from "@bop/eventing";
import { orderWriteFixture, orderCapacityLinkFixture } from "./order-creation-store.fixture.js";
import { encodeAdditionalDiningBatchSnapshot } from "../domain/additional-dining-batch-codec.js";
import { createPostgresAdditionalDiningBatchHistoryReader } from "../infrastructure/persistence/additional-dining-batch-store.js";
const parent = vi.hoisted(() => vi.fn());
vi.mock("../infrastructure/persistence/order-termination-store.js", () => ({
  createPostgresDiningOrderPreparationSource: () => ({ resolve: parent }),
}));
beforeEach(() => parent.mockReset());
function fixture() {
  const f = orderWriteFixture({ dineIn: true });
  const r = f.request.record;
  const snapshot = {
    brandReference: r.order.brandReference,
    storeReference: r.order.storeReference,
    orderReference: r.order.orderReference,
    diningSessionReference: r.order.diningSessionReference,
    guestSessionReference: r.guestSessionReference,
    originalOrderCreatedAt: r.createdAt,
    expectedOrderVersion: 1,
    batchSequence: 2,
    snapshotVersion: 1,
    batch: r.order.batches[0],
    items: r.items,
  };
  const encoded = encodeAdditionalDiningBatchSnapshot(snapshot);
  const row = {
    snapshot: encoded,
    batch_sequence: 2,
    version: 2,
    intent_digest: "sha256:" + createHash("sha256").update(encoded).digest("hex"),
    link: orderCapacityLinkFixture(f),
  };
  const rows = [row];
  let allowed = true,
    revokeOnRead = false;
  const calls: { sql: string; values: readonly unknown[] }[] = [];
  const transaction: ConsumerTransaction = {
    async query<Row = Record<string, unknown>>(sql: string, values: readonly unknown[]) {
      calls.push({ sql, values });
      if (sql.startsWith("SELECT a.snapshot_json")) {
        if (revokeOnRead) allowed = false;
        return { rows: rows as Row[], rowCount: rows.length };
      }
      return { rows: [] as Row[], rowCount: 1 };
    },
  };
  const reader = createPostgresAdditionalDiningBatchHistoryReader({
    ...f.scope,
    transactions: { run: async (work) => work(transaction) },
    authorize: async (tx) => tx === transaction && allowed,
  });
  return {
    reader,
    transaction,
    deny: () => {
      allowed = false;
    },
    row,
    rows,
    calls,
    reference: r.submissionReference,
    revoke: () => {
      revokeOnRead = true;
    },
  };
}
it("reads the exact additional snapshot and linked operation from owner history", async () => {
  const f = fixture();
  expect((await f.reader.resolveSubmission(f.reference))?.batchSequence).toBe(2);
  expect(await f.reader.resolveCapacityLink(f.reference)).toEqual(f.row.link);
  expect(f.calls.find(({ sql }) => sql.startsWith("SELECT a.snapshot_json"))?.values[2]).toBe(
    f.reference,
  );
});
it("returns no fallback when additional history is absent", async () => {
  const f = fixture();
  f.rows.length = 0;
  expect(await f.reader.resolveSubmission(f.reference)).toBeNull();
});
it.each(["digest", "version", "sequence"])("rejects inconsistent %s", async (mode) => {
  const f = fixture();
  if (mode === "digest") f.row.intent_digest = "sha256:" + "0".repeat(64);
  if (mode === "version") f.row.version = 3;
  if (mode === "sequence") f.row.batch_sequence = 3;
  await expect(f.reader.resolveSubmission(f.reference)).rejects.toThrow();
});
it("does not return history after access is revoked during SQL", async () => {
  const f = fixture();
  f.revoke();
  await expect(f.reader.resolveSubmission(f.reference)).rejects.toThrow();
});

it("holds the same transaction through current parent and downstream admission", async () => {
  const f = fixture();
  parent.mockResolvedValue({ orderVersion: 2 });
  const callback = vi.fn(async (transaction) => transaction === f.transaction);
  expect(
    await f.reader.withCurrentSubmission(
      f.reference,
      JSON.parse(f.row.snapshot).batch.submittedAt,
      callback,
    ),
  ).toBe(true);
  expect(parent.mock.calls[0]?.[0].transaction).toBe(f.transaction);
  expect(callback).toHaveBeenCalledOnce();
});
it.each([null, { orderVersion: 1 }])("does not admit missing or older parent", async (current) => {
  const f = fixture();
  parent.mockResolvedValue(current);
  const callback = vi.fn();
  expect(
    await f.reader.withCurrentSubmission(
      f.reference,
      JSON.parse(f.row.snapshot).batch.submittedAt,
      callback,
    ),
  ).toBeNull();
  expect(callback).not.toHaveBeenCalled();
});
it("does not return downstream result after authorization revocation", async () => {
  const f = fixture();
  parent.mockResolvedValue({ orderVersion: 2 });
  await expect(
    f.reader.withCurrentSubmission(
      f.reference,
      JSON.parse(f.row.snapshot).batch.submittedAt,
      async () => {
        f.deny();
        return true;
      },
    ),
  ).rejects.toThrow();
});
