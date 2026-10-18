import { expect, it, vi } from "vitest";
import {
  parseBusinessWorkerArguments,
  startConfiguredBusinessWorker,
} from "./pilot-business-worker.mjs";
import { composeConfiguredBusinessWorker } from "./pilot-business-composition.mjs";
const scope = { tenantReference: "tenant", brandReference: "brand", storeReference: "store" };
const config = {
  scope,
  providerAccountReference: "account",
  actors: { paidOutcome: "paid", orderCompletion: "completion", kitchenQueue: "kitchen" },
};
it("preserves the complete enabled consumer registration set and scoped workflow/account inputs", async () => {
  const loadWorkflow = vi.fn(async (kind) => ({ kind }));
  const paidFactory = vi.fn(),
    services = vi.fn();
  const compose = composeConfiguredBusinessWorker({
    directory: "/synthetic",
    config,
    installation: { loadWorkflow },
    implementations: {
      createInternalWorker: async (r, observers, options, dependencies) => {
        await dependencies.createInternalWorkerServices(r, { persistentWaiting: true });
        await dependencies.createInternalPaidOutcome(r, { persistentWaiting: true });
        dependencies.createInternalDiningCheckoutExpiryWorkload(r, observers.expiry);
      },
      createInternalWorkerServices: services,
      createInternalPaidOutcome: paidFactory,
      createInternalDiningCheckoutExpiryWorkload: vi.fn(),
      createInternalOrderSubmitted: vi.fn(),
      createInternalPickupFulfillment: vi.fn(),
      createInternalKitchen: vi.fn(),
    },
  });
  await compose({}, { expiry: "observer" }, {});
  expect(Object.keys(services.mock.calls[0][2]).sort()).toEqual(
    [
      "createInternalAdditionalReceiptConsumer",
      "createInternalOrderSubmitted",
      "createInternalPaymentStatus",
      "createInternalPaidOutcome",
      "createInternalOrderStatus",
      "createInternalReceiptConsumer",
      "createInternalRefundConsumers",
      "createInternalPickupFulfillment",
      "createInternalKitchen",
      "createInternalKitchenConsumers",
      "createInternalOrderProgressConsumers",
      "createInternalInventoryConsumers",
      "createInternalPickupReadiness",
      "createInternalPickupProofConsumer",
      "createInternalOrderCompletionConsumer",
    ].sort(),
  );
  const dependencies = paidFactory.mock.calls[0][2];
  expect(dependencies.providerAccountReference).toBe(config.providerAccountReference);
  expect(dependencies.actorReference).toBe(config.actors.paidOutcome);
  await dependencies.loadPickupWorkflow();
  await dependencies.loadDiningWorkflow();
  await dependencies.loadAdditionalWorkflow();
  expect(loadWorkflow.mock.calls.map(([kind]) => kind)).toEqual([
    "Pickup",
    "DineIn",
    "AdditionalRelease",
  ]);
  expect(() => compose({}, {}, { compensation: true })).toThrow(
    "BUSINESS_WORKER_OPTION_UNCONFIGURED",
  );
  expect(() => compose({}, {}, { batchCancellation: true })).toThrow(
    "BUSINESS_WORKER_OPTION_UNCONFIGURED",
  );
});
it("closes resources and refuses worker construction on changed scope", async () => {
  const close = vi.fn(async () => undefined);
  const createWorker = vi.fn();
  await expect(
    startConfiguredBusinessWorker({
      directory: "/synthetic",
      loadInstallation: async () => ({ loadBusinessWorker: async () => config }),
      composeWorker: () => createWorker,
      createResources: async () => ({
        close,
        publicProfile: { binding: { ...scope, storeReference: "other" } },
      }),
      startWorker: async (options) => {
        const r = await options.createInternalTestResources();
        return options.createInternalWorker(r);
      },
    }),
  ).rejects.toThrow("BUSINESS_WORKER_SCOPE_CHANGED");
  expect(close).toHaveBeenCalledOnce();
  expect(createWorker).not.toHaveBeenCalled();
});
it("passes installation-scoped composition and resources to existing lifecycle", async () => {
  const resources = { publicProfile: { binding: scope } },
    worker = vi.fn();
  const installation = { loadBusinessWorker: async () => config },
    composeWorker = vi.fn(() => worker);
  await startConfiguredBusinessWorker({
    directory: "/synthetic",
    loadInstallation: async () => installation,
    composeWorker,
    createResources: async () => resources,
    startWorker: async (options) => {
      expect(await options.createInternalTestResources()).toBe(resources);
      expect(options.createInternalWorker).toBe(worker);
      expect(options.enableCompensation).toBe(false);
      expect(options.enableBatchCancellation).toBe(false);
    },
  });
  expect(composeWorker).toHaveBeenCalledWith({ directory: "/synthetic", installation, config });
});
it("requires an explicit safe installation and accepts no activation flags", () => {
  expect(parseBusinessWorkerArguments([".local/pilot-example"])).toBe(".local/pilot-example");
  for (const args of [[], ["/tmp/pilot"], [".local/pilot", "--compensation"], [null]])
    expect(() => parseBusinessWorkerArguments(args)).toThrow();
});

it("explicit workload configuration reaches existing lifecycle and optional dependencies stay lazy", async () => {
  const enabled = { ...config, workloads: { batchCancellation: true, compensation: true } };
  const cancel = vi.fn(),
    compensate = vi.fn(),
    installation = { database: "synthetic", loadCancellationWorkflow: vi.fn() };
  const compose = composeConfiguredBusinessWorker({
    directory: "/synthetic",
    installation,
    config: enabled,
    implementations: {
      createInternalBatchCancellationDispatcher: cancel,
      createInternalCompensationService: compensate,
      createInternalWorker: async (r, _observers, options, deps) => {
        expect(cancel).not.toHaveBeenCalled();
        expect(compensate).not.toHaveBeenCalled();
        expect(options).toEqual(enabled.workloads);
        deps.createInternalBatchCancellationDispatcher(r);
        deps.createInternalCompensation(r);
      },
    },
  });
  const resources = {};
  await compose(resources, {}, enabled.workloads);
  expect(cancel).toHaveBeenCalledWith(resources, {
    loadWorkflow: installation.loadCancellationWorkflow,
    expectedDatabaseName: "synthetic",
    systemActorReference: config.actors.paidOutcome,
    // WP-2423 abandoned payment: the dispatcher resolves a still-open payment with the same
    // (TEST-ONLY simulated) Provider and account the compensation service uses.
    providerAccountReference: config.providerAccountReference,
    createSimulatedProvider: expect.any(Function),
  });
  expect(cancel.mock.calls[0][1].createSimulatedProvider).toBe(
    compensate.mock.calls[0][0].createSimulatedProvider,
  );
  expect(compensate.mock.calls[0][0]).toMatchObject({
    resources,
    providerAccountReference: config.providerAccountReference,
    additionalRefundOwners: [],
  });
  expect(typeof compensate.mock.calls[0][0].createSimulatedProvider).toBe("function");
  await startConfiguredBusinessWorker({
    directory: "/synthetic",
    loadInstallation: async () => ({ loadBusinessWorker: async () => enabled }),
    composeWorker: () => vi.fn(),
    startWorker: async (options) => {
      expect(options.enableCompensation).toBe(true);
      expect(options.enableBatchCancellation).toBe(true);
    },
  });
});
it("always composes the paid-without-fulfillable inventory release with the paid outcome System actor", async () => {
  const release = vi.fn(() => "workload");
  const compose = composeConfiguredBusinessWorker({
    directory: "/synthetic",
    config,
    installation: {},
    implementations: {
      createInternalWorker: async (r, observers, _options, dependencies) =>
        dependencies.createInternalPaidWithoutFulfillableInventoryWorkload(
          r,
          observers.inventoryRelease,
        ),
      createInternalPaidWithoutFulfillableInventoryWorkload: release,
    },
  });
  // WP-2423 Q12: not behind a workloads option.
  expect(await compose("resources", { inventoryRelease: "observer" }, {})).toBe("workload");
  expect(release).toHaveBeenCalledWith("resources", "observer", {
    systemActorReference: config.actors.paidOutcome,
  });
});
it("always composes the unpaid pickup closure with the paid outcome System actor and provider account", async () => {
  const expiry = vi.fn(() => "workload");
  const compose = composeConfiguredBusinessWorker({
    directory: "/synthetic",
    config,
    installation: {},
    implementations: {
      createInternalWorker: async (r, observers, _options, dependencies) =>
        dependencies.createInternalPickupPaymentExpiryWorkload(r, observers.pickupPaymentExpiry),
      createInternalPickupPaymentExpiryWorkload: expiry,
    },
  });
  // WP-2423 Q12: not behind a workloads option.
  expect(await compose("resources", { pickupPaymentExpiry: "observer" }, {})).toBe("workload");
  expect(expiry).toHaveBeenCalledWith("resources", "observer", {
    systemActorReference: config.actors.paidOutcome,
    providerAccountReference: config.providerAccountReference,
    // WP-2423 abandoned pickup payment: closed Orders' open card payments are settled with it.
    createSimulatedProvider: expect.any(Function),
  });
});
it("WP-2423 Q10: always composes the daily contact retention removal with its health observer", async () => {
  const retention = vi.fn(() => "workload");
  const compose = composeConfiguredBusinessWorker({
    directory: "/synthetic",
    config,
    installation: {},
    implementations: {
      createInternalWorker: async (r, observers, _options, dependencies) =>
        dependencies.createInternalContactRetentionWorkload(r, observers.contactRetention),
      createInternalContactRetentionWorkload: retention,
    },
  });
  // Not behind a workloads option: the Owner approved the 30-day retention for the pilot.
  expect(await compose("resources", { contactRetention: "observer" }, {})).toBe("workload");
  expect(retention).toHaveBeenCalledWith("resources", "observer");
});
it("DEC-PICKUP-CAPACITY-SCHEDULE: always composes the pickup slot schedule with its health observer", async () => {
  const schedule = vi.fn(() => "workload");
  const compose = composeConfiguredBusinessWorker({
    directory: "/synthetic",
    config,
    installation: {},
    implementations: {
      createInternalWorker: async (r, observers, _options, dependencies) =>
        dependencies.createInternalPickupCapacityScheduleWorkload(
          r,
          observers.pickupCapacitySchedule,
        ),
      createInternalPickupCapacityScheduleWorkload: schedule,
    },
  });
  // Not behind a workloads option: a Store without future pickup slots cannot take pickup orders.
  expect(await compose("resources", { pickupCapacitySchedule: "observer" }, {})).toBe("workload");
  expect(schedule).toHaveBeenCalledWith("resources", "observer");
});
