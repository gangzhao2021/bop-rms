import { afterEach, expect, it, vi } from "vitest";

const seam = vi.hoisted(() => ({ routing: null }));
vi.mock("../../packages/rms/ordering/src/index.ts", () => ({
  parseOrderConfirmedEnvelope: (value) => value,
  createPostgresOrderKitchenSourceStore: () => ({ resolve: async () => ({}) }),
}));
vi.mock("../../packages/rms/recipe/src/index.ts", () => ({
  createPostgresRecipePreparationContentStore: () => ({}),
  createPostgresConfiguredRecipePreparationSource: () => ({}),
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
  createKitchenNotPreparedIntakeAdapter: ({ inner }) => inner,
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
import { createInternalKitchen } from "./pilot-kitchen.mjs";

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
