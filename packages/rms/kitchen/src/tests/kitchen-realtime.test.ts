import { describe, expect, it, vi } from "vitest";

import {
  createKitchenRealtimeHint,
  createKitchenRealtimePublishResult,
  createKitchenRealtimeService,
  kitchenRealtimeMessageType,
  parseKitchenRealtimeHint,
  type KitchenRealtimePorts,
} from "../index.js";

const ids = {
  generation: "018f1f48-7b5d-7d01-8a1b-123456789001",
  brand: "018f1f48-7b5d-7d02-8a1b-123456789002",
  store: "018f1f48-7b5d-7d03-8a1b-123456789003",
  checkpoint: "018f1f48-7b5d-7d04-8a1b-123456789004",
  message1: "018f1f48-7b5d-7d05-8a1b-123456789005",
  message2: "018f1f48-7b5d-7d06-8a1b-123456789006",
} as const;

function generation(overrides: Record<string, unknown> = {}) {
  return {
    projectionGenerationReference: ids.generation,
    brandReference: ids.brand,
    storeReference: ids.store,
    projectionName: "kitchen_work_queue_v1",
    projectionVersion: 1,
    generationStatus: "Active",
    sourceCheckpointReference: ids.checkpoint,
    sourceEventBindingDigest: `sha256:${"a".repeat(64)}`,
    queueSnapshotDigest: `sha256:${"b".repeat(64)}`,
    ticketCount: 1,
    workItemCount: 1,
    initializedEmpty: false,
    asOfUtc: "2026-08-11T14:00:00.000Z",
    projectedAt: "2026-08-11T14:00:01.000Z",
    activationLagMs: 1000,
    lastRebuiltAt: null,
    freshnessStatus: "Fresh",
    rebuildReference: null,
    rebuildRequestDigest: null,
    rebuildRequestedAt: null,
    expectedPriorGenerationReference: null,
    ...overrides,
  };
}

function harness(options: { references?: readonly unknown[]; publisher?: unknown } = {}) {
  const references = [...(options.references ?? [ids.message1])];
  const published: unknown[] = [];
  const metrics: unknown[] = [];
  const ports: KitchenRealtimePorts = {
    references: {
      nextReference: vi.fn(() => references.shift()),
    },
    publisher: {
      publish: vi.fn(async (message) => {
        published.push(message);
        if (options.publisher instanceof Error) throw options.publisher;
        return options.publisher ?? 1;
      }),
    },
    metrics: { record: vi.fn((metric) => metrics.push(metric)) },
  };
  return {
    metrics,
    ports,
    published,
    service: createKitchenRealtimeService(ports),
  };
}

describe("WP-1405 Kitchen realtime", () => {
  it("publishes the exact minimal committed-generation hint", async () => {
    const test = harness();
    const result = await test.service.publishCommittedQueueActivation(generation());
    expect(result).toEqual({
      outcome: "Delivered",
      message: {
        messageId: ids.message1,
        type: kitchenRealtimeMessageType,
        version: 1,
        occurredAt: "2026-08-11T14:00:01.000Z",
        scope: { brandId: ids.brand, storeId: ids.store },
        resource: { type: "kitchenQueueGeneration", id: ids.generation },
        projectionVersion: 1,
      },
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.message)).toBe(true);
    expect(Object.isFrozen(result.message?.scope)).toBe(true);
    expect(Object.isFrozen(result.message?.resource)).toBe(true);
    expect(test.published).toHaveLength(1);
    expect(test.metrics).toEqual([{ operation: "publish", result: "delivered" }]);
  });

  it("treats zero subscribers as a successful lossy publication", async () => {
    const test = harness({ publisher: 0 });
    await expect(test.service.publishCommittedQueueActivation(generation())).resolves.toMatchObject(
      {
        outcome: "NoSubscribers",
        message: { messageId: ids.message1 },
      },
    );
    expect(test.metrics).toEqual([{ operation: "publish", result: "no_subscribers" }]);
  });

  it.each([new Error("offline"), -1, 1.5, "1", Number.NaN])(
    "fails safely for publisher result %p",
    async (publisher) => {
      const test = harness({ publisher });
      await expect(test.service.publishCommittedQueueActivation(generation())).resolves.toEqual({
        outcome: "Unavailable",
        message: null,
      });
      expect(test.metrics).toEqual([{ operation: "publish", result: "unavailable" }]);
    },
  );

  it("rejects invalid input before identity and publisher dependencies", async () => {
    const test = harness();
    await expect(
      test.service.publishCommittedQueueActivation({ ...generation(), data: { note: "unsafe" } }),
    ).resolves.toEqual({ outcome: "Rejected", message: null });
    expect(test.ports.references.nextReference).not.toHaveBeenCalled();
    expect(test.ports.publisher.publish).not.toHaveBeenCalled();
    expect(test.metrics).toEqual([{ operation: "publish", result: "rejected" }]);
  });

  it.each([
    { generationStatus: "Building" },
    { projectionVersion: 2 },
    { projectionName: "other" },
    { freshnessStatus: "Stale" },
    { activationLagMs: 999 },
  ])("rejects malformed generation evidence %#", async (override) => {
    const test = harness();
    await expect(
      test.service.publishCommittedQueueActivation(generation(override)),
    ).resolves.toEqual({
      outcome: "Rejected",
      message: null,
    });
    expect(test.ports.publisher.publish).not.toHaveBeenCalled();
  });

  it.each(["bad-reference", ids.generation, ids.brand, ids.store, ids.checkpoint])(
    "rejects malformed or aliased message identity %s",
    async (reference) => {
      const test = harness({ references: [reference] });
      await expect(test.service.publishCommittedQueueActivation(generation())).resolves.toEqual({
        outcome: "Unavailable",
        message: null,
      });
      expect(test.ports.publisher.publish).not.toHaveBeenCalled();
    },
  );

  it("allows duplicate lossy attempts only with distinct message identity", async () => {
    const test = harness({ references: [ids.message1, ids.message2] });
    const first = await test.service.publishCommittedQueueActivation(generation());
    const second = await test.service.publishCommittedQueueActivation(generation());
    expect(first.message?.messageId).toBe(ids.message1);
    expect(second.message?.messageId).toBe(ids.message2);
    expect(first.message?.resource).toEqual(second.message?.resource);
    expect(test.published).toHaveLength(2);
  });

  it("rejects accessors, symbols, proxies and open payload fields without executing accessors", async () => {
    const getter = vi.fn(() => ids.brand);
    const accessor = generation();
    Object.defineProperty(accessor, "brandReference", { enumerable: true, get: getter });
    const symbol = generation();
    Object.defineProperty(symbol, Symbol("secret"), { enumerable: true, value: "secret" });
    for (const value of [accessor, symbol, new Proxy(generation(), {})]) {
      const test = harness();
      await expect(test.service.publishCommittedQueueActivation(value)).resolves.toEqual({
        outcome: "Rejected",
        message: null,
      });
      expect(test.ports.publisher.publish).not.toHaveBeenCalled();
    }
    expect(getter).not.toHaveBeenCalled();
  });

  it("strict-parses messages/results and rejects any data bag or aliased scope", () => {
    const message = createKitchenRealtimeHint({
      generation: generation(),
      messageReference: ids.message1,
    });
    expect(parseKitchenRealtimeHint(message)).toEqual(message);
    expect(() => parseKitchenRealtimeHint({ ...message, data: {} })).toThrow();
    expect(() =>
      parseKitchenRealtimeHint({ ...message, scope: { ...message.scope, storeId: ids.brand } }),
    ).toThrow();
    expect(() => createKitchenRealtimePublishResult("Unavailable", message)).toThrow();
  });

  it("contains no customer, health, payment, provider, actor, session or narrative field", () => {
    const message = createKitchenRealtimeHint({
      generation: generation(),
      messageReference: ids.message1,
    });
    const serialized = JSON.stringify(message).toLowerCase();
    for (const forbidden of [
      "customer",
      "note",
      "allerg",
      "health",
      "payment",
      "provider",
      "actor",
      "session",
      "status",
      "quantity",
      "station",
      "data",
    ])
      expect(serialized).not.toContain(forbidden);
  });

  it("ignores metric failure after preserving the delivery result", async () => {
    const test = harness();
    const metricsPort = test.ports.metrics;
    if (metricsPort === undefined) throw new Error("test metrics port is missing");
    vi.mocked(metricsPort.record).mockImplementation(() => {
      throw new Error("metrics unavailable");
    });
    await expect(test.service.publishCommittedQueueActivation(generation())).resolves.toMatchObject(
      {
        outcome: "Delivered",
      },
    );
  });
});
