import { expect, it, vi } from "vitest";
import { createPostgresOrderRevisionPosition } from "../infrastructure/persistence/order-revision-position.js";
const id = (n: number) => "0190facf-0000-7000-8000-" + String(n).padStart(12, "0");
const scope = { brandReference: id(1), storeReference: id(2) },
  query = { orderReference: id(3), observedAt: "2026-09-20T00:05:00.000Z" };
const root = {
  revision_id: id(4),
  version: 1,
  expected_version: 0,
  previous_revision_id: null,
  initial_submission_id: id(4),
  kind: "Initial",
  occurred_at: new Date("2026-09-20T00:00:00.000Z"),
  operation_bound: true,
};
const acceptance = {
  ...root,
  revision_id: id(5),
  version: 2,
  expected_version: 1,
  previous_revision_id: id(4),
  initial_submission_id: null,
  kind: "Acceptance",
};
function setup() {
  const rows: Record<string, unknown>[] = [root, acceptance],
    batches = [{ order_batch_id: id(6) }];
  const parents: Record<string, unknown>[] = [
    { order_id: query.orderReference, created_at: root.occurred_at },
  ];
  const sql = vi.fn();
  sql.mockImplementation(async (statement: string) => ({
    rows: statement.includes("FROM rms_ordering.order_header")
      ? parents
      : statement.includes("SELECT order_batch_id")
        ? batches
        : statement.includes("SELECT r.revision_id")
          ? rows
          : [],
    rowCount: 0,
  }));
  const authorize = vi.fn(async () => true),
    tx = { query: sql };
  const read = createPostgresOrderRevisionPosition({ ...scope, authorize });
  return { rows, batches, parents, authorize, sql, load: () => read(tx, query) };
}
it("returns bound current revision facts, not inferred fulfillment or closure", async () => {
  const f = setup(),
    result = await f.load();
  expect(result.version).toBe(2);
  expect(result.checkpoint).toBe(id(5));
  expect(result.initialAcceptanceRecorded).toBe(true);
  expect(result.terminalOperation).toBe(null);
  expect(result).not.toHaveProperty("canonicalPhase");
  expect(result).not.toHaveProperty("closureStatus");
  expect(Object.isFrozen(result.batchReferences)).toBe(true);
});
it("includes every additional batch in version and snapshot evidence", async () => {
  const f = setup();
  f.batches.push({ order_batch_id: id(7) });
  f.rows.push({
    ...acceptance,
    revision_id: id(8),
    version: 3,
    expected_version: 2,
    previous_revision_id: id(5),
    kind: "AdditionalBatch",
  });
  const result = await f.load();
  expect(result.version).toBe(3);
  expect(result.batchReferences).toHaveLength(2);
});
it.each(["Termination", "Fulfillment"])(
  "retains exact terminal owner operation %s",
  async (kind) => {
    const f = setup();
    f.rows.push({
      ...acceptance,
      revision_id: id(8),
      version: 3,
      expected_version: 2,
      previous_revision_id: id(5),
      kind,
    });
    expect((await f.load()).terminalOperation).toBe(kind);
  },
);
it.each([
  "missing-order",
  "unbound",
  "gap",
  "parent",
  "root-time",
  "future",
  "missing-batch",
  "duplicate-batch",
  "after-terminal",
])("rejects invalid history %s", async (kind) => {
  const f = setup();
  if (kind === "missing-order") f.parents.length = 0;
  if (kind === "unbound") f.rows[1] = { ...acceptance, operation_bound: false };
  if (kind === "gap") f.rows[1] = { ...acceptance, version: 3 };
  if (kind === "parent") f.rows[1] = { ...acceptance, previous_revision_id: id(90) };
  if (kind === "root-time")
    f.parents[0] = {
      order_id: query.orderReference,
      created_at: new Date("2026-09-19T00:00:00.000Z"),
    };
  if (kind === "future")
    f.rows[1] = { ...acceptance, occurred_at: new Date("2026-09-21T00:00:00.000Z") };
  if (kind === "missing-batch") f.batches.push({ order_batch_id: id(9) });
  if (kind === "duplicate-batch") f.batches.push({ order_batch_id: id(6) });
  if (kind === "after-terminal") {
    f.rows[1] = { ...acceptance, kind: "Termination" };
    f.rows.push({
      ...acceptance,
      revision_id: id(8),
      version: 3,
      expected_version: 2,
      previous_revision_id: id(5),
    });
  }
  await expect(f.load()).rejects.toThrow("ORDER_REVISION_POSITION_UNAVAILABLE");
});
it("requires current authority after full read", async () => {
  const f = setup();
  f.authorize.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  await expect(f.load()).rejects.toThrow();
});

it("retains a bound batch cancellation without inventing whole-order termination", async () => {
  const f = setup();
  const cancellation = {
    ...acceptance,
    revision_id: id(9),
    version: 3,
    expected_version: 2,
    previous_revision_id: id(5),
    kind: "BatchCancellation",
  };
  f.rows.push(cancellation);
  expect(await f.load()).toMatchObject({ version: 3, checkpoint: id(9), terminalOperation: null });
  cancellation.operation_bound = false;
  await expect(f.load()).rejects.toThrow("ORDER_REVISION_POSITION_UNAVAILABLE");
});
