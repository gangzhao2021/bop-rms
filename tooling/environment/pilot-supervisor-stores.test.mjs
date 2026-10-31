import { expect, it } from "vitest";
import { createPilotInstallationSweep } from "./pilot-supervisor.mjs";
import { parsePilotRuntimeDirectory } from "./pilot-service.mjs";

it("DEC-BRAND-MULTI-STORE-ONE-INSTALLATION: another Store's directory is a runtime directory, nothing else", () => {
  expect(parsePilotRuntimeDirectory(".local/pilot-v15/stores/demo-2")).toBe(
    ".local/pilot-v15/stores/demo-2",
  );
  for (const bad of [
    ".local/pilot-v15/stores/../x",
    ".local/pilot-v15/other/demo-2",
    ".local/pilot-v15/stores/demo-2/stores/x",
    "/abs/stores/demo-2",
  ])
    expect(() => parsePilotRuntimeDirectory(bad)).toThrow();
});

it("supervises each other Store's workers from its own directory, settlement once its first day is recorded", async () => {
  const created = [];
  const createSweep = (options) => {
    created.push(options);
    return {
      sweep: async () =>
        (options.services ?? ["api", "customer", "business-worker"]).map((service) => ({
          service,
          state:
            options.runtimeDirectory.endsWith("demo-3") && service === "business-worker"
              ? "attention_required"
              : "running",
        })),
    };
  };
  const sweep = createPilotInstallationSweep({
    runtimeDirectory: ".local/pilot-v15",
    createSweep,
    listStores: async () => ["stores/demo-2", "stores/demo-3"],
    exists: async (file) => file.includes("demo-2"),
  });
  const services = await sweep.sweep({});
  expect(created.map((options) => options.runtimeDirectory)).toEqual([
    ".local/pilot-v15",
    ".local/pilot-v15/stores/demo-2",
    ".local/pilot-v15/stores/demo-3",
  ]);
  // A listed Store runs workers only; its settlement worker only once its coverage exists.
  expect(created[1].services).toContain("daily-settlement-worker");
  expect(created[2].services).not.toContain("daily-settlement-worker");
  expect(created[1].services).not.toContain("api");
  // Each Store reported on its own; one Store needing a person never hides another.
  expect(services.map((entry) => entry.service)).toContain("stores/demo-2:business-worker");
  expect(services.find((entry) => entry.service === "stores/demo-3:business-worker")?.state).toBe(
    "attention_required",
  );
  expect(services.find((entry) => entry.service === "stores/demo-2:business-worker")?.state).toBe(
    "running",
  );
  // The Store list is read once per supervisor run.
  await sweep.sweep({});
  expect(created).toHaveLength(3);
});

it("a single-Store installation supervises exactly its own services", async () => {
  const created = [];
  const sweep = createPilotInstallationSweep({
    runtimeDirectory: ".local/pilot-v15",
    createSweep: (options) => {
      created.push(options);
      return { sweep: async () => [{ service: "api", state: "running" }] };
    },
    listStores: async () => [],
  });
  expect(await sweep.sweep({})).toEqual([{ service: "api", state: "running" }]);
  expect(created).toHaveLength(1);
  expect(created[0].services).toBeUndefined();
});
