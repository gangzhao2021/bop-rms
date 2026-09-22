import { orderWriteFixture } from "./order-creation-store.fixture.js";
import { encodeAdditionalDiningBatchSnapshot } from "../domain/additional-dining-batch-codec.js";
import { beforeEach, expect, it, vi } from "vitest";
import type { ConsumerTransaction, ConsumerOutcome, DomainEventEnvelope } from "@bop/eventing";
import { additionalSourceFixture } from "./order-status-additional-source.fixture.js";
import { createOrderStatusAdditionalSource } from "../application/order-status-additional-source.js";
import { parseOrderSubmittedEnvelope } from "../application/order-submitted-event.js";
import { createPostgresOrderSubmittedConsumer } from "../infrastructure/persistence/order-submitted-consumer.js";
import { decodeOrderStatusSnapshot } from "../application/order-status-snapshot-codec.js";
const outbox = vi.hoisted(() => vi.fn());
vi.mock("@bop/eventing", async (original) => ({
  ...(await original<typeof import("@bop/eventing")>()),
  loadOutboxEnvelope: outbox,
}));
const initialHistory = vi.hoisted(() => vi.fn());
vi.mock("../infrastructure/persistence/order-creation-query-store.js", () => ({
  readOrderCreationHistory: initialHistory,
}));
beforeEach(() => initialHistory.mockReset());
function setup(failPointer = false, freshness: "Fresh" | "Stale" = "Fresh") {
  const f = additionalSourceFixture();
  const event = parseOrderSubmittedEnvelope(f.envelope);
  outbox.mockResolvedValue(event);
  const source = createOrderStatusAdditionalSource(f);
  const original = orderWriteFixture({ dineIn: true, at: f.previous.submittedAt }).request.record;
  const oldBatch = f.previous.batches[0];
  if (!oldBatch) throw new Error("synthetic batch missing");
  initialHistory.mockResolvedValue({
    ...original,
    submissionReference: f.previous.submissionReference,
    orderNumberAllocation: {
      businessDate: f.previous.businessDate,
      orderNumber: f.previous.orderNumber,
    },
    order: {
      ...original.order,
      batches: [
        { ...original.order.batches[0], orderBatchReference: oldBatch.orderBatchReference },
      ],
    },
    items: original.items.map((item, index) => ({
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
  const latest = {
    version: 3,
    kind: "AdditionalBatch",
    snapshot: encodeAdditionalDiningBatchSnapshot(f.additional) as string | null,
  };
  const calls: { sql: string; values: readonly unknown[] }[] = [];
  const tx: ConsumerTransaction = {
    async query<Row = Record<string, unknown>>(sql: string, values: readonly unknown[]) {
      calls.push({ sql, values });
      return {
        rowCount:
          failPointer && sql.startsWith("INSERT INTO rms_ordering.order_status_projection (")
            ? 0
            : 1,
        rows: (sql.startsWith("SELECT r.version,r.kind")
          ? [latest]
          : sql.startsWith("SELECT r.revision_id")
            ? revisions
            : sql.startsWith("SELECT snapshot_json")
              ? [{ snapshot: encodeAdditionalDiningBatchSnapshot(f.additional) }]
              : []) as Row[],
      };
    },
  };
  const consumer = createPostgresOrderSubmittedConsumer({
    projection: {
      brandReference: source.brandReference,
      storeReference: source.storeReference,
      authorize: async (transaction) => transaction === tx,
      validateCurrentSource: async (transaction, projection) =>
        transaction === tx && projection.snapshot.sourceCheckpoint === event.eventId,
    },
    authorization: { authorize: async (transaction) => transaction === tx },
    history: { quoteVersion: 1, locale: f.locale },
    freshness: async () => freshness,
    references: { generateGeneration: () => event.eventId, now: () => source.submittedAt },
  });
  return { event, tx, calls, consumer, revisions, latest };
}
it("uses real projection and Inbox SQL on the same consumer transaction", async () => {
  const f = setup();
  expect(await f.consumer.consume(f.tx, f.event)).toEqual({ status: "processed" });
  const generation = f.calls.find(({ sql }) =>
    sql.startsWith("INSERT INTO rms_ordering.order_status_projection_generation"),
  );
  expect(decodeOrderStatusSnapshot(generation?.values[13]).batches).toHaveLength(2);
  expect(initialHistory.mock.calls[0]?.[0]).toBe(f.tx);
  expect(f.calls.some(({ sql }) => sql.startsWith("SELECT r.revision_id"))).toBe(true);
  const pointer = f.calls.findIndex(({ sql }) =>
    sql.startsWith("INSERT INTO rms_ordering.order_status_projection ("),
  );
  const complete = f.calls.findIndex(({ sql }) =>
    sql.startsWith("UPDATE platform_eventing.consumer_inbox"),
  );
  expect(pointer).toBeGreaterThan(-1);
  expect(complete).toBeGreaterThan(pointer);
});
it("rolls back projection and consumer savepoints if current pointer cannot advance", async () => {
  const f = setup(true);
  await expect(f.consumer.consume(f.tx, f.event)).rejects.toThrow();
  expect(
    f.calls.some(({ sql }) => sql === "ROLLBACK TO SAVEPOINT ordering_status_projection"),
  ).toBe(true);
  expect(f.calls.at(-2)?.sql).toBe("ROLLBACK TO SAVEPOINT ordering_submitted_projection_consumer");
  expect(f.calls.some(({ sql }) => sql.startsWith("UPDATE platform_eventing.consumer_inbox"))).toBe(
    false,
  );
});

it("does not complete Inbox or write projection when actual revision evidence has a gap", async () => {
  const f = setup();
  f.revisions.splice(1, 1);
  await expect(f.consumer.consume(f.tx, f.event)).rejects.toThrow();
  expect(
    f.calls.some(({ sql }) => sql.startsWith("INSERT INTO rms_ordering.order_status_projection")),
  ).toBe(false);
  expect(f.calls.some(({ sql }) => sql.startsWith("UPDATE platform_eventing.consumer_inbox"))).toBe(
    false,
  );
  expect(f.calls.at(-2)?.sql).toBe("ROLLBACK TO SAVEPOINT ordering_submitted_projection_consumer");
});

it("accepts the existing worker generic-envelope service contract", async () => {
  const f = setup();
  const entry: {
    consume(
      transaction: ConsumerTransaction,
      envelope: DomainEventEnvelope,
    ): Promise<ConsumerOutcome>;
  } = f.consumer;
  expect(await entry.consume(f.tx, f.event)).toEqual({ status: "processed" });
});
it("rejects a different event type before executing owner SQL", () => {
  const f = setup();
  expect(() => f.consumer.consume(f.tx, { ...f.event, eventType: "OrderCreated" })).toThrow();
  expect(f.calls).toHaveLength(0);
});

it.each(["newer", "missing", "different"])(
  "does not publish old submission when current owner evidence is %s",
  async (mode) => {
    const f = setup();
    if (mode === "newer") f.latest.version = 4;
    if (mode === "missing") f.latest.snapshot = null;
    if (mode === "different") f.latest.kind = "Acceptance";
    await expect(f.consumer.consume(f.tx, f.event)).rejects.toThrow();
    expect(
      f.calls.some(({ sql }) => sql.startsWith("INSERT INTO rms_ordering.order_status_projection")),
    ).toBe(false);
    expect(
      f.calls.some(({ sql }) => sql.startsWith("UPDATE platform_eventing.consumer_inbox")),
    ).toBe(false);
  },
);

it("persists delayed exact history as Stale after a newer acceptance", async () => {
  const f = setup(false, "Stale");
  f.latest.version = 4;
  f.latest.kind = "Acceptance";
  f.latest.snapshot = null;
  expect(await f.consumer.consume(f.tx, f.event)).toEqual({ status: "processed" });
  const generation = f.calls.find(({ sql }) =>
    sql.startsWith("INSERT INTO rms_ordering.order_status_projection_generation"),
  );
  expect(generation?.values).toContain("Stale");
});
it("rejects a stale classification when the source is still current", async () => {
  const f = setup(false, "Stale");
  await expect(f.consumer.consume(f.tx, f.event)).rejects.toThrow();
});
it("rejects missing durable event evidence before publishing", async () => {
  const f = setup();
  outbox.mockResolvedValue(null);
  await expect(f.consumer.consume(f.tx, f.event)).rejects.toThrow();
  expect(
    f.calls.some(({ sql }) => sql.startsWith("INSERT INTO rms_ordering.order_status_projection")),
  ).toBe(false);
});
