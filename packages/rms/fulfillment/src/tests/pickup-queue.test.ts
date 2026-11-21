import { expect, it, vi } from "vitest";
import { createPostgresFulfillmentReadinessStore } from "../index.js";
import type { ConsumerTransaction } from "@bop/eventing";
const id = (n: number) => "01909985-0000-7000-8000-" + n.toString(16).padStart(12, "0");
function setup() {
  const query = vi.fn(async (sql: string, values: readonly unknown[]) => {
    void sql;
    void values;
    return { rows: [], rowCount: 0 };
  });
  const transaction = { query } as unknown as ConsumerTransaction;
  const authorizeQueue = vi.fn(async () => true);
  const options = {
    brandReference: id(1),
    storeReference: id(2),
    sha256: () => "sha256:" + "a".repeat(64),
    now: () => "2026-09-19T12:00:00.000Z",
    authorize: async () => true,
    validateCurrentSource: async () => true,
    authorizeQueue,
  };
  const input = {
    transaction,
    afterFulfillmentReference: null,
    limit: 20,
    includeCompleted: false,
  };
  return { query, authorizeQueue, options, input };
}
it("requires explicit current queue permission before any SQL", async () => {
  const f = setup();
  f.authorizeQueue.mockResolvedValue(false);
  await expect(
    createPostgresFulfillmentReadinessStore(f.options).listPickupQueue(f.input),
  ).rejects.toThrow();
  expect(f.query).not.toHaveBeenCalled();
  const { authorizeQueue: omitted, ...options } = f.options;
  expect(omitted).toBeDefined();
  await expect(
    createPostgresFulfillmentReadinessStore(options).listPickupQueue(f.input),
  ).rejects.toThrow();
  expect(f.query).not.toHaveBeenCalled();
});
it.each([0, 51, 1.5])("rejects an unbounded or invalid page limit %s before SQL", async (limit) => {
  const f = setup();
  await expect(
    createPostgresFulfillmentReadinessStore(f.options).listPickupQueue({ ...f.input, limit }),
  ).rejects.toThrow();
  expect(f.query).not.toHaveBeenCalled();
});
it("binds page scope and limit then rechecks permission before returning even an empty page", async () => {
  const f = setup(),
    store = createPostgresFulfillmentReadinessStore(f.options);
  expect(await store.listPickupQueue(f.input)).toEqual({
    source: "CurrentFulfillment",
    observedAt: "2026-09-19T12:00:00.000Z",
    items: [],
    nextAfterFulfillmentReference: null,
  });
  expect(f.query.mock.calls[0]?.[1]).toEqual([id(1), id(2), null, false, 21]);
  f.authorizeQueue.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  await expect(store.listPickupQueue(f.input)).rejects.toThrow();
});
