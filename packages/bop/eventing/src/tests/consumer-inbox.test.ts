import { describe, expect, it, vi } from "vitest";
import {
  ConsumerRegistry,
  ConsumerTransactionRollback,
  InvalidConsumerRegistryError,
  consumeEventInTransaction,
  type ConsumerRegistration,
  type ConsumerTransaction,
  type DomainEventEnvelope,
} from "../index.js";

const envelope: DomainEventEnvelope = {
  eventId: "018f1f48-7b5d-7cc1-8a1b-123456789abc",
  eventType: "SyntheticChanged",
  schemaVersion: 1,
  occurredAt: "2026-07-23T12:00:00.000Z",
  producerModule: "@bop/eventing",
  tenantId: "018f1f48-7b5d-7cc2-8a1b-123456789abc",
  storeId: "018f1f48-7b5d-7cc3-8a1b-123456789abc",
  aggregateType: "Synthetic",
  aggregateId: "018f1f48-7b5d-7cc4-8a1b-123456789abc",
  aggregateVersion: 1n,
  correlationId: "018f1f48-7b5d-7cc5-8a1b-123456789abc",
  actor: { type: "System" },
  payload: { sentinel: "synthetic" },
  redactionClassification: "none",
  replayMetadata: {},
};
const registration = (
  handler: ConsumerRegistration["handler"] = vi.fn(async () => undefined),
): ConsumerRegistration => ({
  consumerName: "synthetic.projector:v1",
  consumerVersion: 1,
  eventType: "SyntheticChanged",
  schemaVersions: [1],
  ownerModule: "@bop/eventing",
  tenantScope: "store",
  ordering: "none",
  sideEffect: "synthetic-effect",
  replaySafe: true,
  handler,
});

describe("consumer registry", () => {
  it("fails closed for duplicate and unsupported declarations", () => {
    const item = registration();
    expect(() => new ConsumerRegistry([item, item])).toThrow(InvalidConsumerRegistryError);
    const registry = new ConsumerRegistry([item]);
    expect(registry.resolve("missing:v1", envelope)).toEqual({ errorCode: "CONSUMER_UNKNOWN" });
    expect(registry.resolve(item.consumerName, { ...envelope, schemaVersion: 2 })).toEqual({
      errorCode: "EVENT_SCHEMA_VERSION_UNSUPPORTED",
    });
  });

  it.each([
    ["consumer version identity", { consumerVersion: 2 }],
    ["tenant scope", { tenantScope: "all" }],
    ["ordering", { ordering: "global" }],
    ["replay declaration", { replaySafe: "yes" }],
    ["handler", { handler: null }],
    ["schema versions", { schemaVersions: "1" }],
  ])("rejects an invalid %s declaration before startup", (_label, replacement) => {
    expect(
      () =>
        new ConsumerRegistry([
          { ...registration(), ...replacement } as unknown as ConsumerRegistration,
        ]),
    ).toThrow(InvalidConsumerRegistryError);
  });
});

describe("consumer inbox coordinator", () => {
  it("inserts, invokes the handler, and completes without serializing payload", async () => {
    const handler = vi.fn(async () => undefined);
    const statements: string[] = [];
    const transaction = {
      query: vi.fn(async (sql: string) => {
        statements.push(sql);
        return { rowCount: 1, rows: [{ consumer_name: "synthetic.projector:v1" }] };
      }),
    };
    await expect(
      consumeEventInTransaction(
        transaction as ConsumerTransaction,
        registration(handler),
        envelope,
      ),
    ).resolves.toEqual({ status: "processed" });
    expect(handler).toHaveBeenCalledOnce();
    expect(statements.join("\n")).not.toContain("payload");
  });

  it("returns completed duplicates without invoking the handler", async () => {
    const handler = vi.fn(async () => undefined);
    const transaction = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rowCount: 0, rows: [] })
        .mockResolvedValueOnce({
          rowCount: 1,
          rows: [
            {
              event_type: envelope.eventType,
              schema_version: envelope.schemaVersion,
              brand_id: envelope.tenantId,
              store_id: envelope.storeId,
              status: "completed",
            },
          ],
        }),
    };
    await expect(
      consumeEventInTransaction(
        transaction as ConsumerTransaction,
        registration(handler),
        envelope,
      ),
    ).resolves.toEqual({ status: "duplicate_completed" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("returns ordering gaps without completing the transaction-local marker", async () => {
    const handler = vi.fn(async () => ({
      status: "retry_required" as const,
      errorCode: "AGGREGATE_ORDER_GAP" as const,
    }));
    const transaction = {
      query: vi.fn(async () => ({ rowCount: 1, rows: [{}] })),
    };
    await expect(
      consumeEventInTransaction(
        transaction as ConsumerTransaction,
        registration(handler),
        envelope,
      ),
    ).rejects.toEqual(
      new ConsumerTransactionRollback({
        status: "retry_required",
        errorCode: "AGGREGATE_ORDER_GAP",
      }),
    );
    expect(transaction.query).toHaveBeenCalledTimes(1);
  });
});
