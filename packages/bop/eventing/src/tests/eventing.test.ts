import { describe, expect, it, vi } from "vitest";
import {
  appendEventInTransaction,
  InvalidDomainEventEnvelopeError,
  validateDomainEventEnvelope,
  type DomainEventEnvelope,
} from "../index.js";

const id = (suffix: string) => `018f1f48-7b5d-7cc${suffix}-8a1b-123456789abc`;
const envelope: DomainEventEnvelope = {
  eventId: id("0"),
  eventType: "SyntheticChanged",
  schemaVersion: 1,
  occurredAt: "2026-07-23T12:00:00.000Z",
  producerModule: "@bop/eventing",
  tenantId: id("1"),
  storeId: id("2"),
  aggregateType: "SyntheticAggregate",
  aggregateId: id("3"),
  aggregateVersion: 1n,
  correlationId: id("4"),
  actor: { type: "System" },
  payload: { aggregateId: id("3") },
  redactionClassification: "none",
  replayMetadata: { source: "synthetic-contract-test" },
};

describe("Domain Event Envelope", () => {
  it("accepts the exact pre-publication contract", () => {
    expect(validateDomainEventEnvelope(envelope)).toBe(envelope);
  });

  it.each([
    ["eventId", { eventId: "not-an-id" }],
    ["eventType", { eventType: "rms.ordering.SyntheticChanged" }],
    ["schemaVersion", { schemaVersion: 0 }],
    ["occurredAt", { occurredAt: "2026-07-23T12:00:00-04:00" }],
    ["producerModule", { producerModule: "@other/module" }],
    ["aggregateVersion", { aggregateVersion: 1 }],
    ["actor", { actor: null }],
    ["payload", { payload: [] }],
    ["replayMetadata", { replayMetadata: [] }],
  ])("rejects invalid %s", (field, replacement) => {
    expect(() =>
      validateDomainEventEnvelope({ ...envelope, ...replacement } as DomainEventEnvelope),
    ).toThrow(InvalidDomainEventEnvelopeError);
    try {
      validateDomainEventEnvelope({ ...envelope, ...replacement } as DomainEventEnvelope);
    } catch (error) {
      expect((error as InvalidDomainEventEnvelopeError).field).toBe(field);
    }
  });

  it("uses one parameterized insert and leaves transaction control to the caller", async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1 });
    await appendEventInTransaction({ query }, envelope);
    expect(query).toHaveBeenCalledOnce();
    const [sql, values] = query.mock.calls[0] as [string, readonly unknown[]];
    expect(sql).toMatch(/^INSERT INTO platform_eventing\.outbox_event/u);
    expect(sql).not.toMatch(/\b(?:BEGIN|COMMIT|ROLLBACK)\b/iu);
    expect(sql).toContain("$18");
    expect(values).toHaveLength(18);
    expect(values).toContain(envelope.eventId);
    expect(sql).not.toContain(envelope.eventId);
  });
});
