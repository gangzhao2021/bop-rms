import { describe, expect, it, vi } from "vitest";
import type { ConsumerRegistration, ConsumerTransaction } from "../contracts/consumer-inbox.js";
import type { DomainEventEnvelope } from "../contracts/domain-event-envelope.js";
import { createManualOutboxRecoveryRegistry } from "../infrastructure/messaging/manual-outbox-recovery-registry.js";
const id = (n: number) => `0190fab5-0000-7000-8000-${String(n).padStart(12, "0")}`;
const event: DomainEventEnvelope = {
  eventId: id(1),
  eventType: "SyntheticChanged",
  schemaVersion: 1,
  occurredAt: "2026-09-20T14:00:00.000Z",
  producerModule: "@bop/eventing",
  tenantId: id(2),
  storeId: id(3),
  aggregateType: "SyntheticAggregate",
  aggregateId: id(4),
  aggregateVersion: 1n,
  correlationId: id(5),
  actor: { type: "System" },
  payload: {},
  redactionClassification: "none",
  replayMetadata: {},
};
const registration = (consumerName: string): ConsumerRegistration => ({
  consumerName,
  consumerVersion: 1,
  eventType: "SyntheticChanged",
  schemaVersions: [1],
  ownerModule: "@bop/eventing",
  tenantScope: "store",
  ordering: "aggregate",
  sideEffect: "synthetic_effect",
  replaySafe: true,
  handler: async () => ({ status: "completed" }),
});
const a = registration("synthetic.a:v1"),
  b = registration("synthetic.b:v1");
describe("manual recovery consumer registry", () => {
  it("binds immutable order-independent metadata", () => {
    const schemas = [1],
      source = { ...a, schemaVersions: schemas };
    const registry = createManualOutboxRecoveryRegistry([source, b]);
    expect(registry.digest).toBe(createManualOutboxRecoveryRegistry([b, a]).digest);
    schemas.push(2);
    expect(registry.registrations[0]?.schemaVersions).toEqual([1]);
    expect(
      createManualOutboxRecoveryRegistry([{ ...a, sideEffect: "changed_effect" }, b]).digest,
    ).not.toBe(registry.digest);
  });
  it("rejects non-replay-safe registration", () =>
    expect(() => createManualOutboxRecoveryRegistry([{ ...a, replaySafe: false }])).toThrow(
      "MANUAL_RECOVERY_REGISTRY_INVALID",
    ));
  it("requires all event registrations to support the exact schema", () => {
    const registry = createManualOutboxRecoveryRegistry([a, { ...b, schemaVersions: [2] }]);
    expect(() => registry.consumersFor(event)).toThrow("MANUAL_RECOVERY_REGISTRY_UNAVAILABLE");
  });
  it("rejects an unregistered event", () =>
    expect(() =>
      createManualOutboxRecoveryRegistry([a]).consumersFor({ ...event, eventType: "OtherEvent" }),
    ).toThrow("MANUAL_RECOVERY_REGISTRY_UNAVAILABLE"));
  it.each([
    [[], false],
    [["synthetic.a:v1"], false],
    [["synthetic.a:v1", "synthetic.a:v1"], false],
    [["synthetic.a:v1", "foreign:v1"], false],
    [["synthetic.b:v1", "synthetic.a:v1"], true],
  ] as const)("requires complete exact persisted receipts %#", async (names, expected) => {
    const query = vi.fn().mockResolvedValue({
      rows: names.map((consumer_name) => ({ consumer_name })),
      rowCount: names.length,
    });
    expect(
      await createManualOutboxRecoveryRegistry([a, b]).acknowledged(
        { query } as ConsumerTransaction,
        event,
      ),
    ).toBe(expected);
    expect(query.mock.calls[0]?.[1]).toEqual([
      event.eventId,
      event.tenantId,
      event.storeId,
      event.eventType,
      event.schemaVersion,
      event.correlationId,
      [a.consumerName, b.consumerName],
    ]);
  });
});
