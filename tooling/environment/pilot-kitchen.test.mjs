import { afterEach, expect, it, vi } from "vitest";

const seam = vi.hoisted(() => ({
  routing: null,
  identity: null,
  charges: new Set(),
  tea: null,
  intake: null,
}));
vi.mock("../../packages/rms/ordering/src/index.ts", () => ({
  parseOrderConfirmedEnvelope: (value) => value,
  createPostgresOrderKitchenSourceStore: () => ({ resolve: async () => ({}) }),
  createPostgresOrderBatchIdentitySource: () => ({ load: async () => seam.identity }),
}));
vi.mock("../../packages/rms/recipe/src/index.ts", () => ({
  createPostgresRecipePreparationContentStore: () => ({}),
  createPostgresConfiguredRecipePreparationSource: () => ({}),
  listDeclaredChargeSkus: async (_tx, _scope, skus) => skus.filter((sku) => seam.charges.has(sku)),
}));
vi.mock("../../packages/rms/dining/src/index.ts", () => ({
  loadDiningTeaChargeSetting: async () => ({ teaSellableReference: seam.tea }),
}));
vi.mock("../../apps/api/src/kitchen-recipe-preparation-source.ts", () => ({
  createKitchenRecipePreparationSource: () => ({ resolve: async () => ({}) }),
}));
// Kitchen's own services, reduced to the route a confirmed order takes: the work plan asks the
// Store's routing, and the consumer answers a temporary failure when there is none.
vi.mock("../../packages/rms/kitchen/src/index.ts", () => ({
  createPostgresKitchenRoutingConfigurationStore: () => ({
    resolve: async () => seam.routing,
  }),
  createPostgresKitchenTicketStore: () => ({}),
  createKitchenTicketIntakeAdapter: (ports) => ports,
  createKitchenNotPreparedIntakeAdapter: (options) => {
    seam.intake = options;
    return options.inner;
  },
  createKitchenWorkPlanService: (options) => ({
    resolve: async () => options.stationRouting.resolve({}),
  }),
  createConfirmedOrderConsumerService: ({ intakes }) => ({
    registration: {
      consumerName: "kitchen.confirmed-order:v1",
      handler: async () =>
        (await intakes.plans.resolve({})) === null
          ? { status: "retry_required", errorCode: "CONSUMER_TEMPORARY_FAILURE" }
          : { status: "completed" },
    },
  }),
  loadKitchenBatchPreparationDecision: async () => null,
}));
vi.mock("../../packages/bop/eventing/src/index.ts", () => ({
  consumeEventInTransaction: async () => ({ status: "processed" }),
}));
import { createInternalKitchen, kitchenDefaultNotPrepared } from "./pilot-kitchen.mjs";

afterEach(() => vi.unstubAllEnvs());
const id = (n) => "0190fa36-0000-7000-8000-" + String(n).padStart(12, "0");

// v15 2026-11-01: store 2's paid order was retried as a bare CONSUMER_TEMPORARY_FAILURE; the
// cause (no kitchen routing in effect when it was confirmed) was invisible. The failure now carries
// the step it stopped at, and is retried exactly as before.
it("v15 2026-11-01: a confirmed order the kitchen cannot route names why, and is retried", async () => {
  vi.stubEnv("NODE_ENV", "development");
  const scope = { brandReference: id(1), storeReference: id(2) };
  const kitchen = createInternalKitchen({
    scope,
    now: () => "2026-11-01T03:00:00.000Z",
    publicProfile: { binding: { validUntil: "2099-01-01T00:00:00.000Z" } },
  });
  const context = {
    envelope: { tenantId: scope.brandReference, storeId: scope.storeReference },
    transaction: {},
  };
  seam.routing = null;
  const failure = await kitchen.worker.registration.handler(context).catch((error) => error);
  expect(failure).toBeInstanceOf(Error);
  expect(failure.code).toBe("CONSUMER_TEMPORARY_FAILURE");
  expect(failure.cause.code).toBe("KITCHEN_ROUTING_NOT_IN_EFFECT_AT_CONFIRMATION");
  // With a routing in effect it is processed as before.
  seam.routing = { candidates: [] };
  await expect(kitchen.worker.registration.handler(context)).resolves.toEqual({
    status: "completed",
  });
});

// WP-2423 item 8a: Kitchen's default is fed by Recipe's public read and Dining's public setting.
it("the kitchen's default: a declared charge and the Store's current tea item", async () => {
  const scope = { brandReference: id(1), storeReference: id(2) };
  seam.charges = new Set([id(10)]);
  seam.tea = id(11);
  expect(await kitchenDefaultNotPrepared(scope)({}, [id(10), id(11), id(12)])).toEqual(
    new Set([id(10), id(11)]),
  );
  // Another tea gives the dish back to the kitchen, with nothing to undo.
  seam.tea = id(13);
  expect(await kitchenDefaultNotPrepared(scope)({}, [id(10), id(11)])).toEqual(new Set([id(10)]));
  seam.tea = null;
  expect(await kitchenDefaultNotPrepared(scope)({}, [id(11)])).toEqual(new Set());
});

// A round's order type is never guessed: a Pickup taken for dine-in would never reach the handover.
it("a round whose order type can't be read fails instead of passing as dine-in", async () => {
  vi.stubEnv("NODE_ENV", "development");
  const scope = { brandReference: id(1), storeReference: id(2) };
  const kitchen = createInternalKitchen({
    scope,
    now: () => "2026-11-01T03:00:00.000Z",
    publicProfile: { binding: { validUntil: "2099-01-01T00:00:00.000Z" } },
  });
  seam.routing = { candidates: [] };
  await kitchen.worker.registration.handler({
    envelope: { tenantId: scope.brandReference, storeId: scope.storeReference },
    transaction: {},
  });
  seam.identity = null;
  const receipt = { orderReference: id(3), orderBatchReference: id(4) };
  await expect(seam.intake.orderType({}, receipt)).rejects.toThrow(
    "INTERNAL_KITCHEN_IDENTITY_UNAVAILABLE",
  );
  seam.identity = { orderType: "Pickup" };
  await expect(seam.intake.orderType({}, receipt)).resolves.toBe("Pickup");
});
