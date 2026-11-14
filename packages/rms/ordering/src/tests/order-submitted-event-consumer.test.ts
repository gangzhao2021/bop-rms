import { expect, it, vi } from "vitest";
import type { ConsumerTransaction } from "@bop/eventing";
import { additionalSourceFixture } from "./order-status-additional-source.fixture.js";
import { createOrderStatusAdditionalSource } from "../application/order-status-additional-source.js";
import { createOrderSubmittedEventConsumerService } from "../application/order-submitted-event-consumer-service.js";
import { parseOrderSubmittedEnvelope } from "../application/order-submitted-event.js";
import {
  buildOrderStatusProjection,
  type OrderStatusProjection,
} from "../domain/order-status-projection.js";
function setup() {
  const f = additionalSourceFixture();
  const event = parseOrderSubmittedEnvelope(f.envelope);
  const source = createOrderStatusAdditionalSource(f);
  const sql: string[] = [];
  let duplicate = false;
  const tx: ConsumerTransaction = {
    async query<Row = Record<string, unknown>>(text: string) {
      sql.push(text);
      const rows = text.startsWith("SELECT event_type")
        ? [
            {
              event_type: event.eventType,
              schema_version: 1,
              brand_id: event.tenantId,
              store_id: event.storeId,
              status: "completed",
            },
          ]
        : [];
      return { rowCount: duplicate && text.startsWith("INSERT") ? 0 : 1, rows: rows as Row[] };
    },
  };
  const load = vi.fn().mockResolvedValue(null);
  const replace = vi.fn(
    async ({ projection }: { projection: OrderStatusProjection }) => projection,
  );
  const authorize = vi.fn().mockResolvedValue(true);
  const loadExact = vi.fn().mockResolvedValue(source);
  const service = createOrderSubmittedEventConsumerService({
    authorization: { authorize },
    source: { loadExact, freshness: async () => "Fresh" },
    projections: { load, replace },
    references: { generateGeneration: () => event.eventId, now: () => source.submittedAt },
  });
  return {
    event,
    source,
    tx,
    sql,
    load,
    replace,
    authorize,
    loadExact,
    service,
    duplicate: () => {
      duplicate = true;
    },
  };
}
it("consumes through actual Inbox and preserves both Batch summaries", async () => {
  const f = setup();
  expect(await f.service.consume(f.tx, f.event)).toEqual({ status: "processed" });
  expect(f.replace.mock.calls[0]?.[0].projection.snapshot.batches).toHaveLength(2);
  expect(f.loadExact.mock.calls[0]?.[0].transaction).toBe(f.tx);
  expect(f.sql.some((sql) => sql.startsWith("UPDATE platform_eventing.consumer_inbox"))).toBe(true);
});
it("does not replace projection again for completed Inbox duplicate", async () => {
  const f = setup();
  f.duplicate();
  expect(await f.service.consume(f.tx, f.event)).toEqual({ status: "duplicate_completed" });
  expect(f.replace).not.toHaveBeenCalled();
  expect(f.authorize).toHaveBeenCalledTimes(2);
});
it("rolls back Inbox when exact owner history is not yet available", async () => {
  const f = setup();
  f.loadExact.mockResolvedValue(null);
  await expect(f.service.consume(f.tx, f.event)).rejects.toThrow();
  expect(f.replace).not.toHaveBeenCalled();
  expect(f.sql.at(-2)).toBe("ROLLBACK TO SAVEPOINT ordering_submitted_projection_consumer");
});
it("does not replace a newer projection with a delayed event", async () => {
  const f = setup();
  f.load.mockResolvedValue(
    buildOrderStatusProjection({
      source: {
        ...f.source,
        sourceVersion: 4,
        sourceCheckpoint: "0190ed31-0000-7000-8000-000000000099",
      },
      generationReference: f.event.eventId,
      projectedAt: f.source.submittedAt,
    }),
  );
  expect(await f.service.consume(f.tx, f.event)).toEqual({ status: "processed" });
  expect(f.replace).not.toHaveBeenCalled();
});
it("rolls back projection and Inbox if authorization is revoked before completion", async () => {
  const f = setup();
  f.authorize.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  await expect(f.service.consume(f.tx, f.event)).rejects.toThrow();
  expect(f.sql.at(-2)).toBe("ROLLBACK TO SAVEPOINT ordering_submitted_projection_consumer");
});

it("rejects conflicting facts at the same projection version", async () => {
  const f = setup();
  f.load.mockResolvedValue(
    buildOrderStatusProjection({
      source: { ...f.source, sourceDigest: "sha256:" + "c".repeat(64) },
      generationReference: f.event.eventId,
      projectedAt: f.source.submittedAt,
    }),
  );
  await expect(f.service.consume(f.tx, f.event)).rejects.toThrow();
  expect(f.replace).not.toHaveBeenCalled();
});
