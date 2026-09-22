import { expect, it, afterEach, beforeEach, vi } from "vitest";
import { mkdtemp, writeFile, chmod, rm, symlink, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPilotInstallation } from "./pilot-installation.mjs";
let directory;
const config = () => ({
  schemaVersion: 1,
  environment: "InternalTest",
  database: "synthetic_pilot",
  port: 55435,
  roles: { api: "synthetic_api", worker: "synthetic_worker" },
});
const save = (name, value) =>
  writeFile(join(directory, name), JSON.stringify(value), { mode: 0o600 });
beforeEach(async () => {
  vi.stubEnv("NODE_ENV", "development");
  directory = await mkdtemp(join(tmpdir(), "bop-installation-"));
  await chmod(directory, 0o700);
  await save("installation.json", config());
  await save("internal-test-profile.json", {
    environment: "InternalTest",
    database: "synthetic_pilot",
    binding: {},
  });
  await save("internal-test-menu.json", {
    environment: "InternalTest",
    database: "synthetic_pilot",
  });
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});
it("composes exact local connections and lazy scoped profile/menu reads without needing keys", async () => {
  const value = await loadPilotInstallation(directory);
  expect(value.database).toBe("synthetic_pilot");
  expect(value.connection.host).toBe("127.0.0.1");
  expect(value.connection.user("api")).toBe("synthetic_api");
  expect(value.connection.user("worker")).toBe("synthetic_worker");
  expect(value.connection.passwordFile("api")).toBe(join(directory, "api-password"));
  expect(() => value.connection.passwordFile("../secret")).toThrow(
    "PILOT_INSTALLATION_UNAVAILABLE",
  );
  expect(() => value.connection.user("owner")).toThrow("PILOT_INSTALLATION_UNAVAILABLE");
  expect((await value.loadProfile()).database).toBe(value.database);
  expect((await value.loadMenu()).database).toBe(value.database);
});
it.each([
  { environment: "Live" },
  { schemaVersion: 2 },
  { host: "remote.example.invalid" },
  { password: "synthetic-secret-not-for-errors" },
  { database: "../other" },
  { port: 0 },
  { port: 65536 },
  { port: 2.5 },
  { roles: { api: "same", worker: "same" } },
  { roles: { api: "owner" } },
])("refuses unrecognized or unsafe configuration with bounded errors %j", async (change) => {
  await save("installation.json", { ...config(), ...change });
  await expect(loadPilotInstallation(directory)).rejects.toThrow(
    /^PILOT_INSTALLATION_UNAVAILABLE$/,
  );
});
it("refuses production before reading configuration", async () => {
  vi.stubEnv("NODE_ENV", "production");
  await expect(loadPilotInstallation(directory)).rejects.toThrow(
    /^PILOT_INSTALLATION_UNAVAILABLE$/,
  );
});
it("refuses public directory/file permissions", async () => {
  await chmod(directory, 0o755);
  await expect(loadPilotInstallation(directory)).rejects.toThrow();
  await chmod(directory, 0o700);
  await chmod(join(directory, "installation.json"), 0o644);
  await expect(loadPilotInstallation(directory)).rejects.toThrow();
});
it("refuses symlinked configuration", async () => {
  await rename(join(directory, "installation.json"), join(directory, "real.json"));
  await symlink(join(directory, "real.json"), join(directory, "installation.json"));
  await expect(loadPilotInstallation(directory)).rejects.toThrow(
    /^PILOT_INSTALLATION_UNAVAILABLE$/,
  );
});
it("rechecks scoped profile on each load and denies cross-database data", async () => {
  const value = await loadPilotInstallation(directory);
  await value.loadProfile();
  await save("internal-test-profile.json", { environment: "InternalTest", database: "other" });
  await expect(value.loadProfile()).rejects.toThrow(/^PILOT_INSTALLATION_UNAVAILABLE$/);
  await save("internal-test-menu.json", { environment: "Live", database: "synthetic_pilot" });
  await expect(value.loadMenu()).rejects.toThrow(/^PILOT_INSTALLATION_UNAVAILABLE$/);
});
it("bounds file size and redacts JSON parser content", async () => {
  await writeFile(join(directory, "installation.json"), "synthetic-secret-broken-json");
  await expect(loadPilotInstallation(directory)).rejects.toThrow(
    /^PILOT_INSTALLATION_UNAVAILABLE$/,
  );
  await writeFile(join(directory, "installation.json"), "x".repeat(1048577));
  await expect(loadPilotInstallation(directory)).rejects.toThrow(
    /^PILOT_INSTALLATION_UNAVAILABLE$/,
  );
});

it("loads explicit scoped Dining worker configuration lazily and rejects mismatched binding or account", async () => {
  const installation = await loadPilotInstallation(directory);
  await expect(installation.loadDiningExceptionWorker()).rejects.toThrow(
    "PILOT_INSTALLATION_UNAVAILABLE",
  );
  const id = (n) => "0190fa85-0000-7000-8000-" + String(n).padStart(12, "0");
  const scope = { tenantReference: id(1), brandReference: id(2), storeReference: id(3) };
  await save("internal-test-profile.json", {
    environment: "InternalTest",
    database: "synthetic_pilot",
    binding: scope,
  });
  const config = {
    schemaVersion: 1,
    environment: "InternalTest",
    database: "synthetic_pilot",
    providerAccountReference: id(4),
    scope,
  };
  await save("dining-exception-worker.json", config);
  expect(await installation.loadDiningExceptionWorker()).toEqual({
    providerAccountReference: id(4),
    scope,
  });
  for (const change of [
    { environment: "Live" },
    { database: "other" },
    { providerAccountReference: "bad" },
    { scope: { ...scope, storeReference: id(99) } },
    { extra: true },
  ]) {
    await save("dining-exception-worker.json", { ...config, ...change });
    await expect(installation.loadDiningExceptionWorker()).rejects.toThrow(
      "PILOT_INSTALLATION_UNAVAILABLE",
    );
  }
  await save("dining-exception-worker.json", config);
  await chmod(join(directory, "dining-exception-worker.json"), 0o644);
  await expect(installation.loadDiningExceptionWorker()).rejects.toThrow(
    "PILOT_INSTALLATION_UNAVAILABLE",
  );
});

it("loads explicit scoped Kitchen identity lazily and rejects malformed or cross-scope configuration", async () => {
  const installation = await loadPilotInstallation(directory);
  await expect(installation.loadKitchenWorker()).rejects.toThrow("PILOT_INSTALLATION_UNAVAILABLE");
  const scope = {
    tenantReference: "0190fa30-0000-7000-8000-000000000001",
    brandReference: "0190fa30-0000-7000-8000-000000000002",
    storeReference: "0190fa30-0000-7000-8000-000000000003",
  };
  const worker = {
    schemaVersion: 1,
    environment: "InternalTest",
    database: "synthetic_pilot",
    actorReference: "0190fa30-0000-7000-8000-000000000004",
    scope,
  };
  await save("internal-test-profile.json", {
    environment: "InternalTest",
    database: "synthetic_pilot",
    binding: scope,
  });
  await save("kitchen-queue-worker.json", worker);
  expect(await installation.loadKitchenWorker()).toEqual({
    actorReference: worker.actorReference,
    scope,
  });
  for (const change of [
    { actorReference: null },
    { actorReference: "bad" },
    { scope: { ...scope, storeReference: worker.actorReference } },
    { environment: "Live" },
    { database: "other" },
    { schemaVersion: 2 },
    { extra: true },
  ]) {
    await save("kitchen-queue-worker.json", { ...worker, ...change });
    await expect(installation.loadKitchenWorker()).rejects.toThrow(
      "PILOT_INSTALLATION_UNAVAILABLE",
    );
  }
  await save("kitchen-queue-worker.json", worker);
  await chmod(join(directory, "kitchen-queue-worker.json"), 0o644);
  await expect(installation.loadKitchenWorker()).rejects.toThrow("PILOT_INSTALLATION_UNAVAILABLE");
});

it("binds business identities and workflow loads to the configured installation", async () => {
  const scope = {
    tenantReference: "0190fa30-0000-7000-8000-000000000001",
    brandReference: "0190fa30-0000-7000-8000-000000000002",
    storeReference: "0190fa30-0000-7000-8000-000000000003",
  };
  const actor = "0190fa30-0000-7000-8000-000000000004";
  const worker = {
    schemaVersion: 1,
    environment: "InternalTest",
    database: "synthetic_pilot",
    providerAccountReference: actor,
    scope,
    actors: { paidOutcome: actor, orderCompletion: actor, kitchenQueue: actor },
  };
  await save("internal-test-profile.json", {
    environment: "InternalTest",
    database: "synthetic_pilot",
    binding: scope,
  });
  const installation = await loadPilotInstallation(directory);
  await expect(installation.loadBusinessWorker()).rejects.toThrow("PILOT_INSTALLATION_UNAVAILABLE");
  await save("business-worker.json", worker);
  expect((await installation.loadBusinessWorker()).actors).toEqual(worker.actors);
  expect((await installation.loadBusinessWorker()).workloads).toEqual({
    batchCancellation: false,
    compensation: false,
  });
  await save("business-worker.json", {
    ...worker,
    workloads: { batchCancellation: true, compensation: false },
  });
  expect((await installation.loadBusinessWorker()).workloads).toEqual({
    batchCancellation: true,
    compensation: false,
  });
  for (const workloads of [
    { compensation: true },
    { batchCancellation: false, compensation: "true" },
    { batchCancellation: true, compensation: false, extra: true },
  ]) {
    await save("business-worker.json", { ...worker, workloads });
    await expect(installation.loadBusinessWorker()).rejects.toThrow(
      "PILOT_INSTALLATION_UNAVAILABLE",
    );
  }

  for (const change of [
    { actors: { paidOutcome: actor } },
    { providerAccountReference: null },
    { enableCompensation: true },
    { scope: { ...scope, storeReference: actor } },
  ]) {
    await save("business-worker.json", { ...worker, ...change });
    await expect(installation.loadBusinessWorker()).rejects.toThrow(
      "PILOT_INSTALLATION_UNAVAILABLE",
    );
  }
  const workflow = {
    environment: "InternalTest",
    database: "synthetic_pilot",
    scope,
    workflow: {},
  };
  await save("internal-test-workflow-Pickup.json", workflow);
  expect(await installation.loadWorkflow("Pickup")).toEqual(workflow);
  await expect(installation.loadWorkflow("../profile")).rejects.toThrow(
    "PILOT_INSTALLATION_UNAVAILABLE",
  );
  await save("internal-test-workflow-Pickup.json", {
    ...workflow,
    scope: { ...scope, storeReference: actor },
  });
  await expect(installation.loadWorkflow("Pickup")).rejects.toThrow(
    "PILOT_INSTALLATION_UNAVAILABLE",
  );
});
it("reads the existing receipt template through the protected file boundary", async () => {
  const installation = await loadPilotInstallation(directory);
  const reference = "0190fa30-0000-7000-8000-000000000004";
  const template = {
    environment: "InternalTest",
    templateReference: reference,
    familyReference: reference,
    versionReference: reference,
  };
  await save("internal-test-receipt-template.json", template);
  expect(await installation.loadReceiptTemplate()).toEqual(template);
  await save("internal-test-receipt-template.json", { ...template, environment: "Live" });
  await expect(installation.loadReceiptTemplate()).rejects.toThrow(
    "PILOT_INSTALLATION_UNAVAILABLE",
  );
});

it("validates customer runtime scope, cart timeouts and bounded table file names", async () => {
  const ref = "0190fa30-0000-7000-8000-000000000004",
    scope = { tenantReference: ref, brandReference: ref, storeReference: ref };
  await save("internal-test-profile.json", {
    environment: "InternalTest",
    database: "synthetic_pilot",
    binding: scope,
  });
  const config = {
    schemaVersion: 1,
    environment: "InternalTest",
    database: "synthetic_pilot",
    providerAccountReference: ref,
    controlReference: ref,
    scope,
    cart: { policyVersionReference: ref, idleTimeoutSeconds: 3600, absoluteTimeoutSeconds: 86400 },
    diningTableFiles: ["internal-test-dining-table.json"],
  };
  const installation = await loadPilotInstallation(directory);
  await save("customer-runtime.json", config);
  expect(await installation.loadCustomerRuntime()).toEqual(config);
  for (const change of [
    { diningTableFiles: ["../secret"] },
    { diningTableFiles: [] },
    { diningTableFiles: ["internal-test-dining-table.json", "internal-test-dining-table.json"] },
    { cart: { ...config.cart, idleTimeoutSeconds: 0 } },
    { cart: { ...config.cart, absoluteTimeoutSeconds: 1 } },
    { scope: { ...scope, storeReference: "other" } },
    { controlReference: null },
  ]) {
    await save("customer-runtime.json", { ...config, ...change });
    await expect(installation.loadCustomerRuntime()).rejects.toThrow(
      "PILOT_INSTALLATION_UNAVAILABLE",
    );
  }
  const data = {
    environment: "InternalTest",
    database: "synthetic_pilot",
    scope: { ...scope, stockSiteReference: ref },
  };
  await save("internal-test-inventory.json", data);
  expect(await installation.loadCustomerData("internal-test-inventory.json")).toEqual(data);
  await expect(installation.loadCustomerData("../installation.json")).rejects.toThrow(
    "PILOT_INSTALLATION_UNAVAILABLE",
  );
  await save("internal-test-inventory.json", {
    ...data,
    scope: { ...scope, tenantReference: "other" },
  });
  await expect(installation.loadCustomerData("internal-test-inventory.json")).rejects.toThrow(
    "PILOT_INSTALLATION_UNAVAILABLE",
  );
});

it("loads exact merchant mapping and workstation without adding authority and binds task queue scope", async () => {
  const ref = "0190fa30-0000-7000-8000-000000000004",
    scope = { tenantReference: ref, brandReference: ref, storeReference: ref };
  await save("internal-test-profile.json", {
    environment: "InternalTest",
    database: "synthetic_pilot",
    binding: scope,
  });
  const config = {
    schemaVersion: 1,
    environment: "InternalTest",
    database: "synthetic_pilot",
    scope,
    roleMapping: { Manager: ["synthetic_manager"], Owner: [], Finance: [] },
    workstation: { deviceReference: ref, pickupLocationReference: ref },
  };
  const installation = await loadPilotInstallation(directory);
  await save("merchant-runtime.json", config);
  expect(await installation.loadMerchantRuntime()).toEqual(config);
  for (const change of [
    { roleMapping: { Manager: ["bad*"], Owner: [], Finance: [] } },
    { roleMapping: { Manager: [], Owner: [], Finance: [], Admin: [] } },
    { workstation: { deviceReference: ref } },
    { scope: { ...scope, tenantReference: "other" } },
  ]) {
    await save("merchant-runtime.json", { ...config, ...change });
    await expect(installation.loadMerchantRuntime()).rejects.toThrow(
      "PILOT_INSTALLATION_UNAVAILABLE",
    );
  }
  const queue = {
    environment: "InternalTest",
    database: "synthetic_pilot",
    ...scope,
    queueReference: ref,
  };
  await save("internal-test-task-queue.json", queue);
  expect(await installation.loadTaskQueue()).toEqual(queue);
  await save("internal-test-task-queue.json", { ...queue, storeReference: "other" });
  await expect(installation.loadTaskQueue()).rejects.toThrow("PILOT_INSTALLATION_UNAVAILABLE");
});

it("binds daily coverage to the installation and owner window authority", async () => {
  const id = (n) => "0198a107-0000-7000-8000-" + String(n).padStart(12, "0");
  const scope = { tenantReference: id(1), brandReference: id(2), storeReference: id(3) };
  await save("internal-test-profile.json", {
    environment: "InternalTest",
    database: "synthetic_pilot",
    binding: scope,
  });
  const coverage = {
    schemaVersion: 1,
    environment: "InternalTest",
    database: "synthetic_pilot",
    scope,
    firstWindow: {
      businessDate: "2026-09-20",
      startsAt: "2026-09-20T08:00:00.000Z",
      endsAt: "2026-09-21T08:00:00.000Z",
      configurationReference: id(4),
      configurationVersion: 1,
      contentDigest: "sha256:" + "a".repeat(64),
    },
  };
  await save("daily-settlement-coverage.json", coverage);
  const i = await loadPilotInstallation(directory);
  expect(await i.loadDailySettlementCoverage()).toEqual({
    scope,
    firstWindow: coverage.firstWindow,
  });
  for (const patch of [
    { database: "other" },
    { scope: { ...scope, storeReference: id(9) } },
    { firstWindow: { ...coverage.firstWindow, endsAt: coverage.firstWindow.startsAt } },
    { firstWindow: { ...coverage.firstWindow, configurationVersion: 0 } },
    { firstWindow: { ...coverage.firstWindow, contentDigest: "invalid" } },
    { extra: true },
  ]) {
    await save("daily-settlement-coverage.json", { ...coverage, ...patch });
    await expect(i.loadDailySettlementCoverage()).rejects.toThrow();
  }
});
