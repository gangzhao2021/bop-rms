import type { GuestSession } from "@bop/identity";
import { describe, expect, it } from "vitest";
import {
  createOrderStatusProjector,
  createOrderStatusQueryService,
} from "../application/order-status-projection-service.js";
import type { OrderStatusProjection } from "../domain/order-status-projection.js";

const id = (n: number) => `018f6300-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-08-03T14:00:00.000Z";
const refs = {
  order: id(1),
  brand: id(2),
  store: id(3),
  guest: id(4),
  checkpoint: id(5),
  generation: id(6),
  batch: id(7),
  item: id(8),
};

function source(overrides: Record<string, unknown> = {}) {
  return {
    sourceVersion: 1,
    sourceCheckpoint: refs.checkpoint,
    orderReference: refs.order,
    brandReference: refs.brand,
    storeReference: refs.store,
    guestSessionReference: refs.guest,
    orderNumber: "42",
    orderType: "Pickup",
    sourceChannel: "Qr",
    canonicalPhase: "Submitted",
    closureStatus: "Open",
    paymentStatus: "NotReported",
    kitchenStatus: "Unavailable",
    fulfillmentStatus: "Unavailable",
    eta: null,
    submittedAt: at,
    batches: [
      {
        orderBatchReference: refs.batch,
        submittedAt: at,
        items: [
          {
            orderItemReference: refs.item,
            displayName: "Synthetic item",
            quantity: 2,
            lineTotal: { amountMinor: 2260n, currencyCode: "CAD" },
          },
        ],
      },
    ],
    ...overrides,
  };
}

function guest(overrides: Partial<GuestSession> = {}): GuestSession {
  return {
    sessionReference: refs.guest,
    status: "Active",
    version: 1,
    brandReference: refs.brand,
    storeReference: refs.store,
    publicStoreReference: id(20),
    publicTableReference: null,
    channel: "Pickup",
    locale: "en-CA" as never,
    qrReference: id(21),
    qrRevocationVersion: 1,
    diningState: "ContextOnly",
    diningSessionReference: null,
    diningParticipantReference: null,
    createdAt: "2026-08-03T12:00:00.000Z" as never,
    lastSeenAt: at as never,
    idleExpiresAt: "2026-08-03T18:00:00.000Z" as never,
    absoluteExpiresAt: "2026-08-04T12:00:00.000Z" as never,
    orderClosedAt: null,
    closureExpiresAt: null,
    rotatedFromGuestSessionReference: null,
    revocationReason: null,
    revokedAt: null,
    ...overrides,
  } as GuestSession;
}

describe("Order status projection", () => {
  it("creates an immutable generation and makes replay idempotent", async () => {
    let current: OrderStatusProjection | null = null;
    let generations = 0;
    const service = createOrderStatusProjector({
      references: {
        generateGeneration: () => {
          generations += 1;
          return refs.generation;
        },
        now: () => at,
      },
      source: { loadExact: async () => source() },
      projections: {
        load: async () => current,
        replace: async (projection) => {
          current = projection;
          return projection;
        },
      },
    });
    const first = await service.project(refs.order);
    const replay = await service.project(refs.order);
    expect(replay).toStrictEqual(first);
    expect(generations).toBe(1);
    const firstBatch = first.snapshot.batches[0];
    expect(firstBatch).toBeDefined();
    if (firstBatch === undefined) throw new Error("missing batch");
    expect(Object.isFrozen(firstBatch.items)).toBe(true);
    expect(() => {
      (firstBatch.items as unknown[]).push({});
    }).toThrow();
  });

  it("rejects conflicting same-version checkpoints and advances a newer source", async () => {
    let input = source();
    let current: OrderStatusProjection | null = null;
    let generation = 6;
    const service = createOrderStatusProjector({
      references: { generateGeneration: () => id(generation++), now: () => at },
      source: { loadExact: async () => input },
      projections: {
        load: async () => current,
        replace: async (projection) => {
          current = projection;
          return projection;
        },
      },
    });
    await service.project(refs.order);
    input = source({ orderNumber: "43" });
    await expect(service.project(refs.order)).rejects.toMatchObject({
      code: "ORDER_STATUS_VERSION_CONFLICT",
    });
    input = source({ sourceCheckpoint: id(30) });
    await expect(service.project(refs.order)).rejects.toMatchObject({
      code: "ORDER_STATUS_VERSION_CONFLICT",
    });
    input = source({ sourceVersion: 2, sourceCheckpoint: id(31) });
    await expect(service.project(refs.order)).resolves.toMatchObject({
      snapshot: { sourceVersion: 2 },
    });
  });

  it("authorizes customer before reading and returns only the safe projection view", async () => {
    const calls: string[] = [];
    const projected = await createOrderStatusProjector({
      references: { generateGeneration: () => refs.generation, now: () => at },
      source: { loadExact: async () => source() },
      projections: { load: async () => null, replace: async (projection) => projection },
    }).project(refs.order);
    const service = createOrderStatusQueryService({
      authorization: {
        authorizeCustomer: async () => {
          calls.push("authorize");
          return { guestSession: guest() };
        },
        authorizeMerchant: async () => ({ actorReference: id(40) as never }),
      },
      projections: {
        load: async () => {
          calls.push("read");
          return projected;
        },
        list: async () => [projected],
      },
    });
    const result = await service.getCustomer({ orderReference: refs.order, observedAt: at });
    expect(calls).toEqual(["authorize", "read"]);
    expect(result.order).not.toHaveProperty("guestSessionReference");
    expect(result.order).not.toHaveProperty("brandReference");
    expect(result.order).not.toHaveProperty("storeReference");
    expect(result.order).toMatchObject({ orderNumber: "42", kitchenStatus: "Unavailable" });
  });

  it("denies before a customer or merchant projection read and fails closed on cross-Store rows", async () => {
    let reads = 0;
    const denied = createOrderStatusQueryService({
      authorization: { authorizeCustomer: async () => null, authorizeMerchant: async () => null },
      projections: {
        load: async () => {
          reads += 1;
          return null;
        },
        list: async () => {
          reads += 1;
          return [];
        },
      },
    });
    await expect(
      denied.getCustomer({ orderReference: refs.order, observedAt: at }),
    ).rejects.toMatchObject({ code: "ORDER_STATUS_PERMISSION_DENIED" });
    await expect(
      denied.listMerchant({
        brandReference: refs.brand,
        storeReference: refs.store,
        observedAt: at,
        exactReferenceOrNumber: null,
        orderType: null,
        sourceChannel: null,
        canonicalPhase: null,
        closureStatus: null,
        paymentStatus: null,
        limit: 50,
      }),
    ).rejects.toMatchObject({ code: "ORDER_STATUS_PERMISSION_DENIED" });
    expect(reads).toBe(0);

    const otherStore = await createOrderStatusProjector({
      references: { generateGeneration: () => refs.generation, now: () => at },
      source: { loadExact: async () => source({ storeReference: id(99) }) },
      projections: { load: async () => null, replace: async (projection) => projection },
    }).project(refs.order);
    const scoped = createOrderStatusQueryService({
      authorization: {
        authorizeCustomer: async () => ({ guestSession: guest() }),
        authorizeMerchant: async () => ({ actorReference: id(40) as never }),
      },
      projections: { load: async () => otherStore, list: async () => [otherStore] },
    });
    await expect(
      scoped.listMerchant({
        brandReference: refs.brand,
        storeReference: refs.store,
        observedAt: at,
        exactReferenceOrNumber: null,
        orderType: null,
        sourceChannel: null,
        canonicalPhase: null,
        closureStatus: null,
        paymentStatus: null,
        limit: 50,
      }),
    ).rejects.toMatchObject({ code: "ORDER_STATUS_DEPENDENCY_UNAVAILABLE" });
  });

  it("rejects extra query fields before authorization", async () => {
    let authorizations = 0;
    const service = createOrderStatusQueryService({
      authorization: {
        authorizeCustomer: async () => {
          authorizations += 1;
          return { guestSession: guest() };
        },
        authorizeMerchant: async () => {
          authorizations += 1;
          return { actorReference: id(40) as never };
        },
      },
      projections: { load: async () => null, list: async () => [] },
    });
    await expect(
      service.getCustomer({ orderReference: refs.order, observedAt: at, injected: true }),
    ).rejects.toMatchObject({ code: "ORDER_STATUS_INPUT_INVALID" });
    expect(authorizations).toBe(0);
    await expect(
      service.listMerchant({
        brandReference: refs.brand,
        storeReference: refs.store,
        observedAt: at,
        exactReferenceOrNumber: "not-an-exact-reference",
        orderType: null,
        sourceChannel: null,
        canonicalPhase: null,
        closureStatus: null,
        paymentStatus: null,
        limit: 50,
      }),
    ).rejects.toMatchObject({ code: "ORDER_STATUS_INPUT_INVALID" });
    expect(authorizations).toBe(0);
  });

  it("classifies malformed dependency output as unavailable", async () => {
    const malformedSource = createOrderStatusProjector({
      references: { generateGeneration: () => refs.generation, now: () => at },
      source: { loadExact: async () => ({ injected: true }) },
      projections: { load: async () => null, replace: async (projection) => projection },
    });
    await expect(malformedSource.project(refs.order)).rejects.toMatchObject({
      code: "ORDER_STATUS_DEPENDENCY_UNAVAILABLE",
    });

    const malformedProjection = createOrderStatusQueryService({
      authorization: {
        authorizeCustomer: async () => ({ guestSession: guest() }),
        authorizeMerchant: async () => ({ actorReference: id(40) as never }),
      },
      projections: {
        load: async () => ({ injected: true }) as never,
        list: async () => [],
      },
    });
    await expect(
      malformedProjection.getCustomer({ orderReference: refs.order, observedAt: at }),
    ).rejects.toMatchObject({ code: "ORDER_STATUS_DEPENDENCY_UNAVAILABLE" });
  });
});
