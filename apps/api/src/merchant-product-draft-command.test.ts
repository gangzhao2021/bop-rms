import { expect, it, vi } from "vitest";
import { CatalogError } from "@rms/catalog";
import { createMerchantProductDraftCommand } from "./merchant-product-draft-command.js";
vi.mock("./merchant-brand-scope.js", () => ({
  createMerchantBrandScope: () => () => {
    throw new Error("Scope not used in decode-only test");
  },
}));
const id = (n: number) => `019a2421-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-09-29T12:00:00.000Z";
const draft = {
  versionReference: id(4),
  baseVersionReference: null,
  status: "Draft",
  defaultLocale: "en-CA",
  localizedNames: { "en-CA": "Synthetic" },
  taxClassificationReference: null,
  createdAt: at,
  updatedAt: at,
  skus: [],
  optionBindings: [],
};
const content = {
  profile: "CatalogProductEditorContentV1",
  localizedShortDescriptions: {},
  localizedDescriptions: {},
  preparationNotes: {},
  tagReferences: [],
  attributeValues: [],
  media: [],
  variantDimensions: [],
  variantCombinations: [],
  optionRules: [],
  allergenReferences: [],
  nutritionProfile: null,
};
function setup(configured = false) {
  const run = vi.fn(async () => {
    throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
  });
  const execute = createMerchantProductDraftCommand({
    merchant: { transactions: { run }, now: () => at } as never,
    authentication: { authorize: async () => ({ sessionReference: id(5) }) } as never,
    auditReference: () => id(6),
    ...(configured ? { editorContentAuthority: async () => undefined } : {}),
  });
  return {
    run,
    post: (value: unknown) =>
      execute({
        sessionCookie: "synthetic",
        csrf: "synthetic",
        command: {
          productReference: id(1),
          draft: value,
          expectedAggregateVersion: 1,
          operationReference: id(2),
        },
        expectedScope: { brandReference: id(6), storeReference: id(7) },
      }),
  };
}
it("legacy HTTP Draft refuses complete fields until its authority/transport is configured", async () => {
  const f = setup();
  await expect(f.post({ ...draft, editorContent: content })).rejects.toMatchObject({
    code: "CATALOG_INPUT_INVALID",
  });
  expect(f.run).not.toHaveBeenCalled();
});
it("supported Draft still reaches the actual owner preparation path", async () => {
  const f = setup();
  await expect(f.post(draft)).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(f.run).toHaveBeenCalledTimes(1);
});
it("new nested content accessor cannot run during HTTP decode", async () => {
  const f = setup(),
    getter = vi.fn(() => []);
  await expect(
    f.post({
      ...draft,
      editorContent: Object.defineProperty({ ...content }, "tagReferences", {
        get: getter,
        enumerable: true,
      }),
    }),
  ).rejects.toMatchObject({ code: "CATALOG_INPUT_INVALID" });
  expect(getter).not.toHaveBeenCalled();
  expect(f.run).not.toHaveBeenCalled();
});

it("configured complete Draft reaches owner preparation without a caller readiness flag", async () => {
  const f = setup(true);
  await expect(f.post({ ...draft, editorContent: content })).rejects.toMatchObject({
    code: "CATALOG_DEPENDENCY_UNAVAILABLE",
  });
  expect(f.run).toHaveBeenCalledTimes(1);
});
it("configured complete Draft still refuses unknown nested fields before transaction", async () => {
  const f = setup(true);
  await expect(
    f.post({ ...draft, editorContent: { ...content, clientReady: true } }),
  ).rejects.toMatchObject({
    code: "CATALOG_INPUT_INVALID",
  });
  expect(f.run).not.toHaveBeenCalled();
});

it("refuses missing or competing registered-content configuration before authentication", () => {
  const merchant = { now: () => at, transactions: { run: vi.fn() } } as never;
  for (const registeredEditorContent of [
    { registryAuthority: undefined, remainingAuthority: vi.fn() },
    {
      registryAuthority: { holdUntilTransactionCompletes: vi.fn() },
      remainingAuthority: undefined,
    },
    { registryAuthority: { holdUntilTransactionCompletes: vi.fn() }, remainingAuthority: vi.fn() },
  ]) {
    expect(() =>
      createMerchantProductDraftCommand({
        merchant,
        authentication: { authorize: vi.fn() },
        auditReference: () => id(10),
        editorContentAuthority: async () => undefined,
        registeredEditorContent: registeredEditorContent as never,
      }),
    ).toThrow(CatalogError);
  }
});

it("maps malformed configured registry methods to a bounded dependency error", () => {
  expect(() =>
    createMerchantProductDraftCommand({
      merchant: { now: () => at, transactions: { run: vi.fn() } } as never,
      authentication: { authorize: vi.fn() },
      auditReference: () => id(10),
      registeredEditorContent: {
        registryAuthority: { holdUntilTransactionCompletes: 123 } as never,
        remainingAuthority: async () => undefined,
      },
    }),
  ).toThrow(CatalogError);
});

it("requires exactly one remaining holder and callable Variant history configuration", () => {
  const registryAuthority = { holdUntilTransactionCompletes: vi.fn() };
  for (const variantHistory of [
    null,
    {},
    { authority: { holdUntilTransactionCompletes: 1 }, remainingAuthority: vi.fn() },
    { authority: { holdUntilTransactionCompletes: vi.fn() } },
  ]) {
    expect(() =>
      createMerchantProductDraftCommand({
        merchant: { now: () => at, transactions: { run: vi.fn() } } as never,
        authentication: { authorize: vi.fn() },
        auditReference: () => id(10),
        registeredEditorContent: { registryAuthority, variantHistory } as never,
      }),
    ).toThrow(CatalogError);
  }
  expect(() =>
    createMerchantProductDraftCommand({
      merchant: { now: () => at, transactions: { run: vi.fn() } } as never,
      authentication: { authorize: vi.fn() },
      auditReference: () => id(10),
      registeredEditorContent: {
        registryAuthority,
        remainingAuthority: vi.fn(),
        variantHistory: { authority: registryAuthority, remainingAuthority: vi.fn() },
      } as never,
    }),
  ).toThrow(CatalogError);
  expect(() =>
    createMerchantProductDraftCommand({
      merchant: { now: () => at, transactions: { run: vi.fn() } } as never,
      authentication: { authorize: vi.fn() },
      auditReference: () => id(10),
      registeredEditorContent: {
        registryAuthority,
        variantHistory: { authority: registryAuthority, remainingAuthority: vi.fn() },
      },
    }),
  ).not.toThrow();
});

it("requires current Brand/policy holders and exact server selectors as a single remaining source", () => {
  const holder = { holdUntilTransactionCompletes: vi.fn() };
  const config = {
    configurationVersionReference: id(15),
    expectedBrandVersion: 1,
    policyReference: id(16),
    policyVersion: 1,
    brandAuthority: { withCurrentContentRead: vi.fn(), isCurrent: vi.fn() },
    policyAuthority: holder,
    remainingAuthority: vi.fn(),
  };
  const build = (contentPolicy: unknown, remainingAuthority?: unknown) =>
    createMerchantProductDraftCommand({
      merchant: { now: () => at, transactions: { run: vi.fn() } } as never,
      authentication: { authorize: vi.fn() },
      auditReference: () => id(10),
      registeredEditorContent: {
        registryAuthority: holder,
        variantHistory: {
          authority: holder,
          contentPolicy,
          ...(remainingAuthority === undefined ? {} : { remainingAuthority }),
        },
      } as never,
    });
  for (const patch of [
    null,
    {},
    { ...config, expectedBrandVersion: 0 },
    { ...config, policyVersion: 2147483648 },
    { ...config, policyReference: "client-selector" },
    { ...config, configurationVersionReference: "client-selector" },
    { ...config, brandAuthority: { isCurrent: vi.fn() } },
    { ...config, policyAuthority: { holdUntilTransactionCompletes: 1 } },
    { ...config, remainingAuthority: undefined },
  ])
    expect(() => build(patch)).toThrow(CatalogError);
  expect(() => build(config, vi.fn())).toThrow(CatalogError);
  expect(() => build(config)).not.toThrow();
});

it("accepts only exclusive complete pinned Option configuration inside current policy", () => {
  const holder = { holdUntilTransactionCompletes: vi.fn() };
  const config = {
    configurationVersionReference: id(15),
    expectedBrandVersion: 1,
    policyReference: id(16),
    policyVersion: 1,
    brandAuthority: { withCurrentContentRead: vi.fn(), isCurrent: vi.fn() },
    policyAuthority: holder,
    pinnedOptions: { optionAuthority: holder, remainingAuthority: vi.fn() },
  };
  const build = (contentPolicy: unknown) =>
    createMerchantProductDraftCommand({
      merchant: { now: () => at, transactions: { run: vi.fn() } } as never,
      authentication: { authorize: vi.fn() },
      auditReference: () => id(10),
      registeredEditorContent: {
        registryAuthority: holder,
        variantHistory: { authority: holder, contentPolicy },
      },
    } as never);
  expect(() => build(config)).not.toThrow();
  for (const patch of [
    { ...config, remainingAuthority: vi.fn() },
    { ...config, pinnedOptions: null },
    { ...config, pinnedOptions: {} },
    { ...config, pinnedOptions: { optionAuthority: holder } },
    { ...config, pinnedOptions: { remainingAuthority: vi.fn() } },
  ])
    expect(() => build(patch)).toThrow(CatalogError);
});
it("Draft Media/Safety requires exclusive actual source ports and a remaining field holder", () => {
  const holder = { holdUntilTransactionCompletes: vi.fn() },
    mediaSafety = {
      allergenRegistryVersionReference: id(17),
      mediaAuthority: holder,
      safetyAuthority: holder,
      remainingAuthority: vi.fn(),
    },
    pinnedOptions = { optionAuthority: holder, mediaSafety },
    contentPolicy = {
      configurationVersionReference: id(15),
      expectedBrandVersion: 1,
      policyReference: id(16),
      policyVersion: 1,
      brandAuthority: { withCurrentContentRead: vi.fn(), isCurrent: vi.fn() },
      policyAuthority: holder,
    };
  const build = (value: unknown) =>
    createMerchantProductDraftCommand({
      merchant: { now: () => at, transactions: { run: vi.fn() } } as never,
      authentication: { authorize: vi.fn() },
      auditReference: () => id(10),
      registeredEditorContent: {
        registryAuthority: holder,
        variantHistory: {
          authority: holder,
          contentPolicy: { ...contentPolicy, pinnedOptions: value },
        },
      },
    } as never);
  expect(() => build(pinnedOptions)).not.toThrow();
  expect(() =>
    build({
      ...pinnedOptions,
      mediaSafety: { ...mediaSafety, allergenRegistryVersionReference: null },
    }),
  ).not.toThrow();
  for (const value of [
    { ...pinnedOptions, remainingAuthority: vi.fn() },
    { ...pinnedOptions, mediaSafety: null },
    { ...pinnedOptions, mediaSafety: { ...mediaSafety, mediaAuthority: undefined } },
    { ...pinnedOptions, mediaSafety: { ...mediaSafety, safetyAuthority: undefined } },
    { ...pinnedOptions, mediaSafety: { ...mediaSafety, remainingAuthority: undefined } },
    {
      ...pinnedOptions,
      mediaSafety: { ...mediaSafety, allergenRegistryVersionReference: "invalid" },
    },
  ])
    expect(() => build(value)).toThrow(CatalogError);
});
