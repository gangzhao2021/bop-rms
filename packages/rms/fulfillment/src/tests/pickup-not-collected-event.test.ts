import { describe, expect, it, vi } from "vitest";
import { createPickupNotCollectedEvent } from "../application/pickup-not-collected-event.js";
import {
  appendPickupNotCollectedPublication,
  createPostgresPickupNotCollectedPublisher,
} from "../infrastructure/persistence/pickup-not-collected-publication-store.js";
import { PickupHandoffError } from "../domain/pickup-handoff.js";

const id = (n: number) => "0190fa38-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const input = {
  eventReference: id(1),
  brandReference: id(2),
  storeReference: id(3),
  fulfillmentReference: id(4),
  orderReference: id(5),
  notCollectedReference: id(6),
  correlationReference: id(7),
  aggregateVersionBefore: 3n,
  readyAt: "2026-10-09T04:00:00.000Z",
  closedAt: "2026-10-09T05:04:00.000Z",
};

describe("WP-2423 / DEC-PILOT-BATCH-PHASE-01 PickupNotCollected", () => {
  it("publishes references and times only, as the Fulfillment aggregate's next version", () => {
    expect(createPickupNotCollectedEvent(input)).toEqual({
      eventId: id(1),
      eventType: "PickupNotCollected",
      schemaVersion: 1,
      occurredAt: input.closedAt,
      producerModule: "@rms/fulfillment",
      tenantId: id(2),
      storeId: id(3),
      aggregateType: "Fulfillment",
      aggregateId: id(4),
      aggregateVersion: 4n,
      correlationId: id(7),
      causationId: id(6),
      actor: { type: "System" },
      payload: {
        fulfillmentReference: id(4),
        orderReference: id(5),
        notCollectedReference: id(6),
        storeReference: id(3),
        readyAt: input.readyAt,
        closedAt: input.closedAt,
      },
      redactionClassification: "indirect_identifier",
      replayMetadata: { replaySafe: true },
    });
  });
  it("refuses reused identities, a closure before ready and an invalid version", () => {
    for (const bad of [
      { ...input, eventReference: id(4) },
      { ...input, orderReference: id(6) },
      { ...input, readyAt: "2026-10-09T05:05:00.000Z" },
      { ...input, aggregateVersionBefore: 0n },
      { ...input, closedAt: "2026-10-09" },
    ])
      expect(() => createPickupNotCollectedEvent(bad)).toThrow(PickupHandoffError);
  });
  it("records the publication and appends the event in the same transaction", async () => {
    const query = vi.fn<(sql: string, values: readonly unknown[]) => Promise<object>>(async () => ({
      rowCount: 1,
      rows: [],
    }));
    await appendPickupNotCollectedPublication({ query } as never, input);
    expect(query.mock.calls.map((call) => String(call[0]).slice(0, 60))).toEqual([
      expect.stringContaining("INSERT INTO rms_fulfillment.pickup_not_collected_publication"),
      expect.stringContaining("INSERT INTO platform_eventing.outbox_event"),
    ]);
    expect(query.mock.calls[0]?.[1]).toEqual([
      id(6),
      id(2),
      id(3),
      id(4),
      id(5),
      id(1),
      input.closedAt,
    ]);
  });
  it("catch-up publishes each closure without a publication, with a fresh event reference", async () => {
    const references = [id(20), id(21)];
    const query = vi.fn<(sql: string, values?: readonly unknown[]) => Promise<object>>(
      async (sql) =>
        sql.startsWith("SELECT n.")
          ? {
              rowCount: 1,
              rows: [
                {
                  pickup_not_collected_id: id(6),
                  fulfillment_id: id(4),
                  order_id: id(5),
                  correlation_id: id(7),
                  aggregate_version_before: "3",
                  ready_at: new Date(input.readyAt),
                  closed_at: new Date(input.closedAt),
                },
              ],
            }
          : { rowCount: 1, rows: [] },
    );
    const publisher = createPostgresPickupNotCollectedPublisher({
      brandReference: id(2),
      storeReference: id(3),
      nextReference: () => references.shift() as string,
    });
    expect(await publisher.publishMissing({ query } as never)).toEqual([id(20)]);
    expect(String(query.mock.calls[1]?.[0])).toContain("NOT EXISTS");
  });
});
