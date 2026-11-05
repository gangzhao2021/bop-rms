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

it("DEC-MULTI-MERCHANT-ONE-INSTALLATION A5: the other Stores run in one process, each reported on its own", async () => {
  const created = [];
  const createSweep = (options) => {
    created.push(options);
    return {
      sweep: async () => [
        { service: "api", state: "running", pid: 1 },
        { service: "store-workers", state: "running", pid: 42 },
      ],
    };
  };
  const read = [];
  const sweep = createPilotInstallationSweep({
    runtimeDirectory: ".local/pilot-v15",
    createSweep,
    root: () => "/app",
    listStores: async () => ["stores/demo-2", "stores/demo-3"],
    admit: async (relatives) => ({ admitted: relatives, refused: [] }),
    readHealth: async (directory, service, pid) => {
      read.push(pid);
      if (service === "daily-settlement-worker") return null;
      return directory.endsWith("demo-3") && service === "business-worker"
        ? { attention: ["events"] }
        : {};
    },
  });
  const services = await sweep.sweep({});
  expect(created).toHaveLength(1);
  expect(created[0].runtimeDirectory).toBe(".local/pilot-v15");
  expect(created[0].services).toContain("store-workers");
  expect(created[0].services).toContain("api");
  expect(new Set(read)).toEqual(new Set([42]));
  // Each Store on its own; one Store needing a person never hides another. Settlement is listed
  // once it has run.
  expect(services).toContainEqual({ service: "stores/demo-2:business-worker", state: "running" });
  expect(services).toContainEqual({
    service: "stores/demo-3:business-worker",
    state: "running",
    attention: ["events"],
  });
  expect(services.map((entry) => entry.service)).not.toContain(
    "stores/demo-2:daily-settlement-worker",
  );
  // The Store list is read once per supervisor run.
  await sweep.sweep({});
  expect(created).toHaveLength(1);
});

it("while the shared process isn't running, its Stores say so", async () => {
  const sweep = createPilotInstallationSweep({
    runtimeDirectory: ".local/pilot-v15",
    createSweep: () => ({
      sweep: async () => [{ service: "store-workers", state: "backoff" }],
    }),
    listStores: async () => ["stores/demo-2"],
    admit: async (relatives) => ({ admitted: relatives, refused: [] }),
  });
  expect(await sweep.sweep({})).toContainEqual({ service: "stores/demo-2", state: "backoff" });
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
    admit: async (relatives) => ({ admitted: relatives, refused: [] }),
  });
  expect(await sweep.sweep({})).toEqual([{ service: "api", state: "running" }]);
  expect(created).toHaveLength(1);
  expect(created[0].services).toBeUndefined();
});
it("v15 2026-10-31: the sweep starts a Store's worker with no window open and not while the installation's is", async () => {
  const fs = await import("node:fs/promises");
  const { randomUUID } = await import("node:crypto");
  const { assertPilotMaintenanceAccess } = await import("./pilot-maintenance.mjs");
  const { createPilotRecoverySweep } = await import("./pilot-recovery-sweep.mjs");
  const directory = ".local/sweep-stores-" + randomUUID();
  await fs.mkdir(directory + "/stores/demo-2", { recursive: true, mode: 0o700 });
  try {
    const started = [];
    // Nothing is running; a start makes the real maintenance check every start makes
    // (pilot-service), then reports the started process.
    const service = async (action, name, dir) => {
      if (action === "status") return { service: name, state: "stopped" };
      await assertPilotMaintenanceAccess(dir, action);
      started.push(dir + ":" + name);
      return { service: name, state: "running", pid: 4242 };
    };
    const sweep = () =>
      createPilotInstallationSweep({
        runtimeDirectory: directory,
        createSweep: (options) =>
          createPilotRecoverySweep({ ...options, service, workloadHealth: null }),
        listStores: async () => ["stores/demo-2"],
        admit: async (relatives) => ({ admitted: relatives, refused: [] }),
        readHealth: async () => null,
      }).sweep();
    await sweep();
    expect(started).toContain(directory + ":store-workers");
    // The installation's planned update window is open: no start, its own or the Store's workers.
    await fs.writeFile(directory + "/maintenance.lock", "{}", { mode: 0o600 });
    started.length = 0;
    await sweep();
    expect(started).toEqual([]);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

it("WP-2423: a Store over the connection budget is reported, and its workers aren't started", async () => {
  const created = [];
  const sweep = createPilotInstallationSweep({
    runtimeDirectory: ".local/pilot-v15",
    createSweep: (options) => {
      created.push(options.runtimeDirectory);
      return { sweep: async () => [{ service: "store-workers", state: "running", pid: 42 }] };
    },
    listStores: async () => ["stores/demo-2", "stores/demo-3"],
    admit: async () => ({ admitted: ["stores/demo-2"], refused: ["stores/demo-3"] }),
    readHealth: async () => ({}),
  });
  const services = await sweep.sweep();
  expect(created).toEqual([".local/pilot-v15"]);
  expect(services).toContainEqual({ service: "stores/demo-2:business-worker", state: "running" });
  expect(services).toContainEqual({ service: "stores/demo-3", state: "attention_required" });
});
