import { mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  deriveInternalTestStoreFiles,
  issueInternalTestStoreDirectory,
  provisionStoreSimulator,
} from "./pilot-internal-test-store-directory.mjs";
import { createPilotPaymentProvider } from "./pilot-stripe-provider.mjs";
import { loadServedStoreDirectories } from "./pilot-https-entry.mjs";
import { loadPilotInstallation } from "./pilot-installation.mjs";

const store1 = "00000000-0000-7000-8000-000000000003",
  store2 = "01909a2e-1000-7000-8000-000000000010",
  operation = "01909a2e-4000-7000-8000-000000000001",
  queue = "01a0bfd6-b825-709e-aafb-28e2b84a2ebc",
  sku = "0190fa20-0000-7000-8000-00000000000d",
  site1 = "0190fa30-0000-7000-8000-000000000001",
  site2 = "01909a2e-5000-7000-8000-000000000002",
  ref = (n) => "0190fa60-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const binding = {
  tenantReference: "0190ed16-0000-7000-8000-00000000005a",
  brandReference: "00000000-0000-7000-8000-000000000002",
  storeReference: store1,
};
const files = () => ({
  "installation.json": {
    schemaVersion: 1,
    environment: "InternalTest",
    database: "db",
    port: 55435,
    roles: { api: "pilot_api", worker: "pilot_worker" },
  },
  "internal-test-profile.json": {
    environment: "InternalTest",
    database: "db",
    binding: {
      ...binding,
      publicStoreReference: "00000000-0000-7000-8000-000000000001",
      validUntil: "2026-11-26T02:26:31.598Z",
    },
  },
  "internal-test-inventory.json": {
    environment: "InternalTest",
    database: "db",
    scope: { ...binding, stockSiteReference: site1 },
  },
  "internal-test-receipt-template.json": { environment: "InternalTest", versionReference: ref(9) },
  "merchant-runtime.json": { environment: "InternalTest", scope: { ...binding } },
  "business-worker.json": { environment: "InternalTest", scope: { ...binding } },
  "kitchen-queue-worker.json": { environment: "InternalTest", scope: { ...binding } },
  "dining-exception-worker.json": { environment: "InternalTest", scope: { ...binding } },
  "internal-test-menu.json": { environment: "InternalTest", database: "db", skuReference: sku },
  "internal-test-task-queue.json": {
    environment: "InternalTest",
    storeReference: store1,
    queueReference: queue,
    exceptionTaskPolicy: { storeReference: store1, managerQueueReference: queue },
  },
  "customer-runtime.json": {
    schemaVersion: 1,
    environment: "InternalTest",
    database: "db",
    providerAccountReference: "0190fa60-0000-7000-8000-000000000020",
    controlReference: ref(21),
    cart: {
      policyVersionReference: ref(22),
      idleTimeoutSeconds: 3600,
      absoluteTimeoutSeconds: 86400,
    },
    scope: { ...binding },
    diningTableFiles: ["internal-test-dining-table.json"],
  },
  "internal-test-dining-table.json": { label: "DEMO-01", scope: { storeReference: store1 } },
  "internal-test-merchant.v1-backup.json": { scope: { storeReference: store1 } },
  "daily-settlement-coverage.json": { scope: { storeReference: store1 }, firstWindow: {} },
});

it("DEC-BRAND-MULTI-STORE-ONE-INSTALLATION 3d: the TEST Store's files name it, with its own identities and no tables", () => {
  const derived = deriveInternalTestStoreFiles(files(), {
    storeReference: store2,
    operationReference: operation,
    stockSiteReference: site2,
  });
  const text = JSON.stringify(derived);
  expect(text).not.toContain(store1);
  expect(derived["internal-test-profile.json"].binding.storeReference).toBe(store2);
  expect(derived["internal-test-profile.json"].binding.publicStoreReference).not.toBe(
    "00000000-0000-7000-8000-000000000001",
  );
  const newQueue = derived["internal-test-task-queue.json"].queueReference;
  expect(newQueue).not.toBe(queue);
  expect(derived["internal-test-task-queue.json"].exceptionTaskPolicy.managerQueueReference).toBe(
    newQueue,
  );
  // Its own Provider account (segment 6: each Store's money in its own ledger).
  expect(derived["customer-runtime.json"].providerAccountReference).not.toBe(
    "0190fa60-0000-7000-8000-000000000020",
  );
  // Brand-level facts stay shared.
  expect(derived["internal-test-menu.json"].skuReference).toBe(sku);
  // No tables and no history copied.
  expect(derived["customer-runtime.json"].diningTableFiles).toEqual([]);
  expect(Object.keys(derived)).not.toContain("internal-test-dining-table.json");
  expect(Object.keys(derived)).not.toContain("internal-test-merchant.v1-backup.json");
  // Its own first closed business day is recorded later, not the installation Store's.
  expect(Object.keys(derived)).not.toContain("daily-settlement-coverage.json");
  // The same operation derives the same identities.
  expect(
    deriveInternalTestStoreFiles(files(), {
      storeReference: store2,
      operationReference: operation,
      stockSiteReference: site2,
    }),
  ).toEqual(derived);
});
it("refuses outside InternalTest or for the installation's own Store", () => {
  const pilot = files();
  pilot["installation.json"].environment = "Pilot";
  expect(() =>
    deriveInternalTestStoreFiles(pilot, {
      storeReference: store2,
      operationReference: operation,
      stockSiteReference: site2,
    }),
  ).toThrow("INTERNAL_TEST_STORE_DIRECTORY_UNAVAILABLE");
  expect(() =>
    deriveInternalTestStoreFiles(files(), {
      storeReference: store1,
      operationReference: operation,
      stockSiteReference: site2,
    }),
  ).toThrow("INTERNAL_TEST_STORE_DIRECTORY_UNAVAILABLE");
  // v15 2026-10-31: its own stock site, never missing and never the installation Store's.
  for (const stockSiteReference of [undefined, "not-a-reference", site1])
    expect(() =>
      deriveInternalTestStoreFiles(files(), {
        storeReference: store2,
        operationReference: operation,
        stockSiteReference,
      }),
    ).toThrow(expect.objectContaining({ reason: "stock-site-required" }));
});
it("writes stores/<name>/ owner-only with the secrets byte for byte, and lists it once", async () => {
  vi.stubEnv("NODE_ENV", "development");
  const directory = await mkdtemp(join(tmpdir(), "store-dir-"));
  try {
    for (const [name, value] of Object.entries(files()))
      await writeFile(join(directory, name), JSON.stringify(value));
    await writeFile(join(directory, "api-password"), "secret-bytes\n", { mode: 0o600 });
    for (const secret of ["worker-password", "guest-abuse-pepper", "internal-test-keys.json"])
      await writeFile(join(directory, secret), "{}", { mode: 0o600 });
    await writeFile(join(directory, "simulated-provider.sqlite"), "store one's payments");
    // v15 2026-10-31: what the installation's own services and operators leave there.
    for (const runtime of [
      "business-worker.pid",
      "customer.log",
      "supervisor.lock",
      "api.health.json",
      "api.health.json.tmp",
      "release581-runtime-final.log",
      "recovery615-result.json",
      "session607.mjs",
      "migration-admin-password",
      "environment.env",
      "customer-tls-key.pem",
    ])
      await writeFile(join(directory, runtime), "{}", { mode: 0o600 });
    const issued = await issueInternalTestStoreDirectory({
      directory,
      name: "demo-2",
      storeReference: store2,
      operationReference: operation,
      stockSiteReference: site2,
    });
    expect(issued.directory).toBe("stores/demo-2");
    expect(await loadServedStoreDirectories(directory)).toEqual(["stores/demo-2"]);
    expect(await readFile(join(directory, "stores/demo-2/api-password"), "utf8")).toBe(
      "secret-bytes\n",
    );
    expect((await stat(join(directory, "stores/demo-2"))).mode & 0o777).toBe(0o700);
    // Its own payment simulator, with its tables and no records: never the installation Store's
    // payments, never a bare file (v15 2026-10-31).
    const simulator = new DatabaseSync(join(directory, "stores/demo-2/simulated-provider.sqlite"));
    try {
      const tables = simulator
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all()
        .map((row) => row.name);
      expect(tables).toEqual(
        expect.arrayContaining(["cancelled_outcome", "failed_outcome", "intent", "outcome"]),
      );
      for (const table of tables)
        expect(simulator.prepare(`SELECT count(*) n FROM ${table}`).get().n, table).toBe(0);
    } finally {
      simulator.close();
    }
    expect((await stat(join(directory, "stores/demo-2/api-password"))).mode & 0o777).toBe(0o600);
    const profile = JSON.parse(
      await readFile(join(directory, "stores/demo-2/internal-test-profile.json"), "utf8"),
    );
    expect(profile.binding.storeReference).toBe(store2);
    // Only what its services read: its configuration, the keys and passwords they use and an
    // empty payment simulator — never pids, locks, health, logs, evidence or other credentials.
    expect((await readdir(join(directory, "stores/demo-2"))).sort()).toEqual(
      [
        "api-password",
        "business-worker.json",
        "customer-runtime.json",
        "dining-exception-worker.json",
        "guest-abuse-pepper",
        "installation.json",
        "internal-test-inventory.json",
        "internal-test-keys.json",
        "internal-test-menu.json",
        "internal-test-profile.json",
        "internal-test-receipt-template.json",
        "internal-test-task-queue.json",
        "kitchen-queue-worker.json",
        "merchant-runtime.json",
        "simulated-provider.sqlite",
        "worker-password",
      ].sort(),
    );
    const inventory = JSON.parse(
      await readFile(join(directory, "stores/demo-2/internal-test-inventory.json"), "utf8"),
    );
    expect(inventory.scope).toMatchObject({ storeReference: store2, stockSiteReference: site2 });
    await expect(
      issueInternalTestStoreDirectory({
        directory,
        name: "demo-3",
        storeReference: store2,
        operationReference: operation,
        stockSiteReference: site2,
      }),
    ).rejects.toMatchObject({ reason: "store-already-served" });
    await expect(
      issueInternalTestStoreDirectory({
        directory,
        name: "demo-2",
        storeReference: "01909a2e-1000-7000-8000-000000000011",
        operationReference: operation,
        stockSiteReference: site2,
      }),
    ).rejects.toMatchObject({ reason: "stores-list-invalid" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
it("v15 2026-10-31: the issued Store directory loads through the real installation loader", async () => {
  vi.stubEnv("NODE_ENV", "development");
  const directory = await realpath(await mkdtemp(join(tmpdir(), "store-dir-")));
  try {
    for (const [name, value] of Object.entries(files()))
      await writeFile(join(directory, name), JSON.stringify(value), { mode: 0o600 });
    for (const secret of [
      "api-password",
      "worker-password",
      "guest-abuse-pepper",
      "internal-test-keys.json",
    ])
      await writeFile(join(directory, secret), "{}", { mode: 0o600 });
    await issueInternalTestStoreDirectory({
      directory,
      name: "demo-2",
      storeReference: store2,
      operationReference: store2,
      stockSiteReference: site2,
    });
    const store = await loadPilotInstallation(join(directory, "stores/demo-2"));
    const customer = await store.loadCustomerRuntime();
    expect(customer.scope.storeReference).toBe(store2);
    expect(customer.diningTableFiles).toEqual([]);
    expect((await store.loadProfile()).binding.storeReference).toBe(store2);
    // v15 2026-10-31: the Store's reconciliation execution opens its payment simulator exactly so.
    const storeDirectory = join(directory, "stores/demo-2"),
      simulatorPath = join(storeDirectory, "simulated-provider.sqlite");
    const open = () =>
      createPilotPaymentProvider(
        {},
        {
          directory: storeDirectory,
          path: simulatorPath,
          loadProfile: store.loadProfile,
          expectedDatabaseName: store.database,
        },
      );
    (await open()).close();
    // The repair (`provider`) adds the tables to a bare file and never removes a record.
    await writeFile(simulatorPath, "", { mode: 0o600 });
    await expect(open()).rejects.toThrow();
    await provisionStoreSimulator(storeDirectory);
    (await open()).close();
    const db = new DatabaseSync(simulatorPath);
    db.prepare(
      "INSERT INTO intent VALUES ('pi_DEMO0','b','s','a','o','i','f','100','2026-10-31T00:00:00.000Z')",
    ).run();
    db.close();
    await provisionStoreSimulator(storeDirectory);
    const again = new DatabaseSync(simulatorPath);
    expect(again.prepare("SELECT count(*) n FROM intent").get().n).toBe(1);
    again.close();
    // Writing the directory again is refused: the Store's simulator records stay as they are.
    await expect(
      issueInternalTestStoreDirectory({
        directory,
        name: "demo-2",
        storeReference: store2,
        operationReference: store2,
        stockSiteReference: site2,
      }),
    ).rejects.toMatchObject({ reason: "stores-list-invalid" });
  } finally {
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
});
