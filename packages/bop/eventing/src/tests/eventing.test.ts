import { describe, expect, it, vi } from "vitest";
import {
  appendEventInTransaction,
  claimOutboxBatch,
  InvalidDomainEventEnvelopeError,
  markOutboxFailed,
  markOutboxPublished,
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

  it("rejects unknown envelope and Actor fields without inspecting their values", () => {
    expect(() =>
      validateDomainEventEnvelope({
        ...envelope,
        credential: "synthetic-forbidden",
      } as DomainEventEnvelope),
    ).toThrowError(new InvalidDomainEventEnvelopeError("envelope"));
    expect(() =>
      validateDomainEventEnvelope({
        ...envelope,
        actor: { type: "System", actorId: id("5") },
      } as DomainEventEnvelope),
    ).toThrowError(new InvalidDomainEventEnvelopeError("actor"));
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

describe("Outbox dispatch persistence", () => {
  const claimedRow = {
    event_id: envelope.eventId,
    event_type: envelope.eventType,
    schema_version: envelope.schemaVersion,
    occurred_at: envelope.occurredAt,
    producer_module: envelope.producerModule,
    brand_id: envelope.tenantId,
    store_id: envelope.storeId ?? null,
    aggregate_type: envelope.aggregateType,
    aggregate_id: envelope.aggregateId,
    aggregate_version: envelope.aggregateVersion.toString(),
    correlation_id: envelope.correlationId,
    causation_id: null,
    actor_type: "System",
    actor_id: null,
    payload_json: envelope.payload,
    redaction_classification: envelope.redactionClassification,
    replay_metadata_json: envelope.replayMetadata,
    attempt_count: 1,
    lease_expires_at: "2026-07-23T12:00:30.000Z",
    lease_token: id("5"),
  } as const;

  it("claims a bounded parameterized SKIP LOCKED batch and reconstructs the envelope", async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1, rows: [claimedRow] });
    const result = await claimOutboxBatch(
      { query },
      {
        batchSize: 25,
        leaseDurationSeconds: 30,
        leaseOwner: "synthetic_worker",
        leaseToken: id("5"),
      },
    );
    expect(result).toEqual([
      {
        attemptCount: 1,
        envelope,
        leaseExpiresAt: "2026-07-23T12:00:30.000Z",
        leaseToken: id("5"),
      },
    ]);
    const [sql, values] = query.mock.calls[0] as [string, readonly unknown[]];
    expect(sql).toContain("FOR UPDATE OF candidate SKIP LOCKED");
    expect(sql).toContain("earlier.aggregate_version");
    expect(sql).not.toContain(envelope.eventId);
    expect(values).toEqual([25, id("5"), "synthetic_worker", 30]);
  });

  it("conditionally completes and parks only the matching lease", async () => {
    const completedQuery = vi.fn().mockResolvedValue({ rowCount: 1, rows: [] });
    await expect(
      markOutboxPublished(
        { query: completedQuery },
        { eventId: envelope.eventId, leaseToken: id("5") },
      ),
    ).resolves.toBe("completed");
    expect(completedQuery.mock.calls[0]?.[0]).toContain("lease_token = $2");
    const lostQuery = vi.fn().mockResolvedValue({ rowCount: 0, rows: [] });
    await expect(
      markOutboxFailed(
        { query: lostQuery },
        {
          errorCode: "TRANSPORT_TIMEOUT",
          eventId: envelope.eventId,
          leaseToken: id("5"),
        },
      ),
    ).resolves.toBe("lost_lease");
    expect(lostQuery.mock.calls[0]?.[1]).toEqual([envelope.eventId, id("5"), "TRANSPORT_TIMEOUT"]);
  });

  it("rejects unsafe lease inputs and unbounded batches", async () => {
    const query = vi.fn();
    await expect(
      claimOutboxBatch(
        { query },
        {
          batchSize: 101,
          leaseDurationSeconds: 30,
          leaseOwner: "synthetic_worker",
          leaseToken: id("5"),
        },
      ),
    ).rejects.toThrow("batchSize");
    await expect(
      claimOutboxBatch(
        { query },
        {
          batchSize: 25,
          leaseDurationSeconds: 30,
          leaseOwner: "host.name.example",
          leaseToken: id("5"),
        },
      ),
    ).rejects.toThrow("leaseOwner");
    expect(query).not.toHaveBeenCalled();
  });
});
