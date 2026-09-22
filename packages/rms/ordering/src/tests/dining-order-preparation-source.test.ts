import { expect, it } from "vitest";
import { createPostgresDiningOrderPreparationSource } from "../infrastructure/persistence/order-termination-store.js";
const id = (n: number) => "0190ed21-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-09-13T12:00:00.000Z";
function fixture() {
  const scope = { brandReference: id(1), storeReference: id(2) };
  let allowed = true;
  const header = { order_type: "DineIn", dining_session_id: id(4), order_batch_id: id(5) };
  const headers = [header];
  const acceptance: Record<string, unknown>[] = [];
  const revisions: Record<string, unknown>[] = [
    {
      revision_id: id(6),
      version: 1,
      occurred_at: at,
      expected_version: 0,
      previous_revision_id: null,
      initial_submission_id: id(6),
      kind: "Initial",
      operation_bound: true,
    },
  ];
  const parentFacts = { created_at: at, initial_at: at, batch_count: 1 };
  const calls: string[] = [];
  const transaction = {
    async query<Row = Record<string, unknown>>(sql: string) {
      calls.push(sql);
      const rows = sql.startsWith("SELECT h.created_at")
        ? [parentFacts]
        : sql.startsWith("SELECT h.order_type")
          ? headers
          : sql.startsWith("SELECT h.aggregate_version")
            ? [
                {
                  aggregate_version: 1,
                  canonical_phase: "Submitted",
                  submission_id: id(6),
                  submitted_at: at,
                },
              ]
            : sql.startsWith("SELECT acceptance_id")
              ? acceptance
              : sql.startsWith("SELECT r.revision_id")
                ? revisions
                : sql.startsWith("SELECT revision_id")
                  ? revisions.slice(-1)
                  : [];
      return { rows: rows as readonly Row[], rowCount: rows.length };
    },
  };
  const source = createPostgresDiningOrderPreparationSource({
    ...scope,
    authorize: async () => allowed,
  });
  const input = {
    ...scope,
    transaction,
    orderReference: id(3),
    diningSessionReference: id(4),
    guestSessionReference: id(7),
    observedAt: at,
  };
  return {
    source,
    parentFacts,
    input,
    header,
    headers,
    acceptance,
    revisions,
    calls,
    revoke: () => {
      allowed = false;
    },
  };
}
it("returns persisted initial Dining version while retaining the disposition fence", async () => {
  const f = fixture();
  expect(await f.source.resolve(f.input)).toMatchObject({ orderReference: id(3), orderVersion: 1 });
  expect(await f.source.resolveCurrent(f.input)).toMatchObject({ orderCheckpoint: id(6) });
  expect(f.calls.some((sql) => sql.includes("pg_advisory_xact_lock"))).toBe(true);
});
it("derives accepted version from exact acceptance history", async () => {
  const f = fixture();
  f.acceptance.push({
    acceptance_id: id(8),
    order_batch_id: id(5),
    expected_order_version: 1,
    accepted_order_version: 2,
    accepted_at: at,
  });
  f.revisions.push({
    revision_id: id(8),
    version: 2,
    occurred_at: at,
    expected_version: 1,
    previous_revision_id: id(6),
    initial_submission_id: null,
    kind: "Acceptance",
    operation_bound: true,
  });
  expect(await f.source.resolve(f.input)).toMatchObject({ orderVersion: 2 });
  expect(await f.source.resolveCurrent(f.input)).toMatchObject({
    orderVersion: 2,
    canonicalPhase: "Accepted",
  });
});
it.each(["Pickup", "foreign-session"])("rejects ineligible parent %s", async (mode) => {
  const f = fixture();
  if (mode === "Pickup") f.header.order_type = "Pickup";
  else f.header.dining_session_id = id(90);
  expect(await f.source.resolve(f.input)).toBeNull();
});
it("rejects current authorization denial before reading order history", async () => {
  const f = fixture();
  f.revoke();
  await expect(f.source.resolve(f.input)).rejects.toBeDefined();
  expect(f.calls.some((sql) => sql.startsWith("SELECT h."))).toBe(false);
});
it("rejects discontinuous acceptance history instead of inventing a version", async () => {
  const f = fixture();
  f.acceptance.push({
    acceptance_id: id(8),
    order_batch_id: id(5),
    expected_order_version: 2,
    accepted_order_version: 3,
    accepted_at: at,
  });
  await expect(f.source.resolve(f.input)).rejects.toBeDefined();
});

it.each(["missing", "newer", "checkpoint", "time"])(
  "rejects parent preparation when revision evidence is %s",
  async (mode) => {
    const f = fixture();
    if (mode === "missing") f.revisions.length = 0;
    else if (mode === "newer") f.revisions[0] = { revision_id: id(9), version: 2, occurred_at: at };
    else if (mode === "checkpoint")
      f.revisions[0] = { revision_id: id(9), version: 1, occurred_at: at };
    else
      f.revisions[0] = { revision_id: id(6), version: 1, occurred_at: "2026-09-13T12:00:00.001Z" };
    await expect(f.source.resolve(f.input)).rejects.toBeDefined();
  },
);

function multiple() {
  const f = fixture();
  f.headers.push({ ...f.header, order_batch_id: id(9) });
  f.revisions.splice(
    0,
    1,
    {
      revision_id: id(6),
      version: 1,
      expected_version: 0,
      previous_revision_id: null,
      initial_submission_id: id(6),
      kind: "Initial",
      occurred_at: at,
      operation_bound: true,
    },
    {
      revision_id: id(10),
      version: 2,
      expected_version: 1,
      previous_revision_id: id(6),
      initial_submission_id: null,
      kind: "AdditionalBatch",
      occurred_at: at,
      operation_bound: true,
    },
  );
  return f;
}
it("returns current revision after a second persisted Dining batch", async () => {
  const f = multiple();
  expect(await f.source.resolve(f.input)).toMatchObject({ orderVersion: 2 });
  expect(await f.source.resolveCurrent(f.input)).toMatchObject({
    orderVersion: 2,
    orderCheckpoint: id(10),
    canonicalPhase: "Submitted",
  });
  expect(f.calls.some((sql) => sql.includes("AS operation_bound"))).toBe(true);
});
it.each(["gap", "unbound", "count", "future"])(
  "rejects inconsistent multi-Batch history: %s",
  async (mode) => {
    const f = multiple();
    const last = f.revisions[1];
    if (!last) throw new Error("missing synthetic revision");
    if (mode === "gap") last.previous_revision_id = id(99);
    if (mode === "unbound") last.operation_bound = false;
    if (mode === "count") f.headers.push({ ...f.header, order_batch_id: id(11) });
    if (mode === "future") last.occurred_at = "2026-09-13T12:00:00.001Z";
    await expect(f.source.resolve(f.input)).rejects.toBeDefined();
  },
);
it.each(["Termination", "Fulfillment"])("does not prepare after %s", async (kind) => {
  const f = multiple();
  f.revisions.push({ kind });
  expect(await f.source.resolve(f.input)).toBeNull();
});
it("reauthorizes after reading multi-Batch history", async () => {
  const f = multiple();
  const original = f.input.transaction.query;
  f.input.transaction.query = async <Row = Record<string, unknown>>(sql: string) => {
    const result = await original<Row>(sql);
    if (sql.startsWith("SELECT r.revision_id")) f.revoke();
    return result;
  };
  await expect(f.source.resolve(f.input)).rejects.toBeDefined();
});

it("reads original parent time and next Batch sequence under the existing fence", async () => {
  const f = fixture();
  expect(await f.source.resolveAdditionalParent(f.input)).toMatchObject({
    orderReference: id(3),
    orderVersion: 1,
    originalOrderCreatedAt: at,
    nextBatchSequence: 2,
  });
  expect(f.calls.findIndex((sql) => sql.includes("pg_advisory_xact_lock"))).toBeLessThan(
    f.calls.findIndex((sql) => sql.startsWith("SELECT h.created_at")),
  );
});
it("derives next Batch sequence from stored batches rather than Order revision version", async () => {
  const f = multiple();
  f.parentFacts.batch_count = 2;
  expect(await f.source.resolveAdditionalParent(f.input)).toMatchObject({ nextBatchSequence: 3 });
});
it("rejects parent creation time that disagrees with immutable initial revision", async () => {
  const f = fixture();
  f.parentFacts.created_at = "2026-09-13T11:59:00.000Z";
  await expect(f.source.resolveAdditionalParent(f.input)).rejects.toBeDefined();
});
it("does not read parent metadata for an ineligible Order", async () => {
  const f = fixture();
  f.header.order_type = "Pickup";
  expect(await f.source.resolveAdditionalParent(f.input)).toBeNull();
  expect(f.calls.some((sql) => sql.startsWith("SELECT h.created_at"))).toBe(false);
});

it("exposes current phase while preserving the existing preparation contract", async () => {
  const f = fixture();
  const current = await f.source.resolveCurrent(f.input);
  expect(current).toMatchObject({ orderVersion: 1, canonicalPhase: "Submitted" });
  const existing = await f.source.resolve(f.input);
  expect(existing).not.toHaveProperty("canonicalPhase");
  expect(existing).not.toHaveProperty("orderCheckpoint");
});

it("does not compare obsolete initial execution after a bound terminal batch cancellation", async () => {
  const f = fixture();
  f.revisions.push({
    revision_id: id(20),
    version: 2,
    expected_version: 1,
    previous_revision_id: id(6),
    initial_submission_id: null,
    kind: "BatchCancellation",
    occurred_at: at,
    operation_bound: true,
    cancellation_phase: "Cancelled",
  });
  expect(await f.source.resolveCurrent(f.input)).toBeNull();
  expect(await f.source.resolveCancelled(f.input)).toMatchObject({
    phase: "Cancelled",
    orderVersion: 2,
  });
  expect(await f.source.resolveAdditionalParent(f.input)).toBeNull();
  expect(f.calls.some((sql) => sql.startsWith("SELECT revision_id"))).toBe(false);
  const cancellation = f.revisions[1];
  if (!cancellation) throw new Error("missing fixture cancellation");
  cancellation.operation_bound = false;
  await expect(f.source.resolveCurrent(f.input)).rejects.toBeDefined();
  await expect(f.source.resolveCancelled(f.input)).rejects.toBeDefined();
  cancellation.operation_bound = true;
  cancellation.occurred_at = "2026-09-13T12:01:00.000Z";
  await expect(f.source.resolveCurrent(f.input)).rejects.toBeDefined();
  await expect(f.source.resolveCancelled(f.input)).rejects.toBeDefined();
});

it("preserves another accepted Batch when the latest revision cancels only one Batch", async () => {
  const f = multiple();
  f.revisions.push({
    revision_id: id(21),
    version: 3,
    expected_version: 2,
    previous_revision_id: id(10),
    initial_submission_id: null,
    kind: "Acceptance",
    occurred_at: at,
    operation_bound: true,
  });
  f.revisions.push({
    revision_id: id(22),
    version: 4,
    expected_version: 3,
    previous_revision_id: id(21),
    initial_submission_id: null,
    kind: "BatchCancellation",
    occurred_at: at,
    operation_bound: true,
    cancellation_phase: "Cancelled",
  });
  expect(await f.source.resolveCurrent(f.input)).toMatchObject({
    orderVersion: 4,
    orderCheckpoint: id(22),
    canonicalPhase: "Accepted",
  });
});
it("returns no preparation only after all persisted batches have bound cancellations", async () => {
  const f = multiple();
  f.revisions.push({
    revision_id: id(21),
    version: 3,
    expected_version: 2,
    previous_revision_id: id(10),
    initial_submission_id: null,
    kind: "BatchCancellation",
    occurred_at: at,
    operation_bound: true,
    cancellation_phase: "Cancelled",
  });
  expect(await f.source.resolveCurrent(f.input)).toMatchObject({ orderVersion: 3 });
  expect(await f.source.resolveCancelled(f.input)).toBeNull();
  f.revisions.push({
    revision_id: id(22),
    version: 4,
    expected_version: 3,
    previous_revision_id: id(21),
    initial_submission_id: null,
    kind: "BatchCancellation",
    occurred_at: at,
    operation_bound: true,
    cancellation_phase: "Cancelled",
  });
  expect(await f.source.resolveCurrent(f.input)).toBeNull();
  expect(await f.source.resolveCancelled(f.input)).toMatchObject({
    phase: "Cancelled",
    orderVersion: 4,
  });
  f.revoke();
  await expect(f.source.resolveCancelled(f.input)).rejects.toBeDefined();
});
