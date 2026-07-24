import { describe, expect, it, vi } from "vitest";
import {
  ConsumerRegistry,
  ConsumerTransactionRollback,
  type DomainEventEnvelope,
} from "@bop/eventing";
import { ConsumerDeliveryWorker } from "./consumer-delivery.js";

const envelope = {
  eventId: "018f1f48-7b5d-7cc1-8a1b-123456789abc",
  eventType: "SyntheticChanged",
  schemaVersion: 1,
  occurredAt: "2026-07-23T12:00:00.000Z",
  producerModule: "@bop/eventing",
  tenantId: "018f1f48-7b5d-7cc2-8a1b-123456789abc",
  aggregateType: "Synthetic",
  aggregateId: "018f1f48-7b5d-7cc3-8a1b-123456789abc",
  aggregateVersion: 1n,
  correlationId: "018f1f48-7b5d-7cc4-8a1b-123456789abc",
  actor: { type: "System" },
  payload: {},
  redactionClassification: "none",
  replayMetadata: {},
} satisfies DomainEventEnvelope;

describe("ConsumerDeliveryWorker", () => {
  it("rejects unknown consumers before starting a transaction", async () => {
    const transaction = vi.fn();
    const worker = new ConsumerDeliveryWorker({
      database: { transaction },
      registry: new ConsumerRegistry([]),
    });
    await expect(worker.deliver("unknown:v1", envelope)).resolves.toEqual({
      status: "rejected",
      errorCode: "CONSUMER_UNKNOWN",
    });
    expect(transaction).not.toHaveBeenCalled();
  });

  it("maps the stable rollback signal only after the database transaction rejects", async () => {
    const outcome = {
      status: "retry_required" as const,
      errorCode: "AGGREGATE_ORDER_GAP" as const,
    };
    const worker = new ConsumerDeliveryWorker({
      database: {
        transaction: vi.fn(async () => {
          throw new ConsumerTransactionRollback(outcome);
        }),
      },
      registry: new ConsumerRegistry([
        {
          consumerName: "synthetic.projector:v1",
          consumerVersion: 1,
          eventType: "SyntheticChanged",
          schemaVersions: [1],
          ownerModule: "@bop/eventing",
          tenantScope: "brand",
          ordering: "aggregate",
          sideEffect: "synthetic-effect",
          replaySafe: true,
          handler: vi.fn(async () => outcome),
        },
      ]),
    });
    await expect(worker.deliver("synthetic.projector:v1", envelope)).resolves.toEqual(outcome);
  });
});
