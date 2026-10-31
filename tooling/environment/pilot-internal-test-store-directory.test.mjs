import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  deriveInternalTestStoreFiles,
  issueInternalTestStoreDirectory,
} from "./pilot-internal-test-store-directory.mjs";
import { loadServedStoreDirectories } from "./pilot-https-entry.mjs";

const store1 = "00000000-0000-7000-8000-000000000003",
  store2 = "01909a2e-1000-7000-8000-000000000010",
  operation = "01909a2e-4000-7000-8000-000000000001",
  queue = "01a0bfd6-b825-709e-aafb-28e2b84a2ebc",
  sku = "0190fa20-0000-7000-8000-00000000000d";
const files = () => ({
  "installation.json": { schemaVersion: 1, environment: "InternalTest", database: "db" },
  "internal-test-profile.json": {
    environment: "InternalTest",
    database: "db",
    binding: {
      tenantReference: "0190ed16-0000-7000-8000-00000000005a",
      brandReference: "00000000-0000-7000-8000-000000000002",
      storeReference: store1,
      publicStoreReference: "00000000-0000-7000-8000-000000000001",
      validUntil: "2026-11-26T02:26:31.598Z",
    },
  },
  "internal-test-menu.json": { environment: "InternalTest", database: "db", skuReference: sku },
  "internal-test-task-queue.json": {
    environment: "InternalTest",
    storeReference: store1,
    queueReference: queue,
    exceptionTaskPolicy: { storeReference: store1, managerQueueReference: queue },
  },
  "customer-runtime.json": {
    environment: "InternalTest",
    providerAccountReference: "0190fa60-0000-7000-8000-000000000020",
    scope: { storeReference: store1 },
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
    }),
  ).toEqual(derived);
});
it("refuses outside InternalTest or for the installation's own Store", () => {
  const pilot = files();
  pilot["installation.json"].environment = "Pilot";
  expect(() =>
    deriveInternalTestStoreFiles(pilot, { storeReference: store2, operationReference: operation }),
  ).toThrow("INTERNAL_TEST_STORE_DIRECTORY_UNAVAILABLE");
  expect(() =>
    deriveInternalTestStoreFiles(files(), {
      storeReference: store1,
      operationReference: operation,
    }),
  ).toThrow("INTERNAL_TEST_STORE_DIRECTORY_UNAVAILABLE");
});
it("writes stores/<name>/ owner-only with the secrets byte for byte, and lists it once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "store-dir-"));
  try {
    for (const [name, value] of Object.entries(files()))
      await writeFile(join(directory, name), JSON.stringify(value));
    await writeFile(join(directory, "api-password"), "secret-bytes\n", { mode: 0o600 });
    await writeFile(join(directory, "simulated-provider.sqlite"), "store one's payments");
    const issued = await issueInternalTestStoreDirectory({
      directory,
      name: "demo-2",
      storeReference: store2,
      operationReference: operation,
    });
    expect(issued.directory).toBe("stores/demo-2");
    expect(await loadServedStoreDirectories(directory)).toEqual(["stores/demo-2"]);
    expect(await readFile(join(directory, "stores/demo-2/api-password"), "utf8")).toBe(
      "secret-bytes\n",
    );
    expect((await stat(join(directory, "stores/demo-2"))).mode & 0o777).toBe(0o700);
    // Its own payment simulator, empty: never the installation Store's payments.
    expect((await stat(join(directory, "stores/demo-2/simulated-provider.sqlite"))).size).toBe(0);
    expect((await stat(join(directory, "stores/demo-2/api-password"))).mode & 0o777).toBe(0o600);
    const profile = JSON.parse(
      await readFile(join(directory, "stores/demo-2/internal-test-profile.json"), "utf8"),
    );
    expect(profile.binding.storeReference).toBe(store2);
    await expect(
      issueInternalTestStoreDirectory({
        directory,
        name: "demo-3",
        storeReference: store2,
        operationReference: operation,
      }),
    ).rejects.toMatchObject({ reason: "store-already-served" });
    await expect(
      issueInternalTestStoreDirectory({
        directory,
        name: "demo-2",
        storeReference: "01909a2e-1000-7000-8000-000000000011",
        operationReference: operation,
      }),
    ).rejects.toMatchObject({ reason: "stores-list-invalid" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
