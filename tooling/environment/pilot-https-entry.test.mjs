import { expect, it, vi } from "vitest";
import { startConfiguredPilotHttps, parsePilotHttpsArguments } from "./pilot-https-entry.mjs";
import { composeMerchantDependencies } from "./pilot-merchant-composition.mjs";
const scope = { tenantReference: "tenant", brandReference: "brand", storeReference: "store" };
const customerConfig = { scope, diningTableFiles: ["internal-test-dining-table.json"] };
const merchantConfig = {
  scope,
  roleMapping: { Manager: ["synthetic"], Owner: [], Finance: [] },
  workstation: { deviceReference: "device", pickupLocationReference: "location" },
};
const installation = {
  database: "synthetic",
  loadCustomerRuntime: async () => customerConfig,
  loadMerchantRuntime: async () => merchantConfig,
  loadCustomerData: async () => ({ label: "Synthetic table" }),
  loadProfile: async () => ({ profile: true }),
};
const setup = () => ({
  loadInstallation: async () => installation,
  composeCustomer: () => ({}),
  composeMerchant: () => vi.fn(),
  createQr: () => ({ loadInternalPickupQr: vi.fn(), loadInternalDiningQr: vi.fn() }),
});
it("preserves existing table selectors and protected TLS paths without opening resources eagerly", async () => {
  const resources = { publicProfile: { binding: scope } },
    createResources = vi.fn(async () => resources);
  const result = await startConfiguredPilotHttps("/synthetic", {
    ...setup(),
    createResources,
    startServer: async (options) => {
      expect(createResources).not.toHaveBeenCalled();
      expect(options.keyFile).toBe("/synthetic/customer-tls-key.pem");
      expect(options.certificateFile).toBe("/synthetic/customer-tls-cert.pem");
      expect(options.diningEntries[0].selector).toBe("table-1");
      expect(options.diningEntries[0].label).toBe("Synthetic table");
      expect(typeof options.createInternalMerchant).toBe("function");
      expect(await options.createInternalTestResources()).toBe(resources);
      return "server";
    },
  });
  expect(result).toBe("server");
});
it("rejects inconsistent merchant/customer scope before composing or starting", async () => {
  const composeCustomer = vi.fn(),
    startServer = vi.fn();
  await expect(
    startConfiguredPilotHttps("/synthetic", {
      ...setup(),
      loadInstallation: async () => ({
        ...installation,
        loadMerchantRuntime: async () => ({
          ...merchantConfig,
          scope: { ...scope, storeReference: "other" },
        }),
      }),
      composeCustomer,
      startServer,
    }),
  ).rejects.toThrow("PILOT_HTTPS_SCOPE_CHANGED");
  expect(composeCustomer).not.toHaveBeenCalled();
  expect(startServer).not.toHaveBeenCalled();
});
it("closes resources if binding changes during startup", async () => {
  const close = vi.fn(async () => undefined);
  await expect(
    startConfiguredPilotHttps("/synthetic", {
      ...setup(),
      createResources: async () => ({
        close,
        publicProfile: { binding: { ...scope, storeReference: "other" } },
      }),
      startServer: async (opts) => opts.createInternalTestResources(),
    }),
  ).rejects.toThrow("PILOT_HTTPS_SCOPE_CHANGED");
  expect(close).toHaveBeenCalledOnce();
});
it("preserves configured refund roles, provider and Pickup workstation without granting anything", () => {
  const provider = vi.fn(),
    send = vi.fn(),
    reconcile = vi.fn(),
    pickup = vi.fn();
  const dependencies = composeMerchantDependencies(
    "/synthetic",
    installation,
    merchantConfig,
    { providerAccountReference: "account" },
    {
      createInternalSimulatedProvider: provider,
      createInternalPickupProof: vi.fn(),
      paymentChannel: "InternalTestOnlineCardAutomatic",
    },
    {
      implementations: {
        createInternalCredentialLoaders: () => ({ createInternalMerchantCredentials: vi.fn() }),
        createInternalDiningCredentialLoaders: () => ({ createInternalDiningCredentials: vi.fn() }),
        createInternalRefundSend: send,
        createInternalRefundReconciliation: reconcile,
        createInternalMerchantPickup: pickup,
      },
    },
  );
  expect(dependencies.roleMapping).toBe(merchantConfig.roleMapping);
  expect(dependencies.exceptionPaymentMode).toBe("InternalTestOnlineCardAutomatic");
  dependencies.createInternalRefundSend({ request: "existing" });
  dependencies.createInternalRefundReconciliation({ request: "existing" });
  dependencies.createInternalMerchantPickup({}, {});
  expect(send.mock.calls[0][0]).toMatchObject({
    request: "existing",
    providerAccountReference: "account",
    createSimulatedProvider: provider,
  });
  expect(typeof reconcile.mock.calls[0][0].refreshOrderReceiptObservations).toBe("function");
  expect(pickup.mock.calls[0][3].workstation).toBe(merchantConfig.workstation);
  expect(Object.keys(dependencies).sort()).toEqual(
    [
      "exceptionPaymentMode",
      "providerAccountReference",
      "expectedDatabaseName",
      "roleMapping",
      "loadTaskQueue",
      "loadPricingCurrencyMetadata",
      "createInternalRefundPreparation",
      "createInternalRefundSend",
      "createInternalRefundReconciliation",
      "createInternalDiningCredentials",
      "createInternalMerchantDining",
      "createInternalKitchenCommand",
      "createInternalMerchantPickup",
      "createInternalMerchantAcceptance",
      "createInternalMerchantSession",
      // WP-2423 P6: the unmatched capture refund is sent through the configured provider.
      "refundUnmatchedCapture",
    ].sort(),
  );
  expect(typeof dependencies.refundUnmatchedCapture).toBe("function");
});
it("accepts only an explicit safe installation", () => {
  expect(parsePilotHttpsArguments([".local/pilot-example"])).toBe(".local/pilot-example");
  for (const args of [[], ["../other"], [".local/pilot", "extra"], [null]])
    expect(() => parsePilotHttpsArguments(args)).toThrow();
});
it("opens Product credentials and handlers only through the explicitly configured composition", async () => {
  const product = {
      contentPolicy: {
        configurationVersionReference: "configuration",
        expectedBrandVersion: 2,
        policyReference: "policy",
        policyVersion: 3,
      },
      maximumApprovalValiditySeconds: 3600,
    },
    cursor = vi.fn(async () => new Uint8Array(32)),
    createProduct = vi.fn(async (_resources, options) => {
      await options.createCursorKey();
      return { productList: "configured" };
    }),
    dependencies = composeMerchantDependencies(
      "/synthetic",
      installation,
      { ...merchantConfig, product },
      { providerAccountReference: "account" },
      {},
      {
        implementations: {
          createInternalCredentialLoaders: () => ({ createInternalCatalogCursorKey: cursor }),
          createInternalDiningCredentialLoaders: () => ({}),
          createInternalMerchantProduct: createProduct,
        },
      },
    ),
    resources = { actual: "resources" },
    persistence = { actual: "persistence" },
    authentication = { actual: "authentication" };
  expect(createProduct).not.toHaveBeenCalled();
  expect(cursor).not.toHaveBeenCalled();
  expect(
    await dependencies.createInternalMerchantProduct(resources, persistence, authentication),
  ).toEqual({ productList: "configured" });
  expect(createProduct).toHaveBeenCalledWith(resources, {
    persistence,
    authentication,
    configuration: { scope, product },
    createCursorKey: cursor,
  });
  expect(cursor).toHaveBeenCalledOnce();
});
