import { expect, it, afterEach, beforeEach, vi } from "vitest";
import { mkdtemp, writeFile, chmod, rm, symlink, rename, realpath } from "node:fs/promises";
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
  directory = await realpath(await mkdtemp(join(tmpdir(), "bop-installation-")));
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

it("loads explicit Product v2 selectors without defaults and retains the original v1 mapping", async () => {
  const id = (n) => "0190fa30-0000-7000-8000-" + String(n).padStart(12, "0"),
    scope = { tenantReference: id(1), brandReference: id(2), storeReference: id(3) },
    product = {
      contentPolicy: {
        configurationVersionReference: id(4),
        expectedBrandVersion: 2,
        policyReference: id(5),
        policyVersion: 3,
      },
      maximumApprovalValiditySeconds: 3600,
    },
    value = {
      schemaVersion: 2,
      environment: "InternalTest",
      database: "synthetic_pilot",
      scope,
      roleMapping: { Manager: ["synthetic_manager"], Owner: [], Finance: [] },
      workstation: { deviceReference: id(6), pickupLocationReference: id(7) },
      product,
    };
  await save("internal-test-profile.json", {
    environment: "InternalTest",
    database: "synthetic_pilot",
    binding: scope,
  });
  const installation = await loadPilotInstallation(directory);
  await save("merchant-runtime.json", value);
  const loaded = await installation.loadMerchantRuntime();
  expect(loaded).toEqual(value);
  expect(Object.isFrozen(loaded.product)).toBe(true);
  expect(Object.isFrozen(loaded.product.contentPolicy)).toBe(true);
  for (const changed of [
    { ...value, schemaVersion: 1 },
    { ...value, schemaVersion: 3 },
    { ...value, product: null },
    { ...value, product: { ...product, credentials: {} } },
    { ...value, product: { ...product, maximumApprovalValiditySeconds: 0 } },
    { ...value, product: { ...product, maximumApprovalValiditySeconds: 86401 } },
    { ...value, product: { ...product, maximumApprovalValiditySeconds: 1.5 } },
    { ...value, product: { ...product, maximumApprovalValiditySeconds: "3600" } },
    { ...value, product: { contentPolicy: product.contentPolicy } },
    {
      ...value,
      product: { ...product, contentPolicy: { ...product.contentPolicy, tenantReference: id(1) } },
    },
    {
      ...value,
      product: { ...product, contentPolicy: { ...product.contentPolicy, expectedBrandVersion: 0 } },
    },
    {
      ...value,
      product: {
        ...product,
        contentPolicy: { ...product.contentPolicy, policyVersion: 2147483648 },
      },
    },
    {
      ...value,
      product: { ...product, contentPolicy: { ...product.contentPolicy, policyReference: "bad" } },
    },
    {
      ...value,
      product: {
        ...product,
        contentPolicy: { ...product.contentPolicy, configurationVersionReference: {} },
      },
    },
    { ...value, scope: { ...scope, brandReference: id(9) } },
  ]) {
    await save("merchant-runtime.json", changed);
    await expect(installation.loadMerchantRuntime()).rejects.toThrow(
      /^PILOT_INSTALLATION_UNAVAILABLE$/,
    );
  }
  const { product: omitted, ...legacy } = value;
  expect(omitted).toBe(product);
  await save("merchant-runtime.json", { ...legacy, schemaVersion: 1 });
  expect(await installation.loadMerchantRuntime()).toEqual({ ...legacy, schemaVersion: 1 });
  await save("merchant-runtime.json", legacy);
  await expect(installation.loadMerchantRuntime()).rejects.toThrow(
    /^PILOT_INSTALLATION_UNAVAILABLE$/,
  );
});

function authoringMerchantFixture() {
  const id = (n) => "0190fa30-0000-7000-8000-" + String(n).padStart(12, "0"),
    scope = { tenantReference: id(1), brandReference: id(2), storeReference: id(3) },
    authoringSources = {
      configurationVersionReference: id(8),
      expectedBrandVersion: 1,
      policyReference: id(9),
      policyVersion: 2147483647,
      allergenRegistryVersionReference: null,
    },
    value = {
      schemaVersion: 2,
      environment: "InternalTest",
      database: "synthetic_pilot",
      scope,
      roleMapping: { Manager: ["synthetic_manager"], Owner: [], Finance: [] },
      workstation: { deviceReference: id(6), pickupLocationReference: id(7) },
      product: {
        contentPolicy: {
          configurationVersionReference: id(4),
          expectedBrandVersion: 2,
          policyReference: id(5),
          policyVersion: 3,
        },
        maximumApprovalValiditySeconds: 3600,
        authoringSources,
      },
    };
  return { id, scope, value, authoringSources };
}
it.each([null, "0190fa30-0000-7000-8000-000000000010"])(
  "loads explicit optional authoring selectors with allergen pin %s and freezes the detached selection",
  async (pin) => {
    const { scope, value } = authoringMerchantFixture();
    value.product.authoringSources.allergenRegistryVersionReference = pin;
    await save("internal-test-profile.json", {
      environment: "InternalTest",
      database: "synthetic_pilot",
      binding: scope,
    });
    await save("merchant-runtime.json", value);
    const installation = await loadPilotInstallation(directory);
    const loaded = await installation.loadMerchantRuntime();
    expect(loaded).toEqual(value);
    expect(Object.isFrozen(loaded.product.authoringSources)).toBe(true);
    expect(Object.isFrozen(loaded.product.contentPolicy)).toBe(true);
    value.product.authoringSources.policyVersion = 2;
    expect(loaded.product.authoringSources.policyVersion).toBe(2147483647);
    expect(() => {
      loaded.product.authoringSources.expectedBrandVersion = 2;
    }).toThrow(TypeError);
  },
);
it("omitting authoringSources keeps the original publication-only v2 shape without defaults", async () => {
  const { scope, value } = authoringMerchantFixture();
  delete value.product.authoringSources;
  await save("internal-test-profile.json", {
    environment: "InternalTest",
    database: "synthetic_pilot",
    binding: scope,
  });
  await save("merchant-runtime.json", value);
  const loaded = await (await loadPilotInstallation(directory)).loadMerchantRuntime();
  expect(loaded).toEqual(value);
  expect(Object.hasOwn(loaded.product, "authoringSources")).toBe(false);
});
it("refuses partial, malformed and mixed authoring source keys rather than filling defaults", async () => {
  const { id, scope, value, authoringSources } = authoringMerchantFixture();
  await save("internal-test-profile.json", {
    environment: "InternalTest",
    database: "synthetic_pilot",
    binding: scope,
  });
  const installation = await loadPilotInstallation(directory);
  const invalid = [
    null,
    [],
    false,
    "configuration",
    {},
    ...Object.keys(authoringSources).map((key) =>
      Object.fromEntries(Object.entries(authoringSources).filter(([name]) => name !== key)),
    ),
    { ...authoringSources, credentials: {} },
    { ...authoringSources, contentPolicy: value.product.contentPolicy },
    { ...authoringSources, maximumApprovalValiditySeconds: 3600 },
    { ...authoringSources, tenantReference: id(1) },
    { ...authoringSources, enabled: true },
    ...["configurationVersionReference", "policyReference"].flatMap((key) =>
      [null, 1, {}, "bad", id(10).replace("-7000-", "-4000-"), id(10).toUpperCase()].map(
        (reference) => ({ ...authoringSources, [key]: reference }),
      ),
    ),
    ...["expectedBrandVersion", "policyVersion"].flatMap((key) =>
      [0, -1, 2147483648, 1.5, "1", null].map((version) => ({
        ...authoringSources,
        [key]: version,
      })),
    ),
    ...[false, {}, 1, "bad", id(10).replace("-7000-", "-4000-")].map((pin) => ({
      ...authoringSources,
      allergenRegistryVersionReference: pin,
    })),
  ];
  for (const sources of invalid) {
    await save("merchant-runtime.json", {
      ...value,
      product: { ...value.product, authoringSources: sources },
    });
    await expect(installation.loadMerchantRuntime()).rejects.toThrow(
      "PILOT_INSTALLATION_UNAVAILABLE",
    );
  }
  for (const changed of [
    { ...value, schemaVersion: 1 },
    { ...value, schemaVersion: 3 },
    { ...value, authoringSources },
    { ...value, product: { ...value.product, authoringSources, enableAuthoring: true } },
  ]) {
    await save("merchant-runtime.json", changed);
    await expect(installation.loadMerchantRuntime()).rejects.toThrow(
      "PILOT_INSTALLATION_UNAVAILABLE",
    );
  }
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

function optionPublicationFixture() {
  const f = authoringMerchantFixture();
  const sources = {
    brandConfigurationVersionReference: f.id(21),
    expectedBrandVersion: 1,
    policyReference: f.id(22),
    policyVersion: 2147483647,
    optionSetPolicyFamilyReference: f.id(23),
    mediaScope: { kind: "Brand", brandReference: f.scope.brandReference, storeReference: null },
  };
  return {
    ...f,
    sources,
    value: { ...f.value, product: { ...f.value.product, optionSetPublicationSources: sources } },
  };
}
it.each(["Brand", "Store"])(
  "loads independent Option publication selectors and freezes %s Media scope",
  async (kind) => {
    const { scope, value, sources } = optionPublicationFixture();
    sources.mediaScope = {
      kind,
      brandReference: scope.brandReference,
      storeReference: kind === "Store" ? scope.storeReference : null,
    };
    await save("internal-test-profile.json", {
      environment: "InternalTest",
      database: "synthetic_pilot",
      binding: scope,
    });
    await save("merchant-runtime.json", value);
    const loaded = await (await loadPilotInstallation(directory)).loadMerchantRuntime();
    expect(loaded.product.optionSetPublicationSources).toEqual(sources);
    expect(loaded.product.optionSetPublicationSources.policyReference).not.toBe(
      loaded.product.contentPolicy.policyReference,
    );
    expect(Object.isFrozen(loaded.product.optionSetPublicationSources)).toBe(true);
    expect(Object.isFrozen(loaded.product.optionSetPublicationSources.mediaScope)).toBe(true);
    expect(() => {
      loaded.product.optionSetPublicationSources.mediaScope.brandReference = "bad";
    }).toThrow(TypeError);
  },
);
it("refuses malformed, partial and cross-scope Option publication configuration", async () => {
  const { id, scope, value, sources } = optionPublicationFixture();
  await save("internal-test-profile.json", {
    environment: "InternalTest",
    database: "synthetic_pilot",
    binding: scope,
  });
  const installation = await loadPilotInstallation(directory);
  const invalid = [
    null,
    {},
    { ...sources, extra: true },
    ...[
      "brandConfigurationVersionReference",
      "policyReference",
      "optionSetPolicyFamilyReference",
    ].map((key) => ({ ...sources, [key]: "bad" })),
    ...[0, 2147483648, 1.5, "1"].flatMap((n) =>
      ["policyVersion", "expectedBrandVersion"].map((key) => ({ ...sources, [key]: n })),
    ),
    { ...sources, mediaScope: { ...sources.mediaScope, extra: true } },
    { ...sources, mediaScope: { kind: "Brand", brandReference: id(99), storeReference: null } },
    {
      ...sources,
      mediaScope: {
        kind: "Brand",
        brandReference: scope.brandReference,
        storeReference: scope.storeReference,
      },
    },
    {
      ...sources,
      mediaScope: { kind: "Store", brandReference: scope.brandReference, storeReference: null },
    },
    {
      ...sources,
      mediaScope: { kind: "Store", brandReference: scope.brandReference, storeReference: id(99) },
    },
    {
      ...sources,
      mediaScope: { kind: "Unknown", brandReference: scope.brandReference, storeReference: null },
    },
  ];
  for (const selection of invalid) {
    await save("merchant-runtime.json", {
      ...value,
      product: { ...value.product, optionSetPublicationSources: selection },
    });
    await expect(installation.loadMerchantRuntime()).rejects.toThrow(
      /^PILOT_INSTALLATION_UNAVAILABLE$/,
    );
  }
});
it("omitted Option selectors preserve both existing Product selectors without a default Option source", async () => {
  const { scope, value } = authoringMerchantFixture();
  await save("internal-test-profile.json", {
    environment: "InternalTest",
    database: "synthetic_pilot",
    binding: scope,
  });
  await save("merchant-runtime.json", value);
  const loaded = await (await loadPilotInstallation(directory)).loadMerchantRuntime();
  expect(loaded.product).toEqual(value.product);
  expect(loaded.product).not.toHaveProperty("optionSetPublicationSources");
});
function optionPriceFixture() {
  const f = authoringMerchantFixture(),
    sources = {
      currencyMetadata: {
        currencyCode: "CAD",
        minorUnitExponent: 2,
        metadataVersion: 1,
        metadataVersionReference: f.id(30),
        metadataDigest: "sha256:" + "a".repeat(64),
      },
      publicationPolicyFamilyReference: f.id(31),
    };
  return {
    ...f,
    sources,
    value: { ...f.value, product: { ...f.value.product, optionPriceSources: sources } },
  };
}
it.each([0, 6])(
  "loads exact public currency exponent %s with explicit independent policy and freezes detached metadata",
  async (exponent) => {
    const { scope, value, sources } = optionPriceFixture();
    sources.currencyMetadata.minorUnitExponent = exponent;
    sources.currencyMetadata.metadataVersion = Number.MAX_SAFE_INTEGER;
    await save("internal-test-profile.json", {
      environment: "InternalTest",
      database: "synthetic_pilot",
      binding: scope,
    });
    await save("merchant-runtime.json", value);
    const loaded = await (await loadPilotInstallation(directory)).loadMerchantRuntime();
    expect(loaded.product.optionPriceSources).toEqual(sources);
    expect(Object.isFrozen(loaded.product.optionPriceSources)).toBe(true);
    expect(Object.isFrozen(loaded.product.optionPriceSources.currencyMetadata)).toBe(true);
    expect(loaded.product.optionPriceSources.publicationPolicyFamilyReference).not.toBe(
      loaded.product.contentPolicy.policyReference,
    );
    sources.currencyMetadata.currencyCode = "USD";
    expect(loaded.product.optionPriceSources.currencyMetadata.currencyCode).toBe("CAD");
    expect(() => {
      loaded.product.optionPriceSources.currencyMetadata.minorUnitExponent = 9;
    }).toThrow(TypeError);
  },
);
it("refuses incomplete, malformed, authority-bearing or token-bearing OptionPrice selectors using actual public constructors", async () => {
  const { scope, value, sources } = optionPriceFixture();
  await save("internal-test-profile.json", {
    environment: "InternalTest",
    database: "synthetic_pilot",
    binding: scope,
  });
  const installation = await loadPilotInstallation(directory),
    metadata = sources.currencyMetadata;
  const invalid = [
    null,
    {},
    { currencyMetadata: metadata },
    { publicationPolicyFamilyReference: sources.publicationPolicyFamilyReference },
    { ...sources, authority: {} },
    { ...sources, enabled: true },
    { ...sources, credentials: { token: "private" } },
    { ...sources, publicationPolicyFamilyReference: "private-token" },
    ...Object.keys(metadata).map((key) => ({
      ...sources,
      currencyMetadata: Object.fromEntries(
        Object.entries(metadata).filter(([field]) => field !== key),
      ),
    })),
    ...[-1, 7, 1.5, "2"].map((value) => ({
      ...sources,
      currencyMetadata: { ...metadata, minorUnitExponent: value },
    })),
    ...[0, -1, 1.5, "1", Number.MAX_SAFE_INTEGER + 1].map((value) => ({
      ...sources,
      currencyMetadata: { ...metadata, metadataVersion: value },
    })),
    ...["cad", "CAD-token", ""].map((value) => ({
      ...sources,
      currencyMetadata: { ...metadata, currencyCode: value },
    })),
    { ...sources, currencyMetadata: { ...metadata, metadataVersionReference: "private-token" } },
    { ...sources, currencyMetadata: { ...metadata, metadataDigest: "sha256:" + "A".repeat(64) } },
    { ...sources, currencyMetadata: { ...metadata, secret: "private" } },
    { ...sources, currencyMetadata: null },
  ];
  for (const selection of invalid) {
    await save("merchant-runtime.json", {
      ...value,
      product: { ...value.product, optionPriceSources: selection },
    });
    await expect(installation.loadMerchantRuntime()).rejects.toThrow(
      /^PILOT_INSTALLATION_UNAVAILABLE$/,
    );
  }
});
it("omitted OptionPrice sources preserve existing v2 selectors with no default currency or governing family", async () => {
  const { scope, value } = authoringMerchantFixture();
  await save("internal-test-profile.json", {
    environment: "InternalTest",
    database: "synthetic_pilot",
    binding: scope,
  });
  await save("merchant-runtime.json", value);
  const loaded = await (await loadPilotInstallation(directory)).loadMerchantRuntime();
  expect(loaded.product).toEqual(value.product);
  expect(loaded.product).not.toHaveProperty("optionPriceSources");
});
it("OptionPrice selectors cannot bypass the real pilot Tenant Brand Store profile binding", async () => {
  const { id, scope, value } = optionPriceFixture();
  await save("internal-test-profile.json", {
    environment: "InternalTest",
    database: "synthetic_pilot",
    binding: scope,
  });
  await save("merchant-runtime.json", { ...value, scope: { ...scope, brandReference: id(99) } });
  await expect((await loadPilotInstallation(directory)).loadMerchantRuntime()).rejects.toThrow(
    /^PILOT_INSTALLATION_UNAVAILABLE$/,
  );
});
