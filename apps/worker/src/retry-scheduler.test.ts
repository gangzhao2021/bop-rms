import { describe, expect, it, vi } from "vitest";
import { ConsumerRetryScheduler } from "./retry-scheduler.js";

describe("ConsumerRetryScheduler", () => {
  it("uses the accepted bounded scope iteration and completes a duplicate safely", async () => {
    const complete = vi.fn(async () => "completed" as const);
    const scheduler = new ConsumerRetryScheduler({
      delivery: {
        deliver: vi.fn(async () => ({ status: "duplicate_completed" as const })),
      } as never,
      leaseOwner: "retry_worker",
      newLeaseToken: () => "018f1f48-7b5d-7aa1-8a1b-123456789abc",
      now: () => "2026-07-24T00:00:00.000Z",
      retries: {
        claim: vi
          .fn()
          .mockResolvedValueOnce([
            {
              scheduleId: "018f1f48-7b5d-7aa2-8a1b-123456789abc",
              eventId: "018f1f48-7b5d-7aa3-8a1b-123456789abc",
              consumerName: "synthetic.projector:v1",
              deadlineAt: "2026-07-25T00:00:00.000Z",
              attemptCount: 2,
              leaseToken: "018f1f48-7b5d-7aa1-8a1b-123456789abc",
              version: 1n,
            },
          ])
          .mockResolvedValue([]),
        complete,
        loadEnvelope: vi.fn(async () => ({
          eventId: "018f1f48-7b5d-7aa3-8a1b-123456789abc",
          eventType: "SyntheticChanged",
          schemaVersion: 1,
          occurredAt: "2026-07-24T00:00:00.000Z",
          producerModule: "@bop/eventing" as const,
          tenantId: "018f1f48-7b5d-7aa4-8a1b-123456789abc",
          aggregateType: "Synthetic",
          aggregateId: "018f1f48-7b5d-7aa5-8a1b-123456789abc",
          aggregateVersion: 1n,
          correlationId: "018f1f48-7b5d-7aa6-8a1b-123456789abc",
          actor: { type: "System" as const },
          payload: {},
          redactionClassification: "none" as const,
          replayMetadata: {},
        })),
      },
      scopes: [
        { brandId: "018f1f48-7b5d-7aa4-8a1b-123456789abc" },
        { brandId: "018f1f48-7b5d-7aa7-8a1b-123456789abc" },
      ],
    });
    await expect(scheduler.runOnce()).resolves.toBe(1);
    expect(complete).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ outcome: "completed", expectedVersion: 1n }),
    );
  });

  it("dead-letters an expired schedule without another handoff", async () => {
    const deliver = vi.fn();
    const recordDeferredFailure = vi.fn(async () => undefined);
    const loadEnvelope = vi.fn();
    const scheduler = new ConsumerRetryScheduler({
      delivery: { deliver, recordDeferredFailure } as never,
      leaseOwner: "retry_worker",
      newLeaseToken: () => "018f1f48-7b5d-7aa1-8a1b-123456789abc",
      now: () => "2026-07-25T00:00:00.000Z",
      retries: {
        claim: vi.fn(async () => [
          {
            scheduleId: "018f1f48-7b5d-7aa2-8a1b-123456789abc",
            eventId: "018f1f48-7b5d-7aa3-8a1b-123456789abc",
            consumerName: "synthetic.projector:v1",
            deadlineAt: "2026-07-25T00:00:00.000Z",
            attemptCount: 7,
            leaseToken: "018f1f48-7b5d-7aa1-8a1b-123456789abc",
            version: 1n,
          },
        ]),
        complete: vi.fn(),
        loadEnvelope,
      },
      scopes: [{ brandId: "018f1f48-7b5d-7aa4-8a1b-123456789abc" }],
    });

    await expect(scheduler.runOnce()).resolves.toBe(1);
    expect(deliver).not.toHaveBeenCalled();
    expect(loadEnvelope).not.toHaveBeenCalled();
    expect(recordDeferredFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        attemptNumber: 7,
        errorCode: "CONSUMER_TEMPORARY_FAILURE",
        firstAttemptAt: "2026-07-24T00:00:00.000Z",
      }),
    );
  });

  it("fails closed when the retained envelope cannot be loaded", async () => {
    const recordDeferredFailure = vi.fn(async () => undefined);
    const scheduler = new ConsumerRetryScheduler({
      delivery: { deliver: vi.fn(), recordDeferredFailure } as never,
      leaseOwner: "retry_worker",
      newLeaseToken: () => "018f1f48-7b5d-7aa1-8a1b-123456789abc",
      now: () => "2026-07-24T00:00:00.000Z",
      retries: {
        claim: vi.fn(async () => [
          {
            scheduleId: "018f1f48-7b5d-7aa2-8a1b-123456789abc",
            eventId: "018f1f48-7b5d-7aa3-8a1b-123456789abc",
            consumerName: "synthetic.projector:v1",
            deadlineAt: "2026-07-25T00:00:00.000Z",
            attemptCount: 2,
            leaseToken: "018f1f48-7b5d-7aa1-8a1b-123456789abc",
            version: 1n,
          },
        ]),
        complete: vi.fn(),
        loadEnvelope: vi.fn(async () => null),
      },
      scopes: [{ brandId: "018f1f48-7b5d-7aa4-8a1b-123456789abc" }],
    });

    await expect(scheduler.runOnce()).resolves.toBe(1);
    expect(recordDeferredFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        attemptNumber: 2,
        errorCode: "EVENT_TYPE_UNSUPPORTED",
      }),
    );
  });
});
