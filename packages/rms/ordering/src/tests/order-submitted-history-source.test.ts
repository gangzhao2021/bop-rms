import { parseOrderingReference } from "../domain/cart.js";
import { beforeEach, expect, it, vi } from "vitest";
import type { ConsumerTransaction } from "@bop/eventing";
import { orderWriteFixture } from "./order-creation-store.fixture.js";
import { additionalSourceFixture } from "./order-status-additional-source.fixture.js";
import { parseOrderSubmittedEnvelope } from "../application/order-submitted-event.js";
import { encodeAdditionalDiningBatchSnapshot } from "../domain/additional-dining-batch-codec.js";
import { createPostgresOrderSubmittedHistorySource } from "../infrastructure/persistence/order-submitted-history-source.js";
const history = vi.hoisted(() => vi.fn());
vi.mock("../infrastructure/persistence/order-creation-query-store.js", () => ({
  readOrderCreationHistory: history,
}));
beforeEach(() => history.mockReset());
function setup() {
  const f = additionalSourceFixture();
  const event = parseOrderSubmittedEnvelope(f.envelope);
  const r = orderWriteFixture({ dineIn: true, at: f.previous.submittedAt }).request.record;
  const oldBatch = f.previous.batches[0];
  if (!oldBatch) throw new Error("synthetic batch missing");
  history.mockResolvedValue({
    ...r,
    submissionReference: f.previous.submissionReference,
    orderNumberAllocation: {
      businessDate: f.previous.businessDate,
      orderNumber: f.previous.orderNumber,
    },
    order: {
      ...r.order,
      batches: [{ ...r.order.batches[0], orderBatchReference: oldBatch.orderBatchReference }],
    },
    items: r.items.map((item, index) => ({
      ...item,
      orderBatchReference: oldBatch.orderBatchReference,
      orderItemReference: "0190ed31-0000-7000-8000-" + (200 + index).toString(16).padStart(12, "0"),
    })),
  });
  const revisions = [
    {
      revision_id: f.previous.submissionReference,
      version: 1,
      expected_version: 0,
      previous_revision_id: null,
      initial_submission_id: f.previous.submissionReference,
      kind: "Initial",
      occurred_at: f.previous.submittedAt,
      acceptance_bound: false,
    },
    {
      revision_id: f.previous.sourceCheckpoint,
      version: 2,
      expected_version: 1,
      previous_revision_id: f.previous.submissionReference,
      initial_submission_id: null,
      kind: "Acceptance",
      occurred_at: f.previous.submittedAt,
      acceptance_bound: true,
    },
    {
      revision_id: f.additional.batch.submissionReference,
      version: 3,
      expected_version: 2,
      previous_revision_id: f.previous.sourceCheckpoint,
      initial_submission_id: null,
      kind: "AdditionalBatch",
      occurred_at: event.occurredAt,
      acceptance_bound: false,
    },
  ];
  const calls: { sql: string; values: readonly unknown[] }[] = [];
  const tx: ConsumerTransaction = {
    async query<Row = Record<string, unknown>>(sql: string, values: readonly unknown[]) {
      calls.push({ sql, values });
      const rows = sql.startsWith("SELECT r.revision_id")
        ? revisions
        : sql.startsWith("SELECT snapshot_json")
          ? [{ snapshot: encodeAdditionalDiningBatchSnapshot(f.additional) }]
          : [];
      return { rowCount: rows.length, rows: rows as Row[] };
    },
  };
  const authorize = vi.fn().mockResolvedValue(true);
  const load = createPostgresOrderSubmittedHistorySource({
    brandReference: f.additional.brandReference,
    storeReference: f.additional.storeReference,
    quoteVersion: 1,
    locale: f.locale,
    authorize,
  });
  const input = {
    transaction: tx,
    envelope: event,
    brandReference: f.additional.brandReference,
    storeReference: f.additional.storeReference,
    orderReference: f.additional.orderReference,
    sourceVersion: 3,
    sourceCheckpoint: f.previous.sourceCheckpoint,
    sourceDigest: event.payload.sourceSnapshotDigest,
  };
  return {
    f,
    event,
    revisions,
    calls,
    tx,
    authorize,
    load: () => load({ ...input, sourceCheckpoint: parseOrderingReference(event.eventId) }),
  };
}
it("reconstructs both batches from scoped revision and snapshot history", async () => {
  const f = setup();
  const result = await f.load();
  expect(result).toMatchObject({
    sourceVersion: 3,
    canonicalPhase: "Accepted",
    fulfillmentStatus: "Unavailable",
    orderNumber: f.f.previous.orderNumber,
    submissionReference: f.f.previous.submissionReference,
  });
  expect((result as { batches: unknown[] }).batches).toHaveLength(2);
  expect(history.mock.calls[0]?.[0]).toBe(f.tx);
  expect(
    f.calls
      .filter(({ sql }) => sql.includes("FROM rms_ordering"))
      .every(({ values }) => values[0] === f.event.tenantId && values[1] === f.event.storeId),
  ).toBe(true);
});
it("rejects a gap in the persisted revision chain", async () => {
  const f = setup();
  f.revisions.splice(1, 1);
  await expect(f.load()).rejects.toThrow();
});
it("rejects Acceptance revision without matching acceptance history", async () => {
  const f = setup();
  const acceptance = f.revisions[1];
  if (!acceptance) throw new Error("fixture missing");
  acceptance.acceptance_bound = false;
  await expect(f.load()).rejects.toThrow();
});
it("returns no source while initial immutable history is unavailable", async () => {
  const f = setup();
  history.mockResolvedValue(null);
  expect(await f.load()).toBeNull();
});
it("reauthorizes after assembling exact history", async () => {
  const f = setup();
  f.authorize.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  await expect(f.load()).rejects.toThrow();
});
