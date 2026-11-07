import { expect, it, vi } from "vitest";
import {
  parseKitchenWorkerArguments,
  startConfiguredKitchenWorker,
} from "./pilot-kitchen-queue-worker.mjs";
const scope = { tenantReference: "tenant", brandReference: "brand", storeReference: "store" };
const config = { actorReference: "configured-actor", scope };
it("passes only configured actor and installation resources to existing Kitchen lifecycle", async () => {
  const resources = { publicProfile: { binding: scope } },
    queue = {};
  const createResources = vi.fn(async () => resources),
    createQueue = vi.fn(() => queue);
  await startConfiguredKitchenWorker({
    directory: "/synthetic",
    loadInstallation: async () => ({ loadKitchenWorker: async () => config }),
    createResources,
    createQueue,
    startWorker: async (options) => {
      expect(options.directory).toBe("/synthetic");
      expect(createResources).not.toHaveBeenCalled();
      const loaded = await options.createInternalTestResources();
      expect(options.createInternalKitchenQueue(loaded)).toBe(queue);
    },
  });
  expect(createResources).toHaveBeenCalledWith("/synthetic");
  expect(createQueue).toHaveBeenCalledWith(resources, { actorReference: config.actorReference });
});
it("closes resources if installation binding changes between configuration and resource load", async () => {
  const close = vi.fn(async () => undefined),
    createQueue = vi.fn();
  await expect(
    startConfiguredKitchenWorker({
      directory: "/synthetic",
      loadInstallation: async () => ({ loadKitchenWorker: async () => config }),
      createResources: async () => ({
        close,
        publicProfile: { binding: { ...scope, storeReference: "other" } },
      }),
      createQueue,
      startWorker: async (options) => options.createInternalTestResources(),
    }),
  ).rejects.toThrow("KITCHEN_WORKER_SCOPE_CHANGED");
  expect(close).toHaveBeenCalledOnce();
  expect(createQueue).not.toHaveBeenCalled();
});
it("does not start or open resources if scoped configuration cannot load", async () => {
  const startWorker = vi.fn(),
    createResources = vi.fn();
  await expect(
    startConfiguredKitchenWorker({
      directory: "/synthetic",
      createResources,
      startWorker,
      loadInstallation: async () => ({
        loadKitchenWorker: async () => {
          throw Error("unavailable");
        },
      }),
    }),
  ).rejects.toThrow("unavailable");
  expect(startWorker).not.toHaveBeenCalled();
  expect(createResources).not.toHaveBeenCalled();
});
it("requires an explicit safe installation directory", () => {
  expect(parseKitchenWorkerArguments([".local/pilot-example"])).toBe(".local/pilot-example");
  for (const args of [[], [".local/../other"], ["/tmp/pilot"], [".local/pilot", "extra"], [null]])
    expect(() => parseKitchenWorkerArguments(args)).toThrow();
});
