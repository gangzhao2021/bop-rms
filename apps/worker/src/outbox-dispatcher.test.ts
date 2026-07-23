import { describe, expect, it, vi } from "vitest";
import type { ClaimedOutboxEvent, DomainEventEnvelope } from "@bop/eventing";
import { OutboxDispatcher, type AuthorizedDispatchScope } from "./outbox-dispatcher.js";

const id = (suffix: string) => `018f1f48-7b5d-7cc${suffix}-8a1b-123456789abc`;
const envelope: DomainEventEnvelope = {
  eventId: id("0"),
  eventType: "SyntheticChanged",
  schemaVersion: 1,
  occurredAt: "2026-07-23T12:00:00.000Z",
  producerModule: "@bop/eventing",
  tenantId: id("1"),
  aggregateType: "SyntheticAggregate",
  aggregateId: id("2"),
  aggregateVersion: 1n,
  correlationId: id("3"),
  actor: { type: "System" },
  payload: {},
  redactionClassification: "none",
  replayMetadata: {},
};
const claimed: ClaimedOutboxEvent = {
  attemptCount: 1,
  envelope,
  leaseExpiresAt: "2026-07-23T12:00:30.000Z",
  leaseToken: id("4"),
};
const brandScope: AuthorizedDispatchScope = { brandId: id("1") };
const scopes: readonly AuthorizedDispatchScope[] = [
  brandScope,
  { brandId: id("5"), storeId: id("6") },
];

describe("OutboxDispatcher", () => {
  it("rotates authorized scopes and applies per-scope bounds", async () => {
    const claim = vi.fn().mockResolvedValue([]);
    const dependencies = {
      adapter: { publish: vi.fn() },
      dispatch: { claim, complete: vi.fn(), fail: vi.fn() },
      leaseOwner: "synthetic_worker",
      newLeaseToken: () => id("4"),
      scopes,
    };
    const dispatcher = new OutboxDispatcher(dependencies);
    await dispatcher.runOnce();
    await dispatcher.runOnce();
    expect(claim.mock.calls.map(([scope]) => scope)).toEqual([
      scopes[0],
      scopes[1],
      scopes[1],
      scopes[0],
    ]);
    expect(claim.mock.calls.every(([, input]) => input.batchSize === 25)).toBe(true);
  });

  it("marks success only after acknowledgement", async () => {
    const order: string[] = [];
    const dispatcher = new OutboxDispatcher({
      adapter: {
        publish: vi.fn(async () => {
          order.push("acknowledged");
          return { status: "acknowledged" } as const;
        }),
      },
      dispatch: {
        claim: vi.fn().mockResolvedValueOnce([claimed]).mockResolvedValue([]),
        complete: vi.fn(async () => {
          order.push("completed");
          return "completed" as const;
        }),
        fail: vi.fn(),
      },
      leaseOwner: "synthetic_worker",
      newLeaseToken: () => id("4"),
      scopes: [brandScope],
    });
    expect(await dispatcher.runOnce()).toBe(1);
    expect(order).toEqual(["acknowledged", "completed"]);
  });

  it("parks typed failures without exposing thrown details", async () => {
    const fail = vi.fn().mockResolvedValue("completed");
    const telemetry = { record: vi.fn() };
    const dispatcher = new OutboxDispatcher({
      adapter: {
        publish: vi.fn().mockRejectedValue(new Error("secret payload must not escape")),
      },
      dispatch: {
        claim: vi.fn().mockResolvedValue([claimed]),
        complete: vi.fn(),
        fail,
      },
      leaseOwner: "synthetic_worker",
      newLeaseToken: () => id("4"),
      scopes: [brandScope],
      telemetry,
    });
    await dispatcher.runOnce();
    expect(fail).toHaveBeenCalledWith(scopes[0], {
      errorCode: "TRANSPORT_UNAVAILABLE",
      eventId: envelope.eventId,
      leaseToken: claimed.leaseToken,
    });
    expect(JSON.stringify(telemetry.record.mock.calls)).not.toContain("secret payload");
  });

  it("propagates a stable persistence failure after acknowledgement", async () => {
    const dispatcher = new OutboxDispatcher({
      adapter: { publish: vi.fn().mockResolvedValue({ status: "acknowledged" }) },
      dispatch: {
        claim: vi.fn().mockResolvedValue([claimed]),
        complete: vi.fn().mockRejectedValue(new Error("database endpoint secret")),
        fail: vi.fn(),
      },
      leaseOwner: "synthetic_worker",
      newLeaseToken: () => id("4"),
      scopes: [brandScope],
    });
    await expect(dispatcher.runOnce()).rejects.toThrow("OUTBOX_DISPATCH_PERSISTENCE_FAILED");
  });

  it("stops new claims and drains in-flight work", async () => {
    let acknowledge!: () => void;
    const pending = new Promise<void>((resolve) => {
      acknowledge = resolve;
    });
    const claim = vi.fn().mockResolvedValue([claimed]);
    const dispatcher = new OutboxDispatcher({
      adapter: {
        publish: async () => {
          await pending;
          return { status: "acknowledged" };
        },
      },
      dispatch: {
        claim,
        complete: vi.fn().mockResolvedValue("completed"),
        fail: vi.fn(),
      },
      leaseOwner: "synthetic_worker",
      newLeaseToken: () => id("4"),
      scopes: [brandScope],
    });
    const running = dispatcher.runOnce();
    await vi.waitFor(() => expect(dispatcher.inFlight).toBe(1));
    const stopping = dispatcher.stop();
    expect(await dispatcher.runOnce()).toBe(0);
    acknowledge();
    await running;
    expect(await stopping).toBe("drained");
    expect(claim).toHaveBeenCalledOnce();
  });

  it("rejects unsafe configuration and an empty scope list", () => {
    const dependencies = {
      adapter: { publish: vi.fn() },
      dispatch: { claim: vi.fn(), complete: vi.fn(), fail: vi.fn() },
      leaseOwner: "synthetic_worker",
      newLeaseToken: () => id("4"),
      scopes: [],
    };
    expect(() => new OutboxDispatcher(dependencies)).toThrow("at least one scope");
    expect(
      () => new OutboxDispatcher({ ...dependencies, scopes }, { adapterTimeoutMs: 30_000 }),
    ).toThrow("adapterTimeoutMs");
  });
});
