import { beforeEach, expect, it, vi } from "vitest";
import { createInternalMerchantProduct } from "./pilot-merchant-product.mjs";

const ports = vi.hoisted(() => ({
  publication: vi.fn(),
  optionPriceAuthoring: vi.fn(),
  optionPriceReview: vi.fn(),
  creation: vi.fn(),
  sellingUnits: vi.fn(),
  draft: vi.fn(),
  authoringResolution: vi.fn(),
  authoringContext: vi.fn(),
  editor: vi.fn(),
  lifecycle: vi.fn(),
  list: vi.fn(),
  capability: vi.fn(),
  optionAuthoring: vi.fn(),
  optionEditor: vi.fn(),
  optionHistory: vi.fn(),
  optionCurrentPublication: vi.fn(),
  productOptionPicker: vi.fn(),
  optionContext: vi.fn(),
  optionResolution: vi.fn(),
  optionList: vi.fn(),
  optionPublicationContext: vi.fn(),
  optionPublicationCommand: vi.fn(),
  optionPublicationResolution: vi.fn(),
}));
vi.mock("../../apps/api/dist/merchant-option-price-authoring-command.js", () => ({
  createMerchantOptionPriceAuthoringCommand: ports.optionPriceAuthoring,
}));
vi.mock("../../apps/api/dist/merchant-option-price-review-command.js", () => ({
  createMerchantOptionPriceReviewCommand: ports.optionPriceReview,
}));
vi.mock("../../apps/api/dist/merchant-product-option-picker-query.js", () => ({
  createMerchantProductOptionPickerQuery: ports.productOptionPicker,
}));
vi.mock("../../apps/api/dist/merchant-option-set-publication-command.js", () => ({
  createMerchantOptionSetPublicationCommand: ports.optionPublicationCommand,
}));
vi.mock("../../apps/api/dist/merchant-option-set-publication-resolution-command.js", () => ({
  createMerchantOptionSetPublicationResolutionCommand: ports.optionPublicationResolution,
}));
vi.mock("../../apps/api/dist/merchant-option-set-publication-context-query.js", () => ({
  createMerchantOptionSetPublicationContextQuery: ports.optionPublicationContext,
}));
vi.mock("../../apps/api/dist/merchant-option-set-authoring-command.js", () => ({
  createMerchantOptionSetAuthoringCommand: ports.optionAuthoring,
}));
vi.mock("../../apps/api/dist/merchant-option-set-current-publication-query.js", () => ({
  createMerchantOptionSetCurrentPublicationQuery: ports.optionCurrentPublication,
}));
vi.mock("../../apps/api/dist/merchant-option-set-history-query.js", () => ({
  createMerchantOptionSetHistoryQuery: ports.optionHistory,
}));
vi.mock("../../apps/api/dist/merchant-option-set-editor-query.js", () => ({
  createMerchantOptionSetEditorQuery: ports.optionEditor,
}));
vi.mock("../../apps/api/dist/merchant-option-set-authoring-context-query.js", () => ({
  createMerchantOptionSetAuthoringContextQuery: ports.optionContext,
}));
vi.mock("../../apps/api/dist/merchant-option-set-authoring-resolution-command.js", () => ({
  createMerchantOptionSetAuthoringResolutionCommand: ports.optionResolution,
}));
vi.mock("../../apps/api/dist/merchant-option-set-list-query.js", () => ({
  createMerchantOptionSetListQuery: ports.optionList,
}));
vi.mock("../../apps/api/dist/merchant-product-selling-unit-registry.js", () => ({
  createMerchantProductSellingUnitRegistry: ports.sellingUnits,
}));
vi.mock("../../apps/api/dist/merchant-product-creation-command.js", () => ({
  createMerchantProductCreationCommand: ports.creation,
}));
vi.mock("../../apps/api/dist/merchant-product-draft-command.js", () => ({
  createMerchantProductDraftCommand: ports.draft,
}));
vi.mock("../../apps/api/dist/merchant-product-authoring-resolution-command.js", () => ({
  createMerchantProductAuthoringResolutionCommand: ports.authoringResolution,
}));
vi.mock("../../apps/api/dist/merchant-product-authoring-context-query.js", () => ({
  createMerchantProductAuthoringContextQuery: ports.authoringContext,
}));
vi.mock("../../apps/api/dist/merchant-product-runtime.js", () => ({
  createMerchantProductPublicationRuntime: ports.publication,
}));
vi.mock("../../apps/api/dist/merchant-product-editor-query.js", () => ({
  createMerchantProductEditorQuery: ports.editor,
}));
vi.mock("../../apps/api/dist/merchant-product-lifecycle-command.js", () => ({
  createMerchantProductLifecycleCommand: ports.lifecycle,
}));
vi.mock("../../apps/api/dist/merchant-product-list-runtime.js", () => ({
  createMerchantProductListRuntime: ports.list,
}));
vi.mock("../../apps/api/dist/merchant-store-capability.js", () => ({
  createMerchantStoreCapability: ports.capability,
}));
const id = (n) => "019a0034-2421-7000-8000-" + n.toString(16).padStart(12, "0"),
  scope = { tenantReference: id(1), brandReference: id(2), storeReference: id(3) },
  resources = {
    publicProfile: { binding: scope },
    scope: { brandReference: id(2), storeReference: id(3) },
  },
  configuration = {
    scope,
    product: {
      contentPolicy: {
        configurationVersionReference: id(4),
        expectedBrandVersion: 2,
        policyReference: id(5),
        policyVersion: 3,
      },
      maximumApprovalValiditySeconds: 3600,
    },
  };
function setup() {
  return {
    persistence: { transactions: {} },
    authentication: { authorize: vi.fn() },
    configuration,
    createCursorKey: vi.fn(async () => new Uint8Array(32).fill(7)),
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  ports.publication.mockReturnValue({
    productPublicationV2: vi.fn(),
    productPublicationWarningAcknowledgement: vi.fn(),
    productPublicationManagementV2: vi.fn(),
    productPublicationValidationReportV2: vi.fn(),
    productPublicationResolution: vi.fn(),
  });
  ports.creation.mockReturnValue(vi.fn());
  ports.draft.mockReturnValue(vi.fn());
  ports.editor.mockReturnValue(vi.fn());
  ports.authoringResolution.mockReturnValue(vi.fn());
  ports.authoringContext.mockReturnValue(vi.fn());
  ports.lifecycle.mockReturnValue(vi.fn());
  ports.list.mockReturnValue(vi.fn());
  ports.capability.mockReturnValue({ observe: vi.fn() });
});
it("connects Option ports only to actual captured server identity generation", async () => {
  const options = setup();
  const credentials = { reference: vi.fn(() => id(30)) };
  const original = credentials.reference;
  const authoring = { create: vi.fn(), edit: vi.fn() };
  const editor = vi.fn(),
    context = vi.fn(),
    resolution = vi.fn();
  ports.optionAuthoring.mockReturnValue(authoring);
  ports.optionEditor.mockReturnValue(editor);
  ports.optionContext.mockReturnValue(context);
  ports.optionResolution.mockReturnValue(resolution);
  const result = await createInternalMerchantProduct({ ...resources, credentials }, options);
  expect(result.optionSetAuthoring).toBe(authoring);
  expect(result.optionSetEditor).toBe(editor);
  expect(result.optionSetAuthoringContext).toBe(context);
  expect(result.optionSetAuthoringResolution).toBe(resolution);
  for (const factory of [
    ports.optionAuthoring,
    ports.optionEditor,
    ports.optionContext,
    ports.optionResolution,
  ]) {
    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory.mock.calls[0][0]).toMatchObject({
      merchant: options.persistence,
      authentication: options.authentication,
    });
  }
  credentials.reference = vi.fn(() => id(31));
  expect(ports.optionAuthoring.mock.calls[0][0].references.generate("Option")).toBe(id(30));
  expect(original).toHaveBeenCalledTimes(1);
  expect(credentials.reference).not.toHaveBeenCalled();
  expect(ports.optionResolution.mock.calls[0][0].auditReference(id(40))).not.toBe(id(40));
});
it("connects actual Option List even when authoring identity generation is unavailable", async () => {
  const options = setup();
  const list = vi.fn();
  ports.optionList.mockReturnValue(list);
  const result = await createInternalMerchantProduct(resources, options);
  expect(result.optionSetList).toBe(list);
  expect(ports.optionList).toHaveBeenCalledExactlyOnceWith({
    merchant: options.persistence,
    authentication: options.authentication,
    cursorKey: await options.createCursorKey(),
  });
  expect(result).not.toHaveProperty("optionSetAuthoring");
});
it("does not invent an Option generator when ordinary startup has none", async () => {
  const result = await createInternalMerchantProduct(resources, setup());
  for (const key of [
    "optionSetAuthoring",
    "optionSetEditor",
    "optionSetAuthoringContext",
    "optionSetAuthoringResolution",
  ]) {
    expect(result).not.toHaveProperty(key);
  }
  expect(ports.optionAuthoring).not.toHaveBeenCalled();
});
it("rejects invalid values from the actual Option identity generator", async () => {
  await createInternalMerchantProduct(
    { ...resources, credentials: { reference: () => "invalid" } },
    setup(),
  );
  expect(() => ports.optionAuthoring.mock.calls[0][0].references.generate("Option")).toThrow();
});
it("connects actual list/editor/feature and the shared publication assembly to the same authentication", async () => {
  const options = setup(),
    result = await createInternalMerchantProduct(resources, options);
  expect(ports.publication).toHaveBeenCalledOnce();
  expect(ports.publication.mock.calls[0][0]).toMatchObject({
    merchant: options.persistence,
    authentication: options.authentication,
    configuration: {
      sources: { contentPolicy: configuration.product.contentPolicy },
      maximumApprovalValiditySeconds: 3600,
    },
  });
  expect(ports.authoringResolution).toHaveBeenCalledExactlyOnceWith({
    merchant: options.persistence,
    authentication: options.authentication,
    auditReference: expect.any(Function),
  });
  expect(ports.authoringContext).toHaveBeenCalledExactlyOnceWith({
    merchant: options.persistence,
    authentication: options.authentication,
  });
  expect(ports.authoringResolution.mock.calls[0][0].auditReference(id(20))).not.toBe(
    ports.publication.mock.calls[0][0].configuration.auditReference(id(20)),
  );
  expect(ports.editor).toHaveBeenCalledExactlyOnceWith({
    merchant: options.persistence,
    authentication: options.authentication,
    currentRuntime: true,
  });
  expect(ports.lifecycle).toHaveBeenCalledExactlyOnceWith({
    merchant: options.persistence,
    authentication: options.authentication,
    currentRuntime: true,
    auditReference: expect.any(Function),
  });
  expect(ports.lifecycle.mock.calls[0][0].auditReference(id(20))).toBe(
    ports.publication.mock.calls[0][0].configuration.auditReference(id(20)),
  );
  expect(ports.capability).toHaveBeenCalledExactlyOnceWith({
    persistence: options.persistence,
    authentication: options.authentication,
    currentProductRuntime: true,
  });
  expect(ports.list.mock.calls[0][0].cursorKey).toEqual(new Uint8Array(32).fill(7));
  expect(Object.keys(result).sort()).toEqual(
    [
      "productOptionPicker",
      "optionSetHistory",
      "optionSetCurrentPublication",
      "optionSetList",
      "optionSetPublicationContext",
      "productPublicationV2",
      "productPublicationWarningAcknowledgement",
      "productPublicationManagementV2",
      "productPublicationValidationReportV2",
      "productPublicationResolution",
      "productAuthoringResolution",
      "productAuthoringContext",
      "productList",
      "productEditor",
      "productLifecycle",
      "storeCapability",
    ].sort(),
  );
  expect(Object.isFrozen(result)).toBe(true);
});
it.each(["tenantReference", "brandReference", "storeReference"])(
  "rejects a changed %s before constructing handlers or reading credentials",
  async (key) => {
    const options = setup();
    options.configuration = { ...configuration, scope: { ...scope, [key]: id(50) } };
    await expect(createInternalMerchantProduct(resources, options)).rejects.toThrow(
      "INTERNAL_PRODUCT_SCOPE_DENIED",
    );
    expect(ports.publication).not.toHaveBeenCalled();
    expect(options.createCursorKey).not.toHaveBeenCalled();
  },
);
it("keeps operation artifact identities stable across startup and distinct across purpose/scope/operation", async () => {
  await createInternalMerchantProduct(resources, setup());
  const first = ports.publication.mock.calls[0][0].configuration;
  await createInternalMerchantProduct(resources, setup());
  const second = ports.publication.mock.calls[1][0].configuration,
    operation = id(20);
  expect(first.auditReference(operation)).toBe(second.auditReference(operation));
  expect(
    new Set([
      first.auditReference(operation),
      first.sources.evidenceReference(operation),
      first.sources.reviewReference(operation),
    ]).size,
  ).toBe(3);
  expect(first.auditReference(operation)).not.toBe(first.auditReference(id(21)));
  expect(first.auditReference(operation)).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/u,
  );
  expect(() => first.auditReference("invalid")).toThrow();
  const changed = { ...scope, storeReference: id(30) };
  await createInternalMerchantProduct(
    { ...resources, scope: { ...resources.scope, storeReference: changed.storeReference } },
    { ...setup(), configuration: { ...configuration, scope: changed } },
  );
  expect(ports.publication.mock.calls[2][0].configuration.auditReference(operation)).not.toBe(
    first.auditReference(operation),
  );
});
it("propagates missing cursor credentials without producing a partially configured BFF", async () => {
  const options = setup();
  options.createCursorKey.mockRejectedValue(new Error("INTERNAL_TEST_CREDENTIALS_UNAVAILABLE"));
  await expect(createInternalMerchantProduct(resources, options)).rejects.toThrow(
    "INTERNAL_TEST_CREDENTIALS_UNAVAILABLE",
  );
  expect(ports.list).not.toHaveBeenCalled();
  expect(ports.editor).not.toHaveBeenCalled();
  expect(ports.lifecycle).not.toHaveBeenCalled();
});

it("connects explicit actual authoring selectors to Create and Draft without callback scaffolds", async () => {
  const authoringSources = {
      ...configuration.product.contentPolicy,
      allergenRegistryVersionReference: null,
    },
    options = setup();
  options.configuration = {
    ...configuration,
    product: { ...configuration.product, authoringSources },
  };
  const result = await createInternalMerchantProduct(resources, options);
  for (const port of [ports.creation, ports.draft]) {
    expect(port).toHaveBeenCalledExactlyOnceWith({
      merchant: options.persistence,
      authentication: options.authentication,
      currentRuntime: true,
      authoringSources,
      auditReference: expect.any(Function),
    });
    expect(Object.isFrozen(port.mock.calls[0][0].authoringSources)).toBe(true);
    expect(port.mock.calls[0][0]).not.toHaveProperty("registeredEditorContent");
  }
  expect(ports.sellingUnits).toHaveBeenCalledExactlyOnceWith({
    merchant: options.persistence,
    authentication: options.authentication,
    auditReference: expect.any(Function),
  });
  expect(result.productSellingUnitRegistry).toBe(ports.sellingUnits.mock.results[0].value);
  expect(result.productCreation).toBe(ports.creation.mock.results[0].value);
  expect(result.productDraft).toBe(ports.draft.mock.results[0].value);
  expect(
    new Set([
      ports.creation.mock.calls[0][0].auditReference(id(20)),
      ports.draft.mock.calls[0][0].auditReference(id(20)),
      ports.authoringResolution.mock.calls[0][0].auditReference(id(20)),
    ]).size,
  ).toBe(3);
});
it("preserves publication-only configuration without inferring authoring sources", async () => {
  const result = await createInternalMerchantProduct(resources, setup());
  expect(ports.creation).not.toHaveBeenCalled();
  expect(ports.draft).not.toHaveBeenCalled();
  expect(result).not.toHaveProperty("productCreation");
  expect(result).not.toHaveProperty("productDraft");
  expect(ports.sellingUnits).not.toHaveBeenCalled();
  expect(result).not.toHaveProperty("productSellingUnitRegistry");
});
it("refuses incomplete or callback-bearing authoring selectors before constructing handlers", async () => {
  const options = setup();
  for (const authoringSources of [
    { ...configuration.product.contentPolicy },
    {
      ...configuration.product.contentPolicy,
      allergenRegistryVersionReference: null,
      remainingAuthority() {
        return undefined;
      },
    },
  ]) {
    options.configuration = {
      ...configuration,
      product: { ...configuration.product, authoringSources },
    };
    await expect(createInternalMerchantProduct(resources, options)).rejects.toThrow();
  }
  expect(ports.creation).not.toHaveBeenCalled();
  expect(ports.publication).not.toHaveBeenCalled();
});

it("connects Option publication Context to actual startup ports without an authoring identity generator", async () => {
  const options = setup(),
    query = vi.fn();
  ports.optionPublicationContext.mockReturnValue(query);
  const result = await createInternalMerchantProduct(resources, options);
  expect(result.optionSetPublicationContext).toBe(query);
  expect(ports.optionPublicationContext).toHaveBeenCalledExactlyOnceWith({
    merchant: options.persistence,
    authentication: options.authentication,
  });
  expect(result).not.toHaveProperty("optionSetAuthoring");
});

function optionPublicationOptions() {
  const options = setup();
  const sources = {
    brandConfigurationVersionReference: id(50),
    expectedBrandVersion: 1,
    policyReference: id(51),
    policyVersion: 2,
    optionSetPolicyFamilyReference: id(52),
    mediaScope: { kind: "Brand", brandReference: scope.brandReference, storeReference: null },
  };
  options.configuration = {
    ...configuration,
    product: { ...configuration.product, optionSetPublicationSources: sources },
  };
  return { options, sources };
}
it("composes independent Option command and Resolve with captured real server generation and separate stable Audit identity", async () => {
  const { options, sources } = optionPublicationOptions();
  const generate = vi.fn(() => id(60)),
    credentials = { reference: generate };
  const command = vi.fn(),
    resolve = vi.fn();
  ports.optionPublicationCommand.mockReturnValue(command);
  ports.optionPublicationResolution.mockReturnValue(resolve);
  const result = await createInternalMerchantProduct({ ...resources, credentials }, options);
  expect(result.optionSetPublicationCommand).toBe(command);
  expect(result.optionSetPublicationResolution).toBe(resolve);
  expect(ports.optionPublicationCommand).toHaveBeenCalledExactlyOnceWith({
    merchant: options.persistence,
    authentication: options.authentication,
    ...sources,
    generateReference: expect.any(Function),
  });
  expect(ports.optionPublicationResolution).toHaveBeenCalledExactlyOnceWith({
    merchant: options.persistence,
    authentication: options.authentication,
    optionSetPolicyFamilyReference: sources.optionSetPolicyFamilyReference,
    auditReference: expect.any(Function),
  });
  credentials.reference = vi.fn(() => id(61));
  expect(ports.optionPublicationCommand.mock.calls[0][0].generateReference()).toBe(id(60));
  expect(generate).toHaveBeenCalledOnce();
  expect(credentials.reference).not.toHaveBeenCalled();
  const audit = ports.optionPublicationResolution.mock.calls[0][0].auditReference;
  expect(audit(id(62))).toBe(audit(id(62)));
  expect(audit(id(62))).not.toBe(ports.optionResolution.mock.calls[0][0].auditReference(id(62)));
});
it("configured Option publication refuses a missing generator before any factory or secret read", async () => {
  const { options } = optionPublicationOptions();
  await expect(createInternalMerchantProduct(resources, options)).rejects.toThrow(
    "INTERNAL_OPTION_PUBLICATION_GENERATOR_UNAVAILABLE",
  );
  expect(ports.publication).not.toHaveBeenCalled();
  expect(ports.optionPublicationCommand).not.toHaveBeenCalled();
  expect(options.createCursorKey).not.toHaveBeenCalled();
});
it("omitted Option publication sources keep read Context without repurposing Product policy or registering writes", async () => {
  await createInternalMerchantProduct(
    { ...resources, credentials: { reference: () => id(60) } },
    setup(),
  );
  expect(ports.optionPublicationContext).toHaveBeenCalledOnce();
  expect(ports.optionPublicationCommand).not.toHaveBeenCalled();
  expect(ports.optionPublicationResolution).not.toHaveBeenCalled();
});
it.each(["Brand", "Store"])(
  "rejects cross-Brand/Store %s Media scope even if installation parser is bypassed",
  async (kind) => {
    const { options, sources } = optionPublicationOptions();
    sources.mediaScope =
      kind === "Brand"
        ? { kind, brandReference: id(70), storeReference: null }
        : { kind, brandReference: scope.brandReference, storeReference: id(70) };
    await expect(
      createInternalMerchantProduct(
        { ...resources, credentials: { reference: () => id(60) } },
        options,
      ),
    ).rejects.toThrow("INTERNAL_OPTION_PUBLICATION_SCOPE_DENIED");
    expect(ports.optionPublicationCommand).not.toHaveBeenCalled();
  },
);
it("actual Option publication generator still rejects invalid generated identities", async () => {
  const { options } = optionPublicationOptions();
  await createInternalMerchantProduct(
    { ...resources, credentials: { reference: () => "invalid" } },
    options,
  );
  expect(() => ports.optionPublicationCommand.mock.calls[0][0].generateReference()).toThrow();
});

it("connects ordinary history reads to actual persistence and authentication without identity allocation", async () => {
  const options = setup(),
    history = vi.fn();
  ports.optionHistory.mockReturnValue(history);
  const result = await createInternalMerchantProduct(resources, options);
  expect(result.optionSetHistory).toBe(history);
  expect(ports.optionHistory).toHaveBeenCalledExactlyOnceWith({
    merchant: options.persistence,
    authentication: options.authentication,
  });
});

it("composes ordinary current Published reads independently from history", async () => {
  const o = setup();
  const reader = vi.fn();
  ports.optionCurrentPublication.mockReturnValue(reader);
  const result = await createInternalMerchantProduct(resources, o);
  expect(result.optionSetCurrentPublication).toBe(reader);
  expect(ports.optionCurrentPublication).toHaveBeenCalledExactlyOnceWith({
    merchant: o.persistence,
    authentication: o.authentication,
  });
});

it("composes the ordinary Product binding picker from actual startup scope ports", async () => {
  const options = setup(),
    picker = vi.fn();
  ports.productOptionPicker.mockReturnValue(picker);
  const result = await createInternalMerchantProduct(resources, options);
  expect(result.productOptionPicker).toBe(picker);
  expect(ports.productOptionPicker).toHaveBeenCalledExactlyOnceWith({
    merchant: options.persistence,
    authentication: options.authentication,
  });
});
// Factory mocks prove composition only; runtime permissions, policy, currency and persistence remain owning checks.
function optionPriceOptions() {
  const options = setup(),
    sources = {
      currencyMetadata: {
        currencyCode: "CAD",
        minorUnitExponent: 2,
        metadataVersion: 1,
        metadataVersionReference: id(70),
        metadataDigest: "sha256:" + "a".repeat(64),
      },
      publicationPolicyFamilyReference: id(71),
    };
  options.configuration = {
    ...configuration,
    product: { ...configuration.product, optionPriceSources: sources },
  };
  return { options, sources };
}
it("composes both genuine OptionPrice factory ports from explicit independent selectors without allocating IDs", async () => {
  const { options, sources } = optionPriceOptions(),
    generate = vi.fn(() => id(72)),
    credentials = { reference: generate },
    authoring = { execute: vi.fn(), resolve: vi.fn(), query: vi.fn() },
    review = { execute: vi.fn(), resolve: vi.fn(), query: vi.fn() };
  ports.optionPriceAuthoring.mockReturnValue(authoring);
  ports.optionPriceReview.mockReturnValue(review);
  const result = await createInternalMerchantProduct({ ...resources, credentials }, options);
  expect(result.optionPriceAuthoring).toBe(authoring);
  expect(result.optionPriceReview).toBe(review);
  expect(generate).not.toHaveBeenCalled();
  for (const factory of [ports.optionPriceAuthoring, ports.optionPriceReview]) {
    expect(factory).toHaveBeenCalledExactlyOnceWith({
      merchant: options.persistence,
      authentication: options.authentication,
      ...sources,
      references: { generate: expect.any(Function) },
    });
    const selected = factory.mock.calls[0][0];
    expect(Object.isFrozen(selected.currencyMetadata)).toBe(true);
    expect(selected.publicationPolicyFamilyReference).not.toBe(
      configuration.product.contentPolicy.policyReference,
    );
    expect(selected).not.toHaveProperty("currentRuntime");
    expect(selected).not.toHaveProperty("sourceAuthority");
  }
  sources.currencyMetadata.currencyCode = "USD";
  sources.publicationPolicyFamilyReference = id(73);
  credentials.reference = vi.fn(() => id(74));
  expect(ports.optionPriceAuthoring.mock.calls[0][0].currencyMetadata.currencyCode).toBe("CAD");
  expect(ports.optionPriceReview.mock.calls[0][0].publicationPolicyFamilyReference).toBe(id(71));
  expect(ports.optionPriceAuthoring.mock.calls[0][0].references.generate("Audit")).toBe(id(72));
  expect(ports.optionPriceReview.mock.calls[0][0].references.generate("PublishingLifecycle")).toBe(
    id(72),
  );
  expect(generate).toHaveBeenCalledTimes(2);
  expect(credentials.reference).not.toHaveBeenCalled();
});
it("configured OptionPrice refuses absent true server UUID generation before factories or keys", async () => {
  const { options } = optionPriceOptions();
  await expect(createInternalMerchantProduct(resources, options)).rejects.toThrow(
    "INTERNAL_OPTION_PRICE_GENERATOR_UNAVAILABLE",
  );
  expect(ports.publication).not.toHaveBeenCalled();
  expect(ports.optionPriceAuthoring).not.toHaveBeenCalled();
  expect(ports.optionPriceReview).not.toHaveBeenCalled();
  expect(options.createCursorKey).not.toHaveBeenCalled();
});
it("the actual supplied generator remains validated at allocation and is never replaced with defaults", async () => {
  const { options } = optionPriceOptions(),
    reference = vi.fn(() => "invalid");
  await createInternalMerchantProduct({ ...resources, credentials: { reference } }, options);
  expect(reference).not.toHaveBeenCalled();
  expect(() => ports.optionPriceAuthoring.mock.calls[0][0].references.generate("Event")).toThrow();
  expect(() =>
    ports.optionPriceReview.mock.calls[0][0].references.generate("PublishingEvidence"),
  ).toThrow();
});
it("omitted OptionPrice selectors register no authoring or review ports even with actual UUID generation", async () => {
  const result = await createInternalMerchantProduct(
    { ...resources, credentials: { reference: () => id(72) } },
    setup(),
  );
  expect(result).not.toHaveProperty("optionPriceAuthoring");
  expect(result).not.toHaveProperty("optionPriceReview");
  expect(ports.optionPriceAuthoring).not.toHaveBeenCalled();
  expect(ports.optionPriceReview).not.toHaveBeenCalled();
});
it.each(["authority", "source", "grant", "enabled", "generateReference"])(
  "rejects caller %s overrides in configured OptionPrice sources",
  async (key) => {
    const { options, sources } = optionPriceOptions();
    options.configuration.product.optionPriceSources = { ...sources, [key]: "private" };
    await expect(
      createInternalMerchantProduct(
        { ...resources, credentials: { reference: () => id(72) } },
        options,
      ),
    ).rejects.toThrow("INTERNAL_OPTION_PRICE_CONFIGURATION_DENIED");
    expect(ports.optionPriceAuthoring).not.toHaveBeenCalled();
    expect(ports.optionPriceReview).not.toHaveBeenCalled();
    expect(options.createCursorKey).not.toHaveBeenCalled();
  },
);
it.each([
  null,
  {},
  { currencyMetadata: null, publicationPolicyFamilyReference: id(71) },
  {
    currencyMetadata: {
      currencyCode: "CAD",
      minorUnitExponent: 2,
      metadataVersion: 1,
      metadataVersionReference: id(70),
      metadataDigest: "sha256:" + "a".repeat(64),
    },
    publicationPolicyFamilyReference: "private-token",
  },
])(
  "refuses missing or malformed OptionPrice source fields instead of inferring Product policy",
  async (sources) => {
    const { options } = optionPriceOptions();
    options.configuration.product.optionPriceSources = sources;
    await expect(
      createInternalMerchantProduct(
        { ...resources, credentials: { reference: () => id(72) } },
        options,
      ),
    ).rejects.toThrow("INTERNAL_OPTION_PRICE_CONFIGURATION_DENIED");
    expect(ports.publication).not.toHaveBeenCalled();
  },
);
it("explicit Pricing configuration preserves actual scope mismatch rejection before all factories", async () => {
  const { options } = optionPriceOptions();
  options.configuration = { ...options.configuration, scope: { ...scope, storeReference: id(99) } };
  await expect(
    createInternalMerchantProduct(
      { ...resources, credentials: { reference: () => id(72) } },
      options,
    ),
  ).rejects.toThrow("INTERNAL_PRODUCT_SCOPE_DENIED");
  expect(ports.optionPriceAuthoring).not.toHaveBeenCalled();
  expect(ports.optionPriceReview).not.toHaveBeenCalled();
});
