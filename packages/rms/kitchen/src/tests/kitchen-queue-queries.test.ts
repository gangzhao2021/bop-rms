import { expect, it, vi } from "vitest";
import type { ConsumerTransaction } from "@bop/eventing";
import { createPostgresKitchenQueueQueries } from "../index.js";
const id = (n: number) => "01909985-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-09-19T12:00:00.000Z";
function setup() {
  const generation = {
    projectionGenerationReference: id(3),
    brandReference: id(1),
    storeReference: id(2),
    projectionName: "kitchen_work_queue_v1",
    projectionVersion: 1,
    generationStatus: "Active",
    sourceCheckpointReference: id(4),
    sourceEventBindingDigest: "sha256:" + "a".repeat(64),
    queueSnapshotDigest: "sha256:" + "b".repeat(64),
    ticketCount: 1,
    workItemCount: 2,
    initializedEmpty: false,
    asOfUtc: new Date(at),
    projectedAt: new Date(at),
    lastRebuiltAt: null,
    freshnessStatus: "Fresh",
    rebuildReference: null,
    rebuildRequestDigest: null,
    rebuildRequestedAt: null,
    expectedPriorGenerationReference: null,
    snapshotBindingVersion: 2,
  };
  const row = {
    projectionGenerationReference: id(3),
    brandReference: id(1),
    storeReference: id(2),
    ticketReference: id(5),
    workItemReference: id(6),
    orderReference: id(7),
    orderBatchReference: id(8),
    orderItemReference: id(9),
    sourceItemOrdinal: 1,
    ticketAggregateVersion: "9007199254740993",
    workItemVersion: "9007199254740993",
    status: "Queued",
    requiredQuantity: 1,
    completedQuantity: 0,
    localizedDisplayNames: { "en-CA": "Synthetic item" },
    selectedOptions: [],
    stationReference: id(10),
    originalSourceEventReference: id(11),
    sourceEventSemanticDigest: "sha256:" + "c".repeat(64),
    sourceEventOccurredAt: new Date(at),
    workItemCreatedAt: new Date(at),
    acceptedAt: null,
    orderItemReadyAt: null,
  };
  const sql = vi
    .fn()
    .mockResolvedValueOnce({ rows: [generation], rowCount: 1 })
    .mockResolvedValue({ rows: [row], rowCount: 1 });
  const transaction = { query: sql } as unknown as ConsumerTransaction;
  const authorize = vi.fn().mockResolvedValue(true);
  const queries = createPostgresKitchenQueueQueries({
    brandReference: id(1),
    storeReference: id(2),
    authorize,
  });
  const query = {
    actorReference: id(12),
    brandReference: id(1),
    storeReference: id(2),
    observedAt: at,
    filters: {
      orderReference: null,
      ticketReference: null,
      workItemReference: null,
      stationReference: null,
      status: null,
    },
    cursor: null,
    limit: 1,
  };
  // Public methods parse untrusted input; cast only bridges branded contract types for adapter tests.
  const list = (value: unknown = query) =>
    queries.list({ transaction, query: value as Parameters<typeof queries.list>[0]["query"] });
  const get = () =>
    queries.get({
      transaction,
      query: {
        actorReference: id(12),
        brandReference: id(1),
        storeReference: id(2),
        observedAt: at,
        workItemReference: id(6),
      } as Parameters<typeof queries.get>[0]["query"],
    });
  return { generation, row, sql, transaction, authorize, queries, query, list, get };
}
it("retains exact bigint versions and generation identity", async () => {
  const f = setup();
  const result = await f.list();
  expect(result.status).toBe("Found");
  if (result.status !== "Found") throw new Error("missing");
  expect(result.rows).toMatchObject([
    {
      ticketAggregateVersion: 9007199254740993n,
      workItemVersion: 9007199254740993n,
      workItemCreatedAt: at,
    },
  ]);
  expect(result).toMatchObject({ returnedCount: 1, hasMore: false });
  expect(f.sql.mock.calls[1]?.[1]).toEqual([
    id(1),
    id(2),
    id(3),
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    2,
  ]);
  expect(f.authorize).toHaveBeenCalledTimes(2);
});
it.each([
  ["Order", "orderReference", id(20)],
  ["Ticket", "ticketReference", id(21)],
] as const)("binds an exact %s filter only to its scoped SQL parameter", async (_, field, ref) => {
  const f = setup();
  const result = await f.list({
    ...f.query,
    filters: { ...f.query.filters, [field]: ref },
  });
  expect(result.status).toBe("Found");
  const statement = f.sql.mock.calls[1]?.[0];
  const parameters = f.sql.mock.calls[1]?.[1];
  expect(statement).toContain("AND ($4::uuid IS NULL OR order_id=$4)");
  expect(statement).toContain("AND ($5::uuid IS NULL OR kitchen_ticket_id=$5)");
  expect(statement).not.toContain(ref);
  expect(parameters?.slice(3, 5)).toEqual(field === "orderReference" ? [ref, null] : [null, ref]);
  expect(f.authorize).toHaveBeenCalledTimes(2);
});
it("uses a bounded keyset page and returns only requested count", async () => {
  const f = setup();
  f.sql.mockResolvedValue({
    rows: [f.row, { ...f.row, workItemReference: id(13), sourceItemOrdinal: 2 }],
    rowCount: 2,
  });
  const result = await f.list({
    ...f.query,
    cursor: {
      projectionGenerationReference: id(3),
      afterCreatedAt: at,
      afterWorkItemReference: id(14),
      filterSortDigest: "sha256:" + "d".repeat(64),
    },
    filters: { ...f.query.filters, stationReference: id(10), status: "Queued" },
  });
  expect(result).toMatchObject({ status: "Found", returnedCount: 1, hasMore: true });
  expect(f.sql.mock.calls[1]?.[1]).toEqual([
    id(1),
    id(2),
    id(3),
    null,
    null,
    null,
    id(10),
    "Queued",
    at,
    id(14),
    2,
  ]);
});
it("distinguishes unbuilt queue and missing work item", async () => {
  const f = setup();
  f.sql.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
  expect(await f.list()).toEqual({ status: "NoActive" });
  const g = setup();
  g.sql.mockResolvedValue({ rows: [], rowCount: 0 });
  expect(await g.get()).toEqual({ status: "NotFound" });
});
it("reads one scoped work item", async () => {
  const f = setup();
  expect(await f.get()).toMatchObject({ status: "Found", row: { workItemReference: id(6) } });
  expect(f.sql.mock.calls[1]?.[1]).toEqual([id(1), id(2), id(3), id(6)]);
});
it("refuses unauthorized and foreign Store access before SQL", async () => {
  const f = setup();
  f.authorize.mockResolvedValue(false);
  await expect(f.list()).rejects.toMatchObject({ code: "KITCHEN_QUEUE_PERMISSION_DENIED" });
  expect(f.sql).not.toHaveBeenCalled();
  const g = setup();
  await expect(g.list({ ...g.query, storeReference: id(99) })).rejects.toMatchObject({
    code: "KITCHEN_QUEUE_PERMISSION_DENIED",
  });
  expect(g.sql).not.toHaveBeenCalled();
});
it("does not release data after authorization is withdrawn", async () => {
  const f = setup();
  f.authorize.mockResolvedValueOnce(true).mockResolvedValue(false);
  await expect(f.get()).rejects.toMatchObject({ code: "KITCHEN_QUEUE_PERMISSION_DENIED" });
});
it("rejects wrong generation rows and imprecise database bigint decoding", async () => {
  const f = setup();
  f.row.projectionGenerationReference = id(99);
  await expect(f.list()).rejects.toThrow();
  const g = setup();
  g.sql.mockResolvedValue({ rows: [{ ...g.row, workItemVersion: 9007199254740992 }], rowCount: 1 });
  await expect(g.get()).rejects.toThrow();
});
it("sanitizes database failures", async () => {
  const f = setup();
  f.sql.mockReset().mockRejectedValue(new Error("private SQL or credentials"));
  await expect(f.list()).rejects.toMatchObject({ code: "KITCHEN_QUEUE_DEPENDENCY_UNAVAILABLE" });
  await expect(f.get()).rejects.not.toThrow("private SQL");
});
