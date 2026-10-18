import console from "node:console";
import { afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ published: vi.fn(), priceBook: vi.fn() }));
vi.mock("../../packages/rms/store/src/index.ts", () => ({
  createPostgresStoreTaxConfigurationSource: (options) => async (tx, at) =>
    mocks.published(options, tx, at),
}));
vi.mock("../../packages/rms/pricing/src/index.ts", () => ({
  currentStorePriceBook: async () => mocks.priceBook(),
}));
vi.mock("../../packages/rms/catalog/src/index.ts", () => ({
  createPostgresCurrentOptionBindingsStore: vi.fn(),
  listProductVersionTaxClassifications: vi.fn(),
}));
import {
  createInternalConfiguredQuote,
  readInternalQuoteTaxConfiguration,
  readInternalQuoteTaxReadiness,
} from "./pilot-configured-quote.mjs";
afterEach(() => vi.clearAllMocks());

const id = (n) => "0190fa24-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-10-18T15:00:00.000Z";
const tx = { query: vi.fn() };
const authorize = vi.fn(async () => true);
const resources = {
  scope: { brandReference: id(0x100), storeReference: id(0x101) },
  operating: { brandReference: id(0x100), storeReference: id(0x101), authorize },
  transactions: { run: (work) => work(tx) },
  database: {
    acquire: async () => ({
      query: async (sql) => (sql.startsWith("SELECT set_config") ? { rows: [] } : { rows: [] }),
      release: () => undefined,
    }),
  },
  credentials: { reference: () => id(0x200) },
  now: () => at,
};
const policy = {
  validUntil: "2026-11-14T00:00:00.000Z",
  currencyMetadata: { currencyCode: "CAD" },
  taxConfiguration: {
    configurationReference: id(10),
    registrationEvidence: { status: "Verified" },
    professionalEvidence: { result: "Pass" },
  },
};
const store = (taxConfigurationReference) => ({ taxConfigurationReference });

describe("the tax configuration a quote uses", () => {
  it("is the one the Store's configuration published and in force at the quote time names", async () => {
    mocks.published.mockResolvedValueOnce(store(id(10)));
    expect(await readInternalQuoteTaxConfiguration(resources, policy, at)).toEqual({
      ready: true,
      taxConfigurationReference: id(10),
    });
    expect(mocks.published).toHaveBeenCalledWith(
      expect.objectContaining({ ...resources.operating, authorize }),
      tx,
      at,
    );
  });
  it("refuses when the published configuration names another tax configuration than the test file", async () => {
    mocks.published.mockResolvedValueOnce(store(id(11)));
    expect(await readInternalQuoteTaxConfiguration(resources, policy, at)).toEqual({
      ready: false,
      reason: "TaxConfigurationMismatch",
    });
  });
  it("refuses when the published configuration cannot be read", async () => {
    mocks.published.mockRejectedValueOnce(new Error("STORE_TAX_CONFIGURATION_UNAVAILABLE"));
    expect(await readInternalQuoteTaxConfiguration(resources, policy, at)).toEqual({
      ready: false,
      reason: "StoreConfigurationUnavailable",
    });
  });
  it("reports readiness now for the operations monitor, without references", async () => {
    mocks.published.mockResolvedValueOnce(store(id(10)));
    expect(await readInternalQuoteTaxReadiness(resources, async () => policy)).toEqual({
      ready: true,
    });
    expect(mocks.published.mock.calls[0][2]).toBe(at);
    mocks.published.mockResolvedValueOnce(store(id(11)));
    expect(await readInternalQuoteTaxReadiness(resources, async () => policy)).toEqual({
      ready: false,
      reason: "TaxConfigurationMismatch",
    });
  });
});

describe("configured quote policies", () => {
  const compose = () =>
    createInternalConfiguredQuote(resources, "Pickup", { loadPricingPolicy: async () => policy });
  it("price with the published tax configuration at the requested time, and the file's test evidence", async () => {
    mocks.published.mockResolvedValueOnce(store(id(10)));
    mocks.priceBook.mockResolvedValueOnce({ priceBookReference: id(1) });
    const quote = await compose();
    const requestedAt = "2026-10-18T14:59:59.000Z";
    const policies = await quote.policies({ requestedAt });
    expect(mocks.published.mock.calls[0][2]).toBe(requestedAt);
    expect(policies.priceBookReference).toBe(id(1));
    expect(policies.taxConfigurationReference).toBe(id(10));
    expect(await policies.evidence.load()).toEqual({
      registrationEvidence: policy.taxConfiguration.registrationEvidence,
      professionalEvidence: policy.taxConfiguration.professionalEvidence,
    });
  });
  it("make no quote when the Store's published tax configuration and the test file disagree", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      mocks.published.mockResolvedValueOnce(store(id(11)));
      const quote = await compose();
      await expect(quote.policies({ requestedAt: at })).rejects.toThrow(
        "INTERNAL_QUOTE_TAX_CONFIGURATION_MISMATCH",
      );
      expect(mocks.priceBook).not.toHaveBeenCalled();
      mocks.published.mockRejectedValueOnce(new Error("STORE_TAX_CONFIGURATION_UNAVAILABLE"));
      await expect(quote.policies({ requestedAt: at })).rejects.toThrow(
        "INTERNAL_QUOTE_STORE_CONFIGURATION_UNAVAILABLE",
      );
      // The log carries the code only, never a reference.
      expect(log).toHaveBeenCalledTimes(2);
      for (const [line] of log.mock.calls) {
        expect(JSON.parse(line).event).toBe("INTERNAL_QUOTE_TAX_CONFIGURATION_UNAVAILABLE");
        expect(line).not.toContain("0190fa24");
      }
    } finally {
      log.mockRestore();
    }
  });
});
