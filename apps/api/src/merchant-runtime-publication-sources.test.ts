import { createMediaScope } from "@bop/media";
import { parseBrandReference } from "@bop/tenant";
import {
  createCurrencyMetadataSnapshot,
  parseCurrencyCode,
  parsePricingReference,
  parsePricingDigest,
} from "@rms/pricing";
import { beforeEach, expect, it, vi } from "vitest";
import { createMerchantRuntime, type MerchantRuntimeOptions } from "./merchant-runtime.js";

const mocks = vi.hoisted(() => ({
  assemble: vi.fn(),
  ordinary: vi.fn(),
  management: vi.fn(),
  report: vi.fn(),
  publication: vi.fn(),
  acknowledgement: vi.fn(),
  resolution: vi.fn(),
  resolutionCommand: vi.fn(),
  publicationFactory: vi.fn(),
  acknowledgementFactory: vi.fn(),
  publicationCommand: vi.fn(),
  acknowledgementCommand: vi.fn(),
  creation: vi.fn(),
  creationCommand: vi.fn(),
  draft: vi.fn(),
  draftCommand: vi.fn(),
  optionAuthoring: vi.fn(),
  optionPriceAuthoring: vi.fn(),
  optionPriceReview: vi.fn(),
  optionEditor: vi.fn(),
  optionHistory: vi.fn(),
  optionCurrentPublication: vi.fn(),
  productOptionPicker: vi.fn(),
  optionResolution: vi.fn(),
  optionContext: vi.fn(),
  optionList: vi.fn(),
  optionPublicationContext: vi.fn(),
  optionPublicationCommand: vi.fn(),
  optionPublicationResolution: vi.fn(),
  service: { authorize: vi.fn() },
}));
vi.mock("./merchant-product-option-picker-query.js", () => ({
  createMerchantProductOptionPickerQuery: mocks.productOptionPicker,
}));
vi.mock("./merchant-option-set-publication-command.js", () => ({
  createMerchantOptionSetPublicationCommand: mocks.optionPublicationCommand,
}));
vi.mock("./merchant-option-set-publication-resolution-command.js", () => ({
  createMerchantOptionSetPublicationResolutionCommand: mocks.optionPublicationResolution,
}));
vi.mock("./merchant-option-set-publication-context-query.js", () => ({
  createMerchantOptionSetPublicationContextQuery: mocks.optionPublicationContext,
}));
vi.mock("./merchant-option-set-authoring-command.js", () => ({
  createMerchantOptionSetAuthoringCommand: mocks.optionAuthoring,
}));
vi.mock("./merchant-option-price-authoring-command.js", () => ({
  createMerchantOptionPriceAuthoringCommand: mocks.optionPriceAuthoring,
}));
vi.mock("./merchant-option-price-review-command.js", () => ({
  createMerchantOptionPriceReviewCommand: mocks.optionPriceReview,
}));
vi.mock("./merchant-option-set-current-publication-query.js", () => ({
  createMerchantOptionSetCurrentPublicationQuery: mocks.optionCurrentPublication,
}));
vi.mock("./merchant-option-set-history-query.js", () => ({
  createMerchantOptionSetHistoryQuery: mocks.optionHistory,
}));
vi.mock("./merchant-option-set-editor-query.js", () => ({
  createMerchantOptionSetEditorQuery: mocks.optionEditor,
}));
vi.mock("./merchant-option-set-authoring-resolution-command.js", () => ({
  createMerchantOptionSetAuthoringResolutionCommand: mocks.optionResolution,
}));
vi.mock("./merchant-option-set-authoring-context-query.js", () => ({
  createMerchantOptionSetAuthoringContextQuery: mocks.optionContext,
}));
vi.mock("./merchant-option-set-list-query.js", () => ({
  createMerchantOptionSetListQuery: mocks.optionList,
}));
vi.mock("./merchant-product-draft-command.js", () => ({
  createMerchantProductDraftCommand: mocks.draft,
}));
vi.mock("./merchant-product-creation-command.js", () => ({
  createMerchantProductCreationCommand: mocks.creation,
}));
vi.mock("./merchant-product-publication-management-query-v2.js", () => ({
  createMerchantProductPublicationManagementQueryV2: mocks.management,
}));
vi.mock("./merchant-product-publication-validation-report-query-v2.js", () => ({
  createMerchantProductPublicationValidationReportQueryV2: mocks.report,
}));
vi.mock("./merchant-product-publication-runtime-sources.js", () => ({
  createMerchantProductPublicationRuntimeSources: mocks.ordinary,
}));
vi.mock("./merchant-product-publication-sources.js", () => ({
  createMerchantProductPublicationSources: mocks.assemble,
}));
vi.mock("./merchant-product-publication-command-v2.js", () => ({
  createMerchantProductPublicationCommandV2: mocks.publication,
}));
vi.mock("./merchant-product-publication-warning-acknowledgement-command.js", () => ({
  createMerchantProductPublicationWarningAcknowledgementCommand: mocks.acknowledgement,
}));
vi.mock("./merchant-product-publication-resolution-command.js", () => ({
  createMerchantProductPublicationResolutionCommand: mocks.resolution,
}));
vi.mock("./persistent-merchant-bff.js", () => ({
  createPersistentMerchantBffService: () => mocks.service,
}));
vi.mock("./merchant-service-control.js", () => ({
  createMerchantServiceControl: () => ({ read: vi.fn() }),
}));
vi.mock("./merchant-store-configuration.js", () => ({
  createMerchantStoreConfiguration: () => ({ read: vi.fn() }),
}));
vi.mock("./merchant-dining-tables.js", () => ({ createMerchantDiningTables: () => ({}) }));
beforeEach(() => {
  vi.clearAllMocks();
  mocks.assemble.mockReturnValue({
    publication: mocks.publicationFactory,
    acknowledgement: mocks.acknowledgementFactory,
  });
  mocks.ordinary.mockReturnValue({
    publication: mocks.publicationFactory,
    acknowledgement: mocks.acknowledgementFactory,
  });
  mocks.publication.mockReturnValue(mocks.publicationCommand);
  mocks.acknowledgement.mockReturnValue(mocks.acknowledgementCommand);
  mocks.resolution.mockReturnValue(mocks.resolutionCommand);
  mocks.creation.mockReturnValue(mocks.creationCommand);
  mocks.draft.mockReturnValue(mocks.draftCommand);
});
const setup = () =>
  ({
    persistence: {},
    configuration: {},
    serviceAudit: {},
    productPublicationSources: {},
    productPublicationV2: {},
    productPublicationWarningAcknowledgement: {},
  }) as unknown as MerchantRuntimeOptions;
it.each(["optionPriceAuthoring", "optionPriceReview"] as const)(
  "binds %s to the existing merchant and authentication instead of configuration overrides",
  (key) => {
    const options = setup();
    const configured = {
      currencyMetadata: createCurrencyMetadataSnapshot({
        currencyCode: parseCurrencyCode("CAD"),
        minorUnitExponent: 2,
        metadataVersion: 1,
        metadataVersionReference: parsePricingReference("018fb000-0000-7000-8000-000000000041"),
        metadataDigest: parsePricingDigest("sha256:" + "a".repeat(64)),
      }),
      publicationPolicyFamilyReference: "018fb000-0000-7000-8000-000000000042",
      references: { generate: vi.fn() },
      merchant: {},
      authentication: { authorize: vi.fn() },
    };
    const entry = { query: vi.fn(), execute: vi.fn(), resolve: vi.fn() };
    mocks[key].mockReturnValue(entry);
    const result = createMerchantRuntime({ ...options, [key]: configured });
    expect(mocks[key]).toHaveBeenCalledExactlyOnceWith({
      ...configured,
      merchant: options.persistence,
      authentication: mocks.service,
    });
    expect(result[key]).toBe(entry);
    expect(configured.authentication.authorize).not.toHaveBeenCalled();
    expect(configured.references.generate).not.toHaveBeenCalled();
  },
);
it("does not create a Pricing handler without actual server configuration", () => {
  const result = createMerchantRuntime(setup());
  expect(result.optionPriceAuthoring).toBeUndefined();
  expect(mocks.optionPriceAuthoring).not.toHaveBeenCalled();
  expect(result.optionPriceReview).toBeUndefined();
  expect(mocks.optionPriceReview).not.toHaveBeenCalled();
});
it("composes Option authoring ports with the actual merchant persistence and authentication", () => {
  const options = setup();
  const references = { generate: vi.fn() };
  const auditReference = vi.fn();
  const authoring = { create: vi.fn(), edit: vi.fn() };
  const editor = vi.fn();
  const resolution = vi.fn();
  const context = vi.fn();
  const list = vi.fn(),
    cursorKey = new Uint8Array(32).fill(3);
  mocks.optionAuthoring.mockReturnValue(authoring);
  mocks.optionEditor.mockReturnValue(editor);
  const history = vi.fn();
  mocks.optionHistory.mockReturnValue(history);
  const currentPublication = vi.fn();
  mocks.optionCurrentPublication.mockReturnValue(currentPublication);
  mocks.optionResolution.mockReturnValue(resolution);
  mocks.optionContext.mockReturnValue(context);
  mocks.optionList.mockReturnValue(list);
  const result = createMerchantRuntime({
    ...options,
    optionSetAuthoring: { references },
    optionSetEditor: true,
    optionSetHistory: true,
    optionSetCurrentPublication: true,
    optionSetAuthoringContext: true,
    optionSetList: { cursorKey },
    optionSetAuthoringResolution: { auditReference },
  });
  expect(mocks.optionAuthoring).toHaveBeenCalledExactlyOnceWith({
    merchant: options.persistence,
    authentication: mocks.service,
    references,
  });
  expect(mocks.optionEditor).toHaveBeenCalledExactlyOnceWith({
    merchant: options.persistence,
    authentication: mocks.service,
  });
  expect(mocks.optionResolution).toHaveBeenCalledExactlyOnceWith({
    merchant: options.persistence,
    authentication: mocks.service,
    auditReference,
  });
  expect(result.optionSetAuthoring).toBe(authoring);
  expect(result.optionSetEditor).toBe(editor);
  expect(result.optionSetHistory).toBe(history);
  expect(result.optionSetCurrentPublication).toBe(currentPublication);
  expect(mocks.optionCurrentPublication).toHaveBeenCalledExactlyOnceWith({
    merchant: options.persistence,
    authentication: mocks.service,
  });
  expect(mocks.optionHistory).toHaveBeenCalledExactlyOnceWith({
    merchant: options.persistence,
    authentication: mocks.service,
  });
  expect(result.optionSetAuthoringResolution).toBe(resolution);
  expect(mocks.optionContext).toHaveBeenCalledExactlyOnceWith({
    merchant: options.persistence,
    authentication: mocks.service,
  });
  expect(result.optionSetAuthoringContext).toBe(context);
  expect(result.optionSetList).toBe(list);
  expect(mocks.optionList).toHaveBeenCalledExactlyOnceWith({
    merchant: options.persistence,
    authentication: mocks.service,
    cursorKey,
  });
});
it("leaves unconfigured Option ports unavailable", () => {
  const result = createMerchantRuntime(setup());
  expect(result.optionSetAuthoring).toBeUndefined();
  expect(result.optionSetEditor).toBeUndefined();
  expect(result.optionSetHistory).toBeUndefined();
  expect(result.optionSetCurrentPublication).toBeUndefined();
  expect(result.optionSetAuthoringResolution).toBeUndefined();
  expect(result.optionSetAuthoringContext).toBeUndefined();
  expect(result.optionSetList).toBeUndefined();
  expect(mocks.optionAuthoring).not.toHaveBeenCalled();
  expect(mocks.optionEditor).not.toHaveBeenCalled();
  expect(mocks.optionHistory).not.toHaveBeenCalled();
  expect(mocks.optionResolution).not.toHaveBeenCalled();
  expect(mocks.optionContext).not.toHaveBeenCalled();
  expect(mocks.optionList).not.toHaveBeenCalled();
});
it("forwards actual configured Create admission and content assembly to the ordinary runtime command", () => {
  const options = setup(),
    auditReference = () => "controlled-audit",
    authoringSources = {
      configurationVersionReference: "01902421-0000-7000-8000-000000000001",
      expectedBrandVersion: 1,
      policyReference: "01902421-0000-7000-8000-000000000002",
      policyVersion: 1,
      allergenRegistryVersionReference: null,
    } as NonNullable<NonNullable<MerchantRuntimeOptions["productCreation"]>["authoringSources"]>;
  const result = createMerchantRuntime({
    ...options,
    productCreation: {
      auditReference,
      authoringSources,
      currentRuntime: true,
    },
  });
  expect(mocks.creation).toHaveBeenCalledExactlyOnceWith({
    merchant: options.persistence,
    authentication: mocks.service,
    auditReference,
    authoringSources,
    currentRuntime: true,
  });
  expect(result.productCreation).toBe(mocks.creationCommand);
});
it("forwards current Draft admission with explicit owner source selectors", () => {
  const options = setup(),
    auditReference = () => "controlled-audit",
    authoringSources = {
      configurationVersionReference: "01902421-0000-7000-8000-000000000001",
      expectedBrandVersion: 1,
      policyReference: "01902421-0000-7000-8000-000000000002",
      policyVersion: 1,
      allergenRegistryVersionReference: null,
    } as NonNullable<NonNullable<MerchantRuntimeOptions["productDraft"]>["authoringSources"]>;
  const result = createMerchantRuntime({
    ...options,
    productDraft: { auditReference, authoringSources, currentRuntime: true },
  });
  expect(mocks.draft).toHaveBeenCalledExactlyOnceWith({
    merchant: options.persistence,
    authentication: mocks.service,
    auditReference,
    authoringSources,
    currentRuntime: true,
  });
  expect(result.productDraft).toBe(mocks.draftCommand);
});
it("connects both ordinary authenticated commands to one configured source assembly", () => {
  const options = setup(),
    result = createMerchantRuntime(options);
  expect(mocks.assemble).toHaveBeenCalledExactlyOnceWith(options.productPublicationSources);
  expect(mocks.publication).toHaveBeenCalledExactlyOnceWith({
    merchant: options.persistence,
    authentication: mocks.service,
    sourceFactory: mocks.publicationFactory,
  });
  expect(mocks.acknowledgement).toHaveBeenCalledExactlyOnceWith({
    merchant: options.persistence,
    authentication: mocks.service,
    sourceFactory: mocks.acknowledgementFactory,
  });
  expect(result.productPublicationV2).toBe(mocks.publicationCommand);
  expect(result.productPublicationWarningAcknowledgement).toBe(mocks.acknowledgementCommand);
});
it("retains explicitly supplied legacy configuration without enabling absent commands", () => {
  const options = setup(),
    {
      productPublicationSources: _sources,
      productPublicationWarningAcknowledgement: _ack,
      ...legacy
    } = options;
  void _sources;
  void _ack;
  const result = createMerchantRuntime(legacy);
  expect(mocks.assemble).not.toHaveBeenCalled();
  expect(mocks.publication).toHaveBeenCalledExactlyOnceWith({
    merchant: options.persistence,
    authentication: mocks.service,
  });
  expect(result.productPublicationWarningAcknowledgement).toBeUndefined();
});
it.each(["sources", "sourceFactory", "editorContentAuthority", "currentUniqueScope"])(
  "rejects mixed publication %s and complete assembly",
  (field) => {
    const options = setup();
    expect(() =>
      createMerchantRuntime({ ...options, productPublicationV2: { [field]: {} } as never }),
    ).toThrow(expect.objectContaining({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" }));
    expect(mocks.publication).not.toHaveBeenCalled();
    expect(mocks.acknowledgement).not.toHaveBeenCalled();
  },
);
it.each(["sources", "sourceFactory"])(
  "rejects mixed acknowledgement %s and complete assembly",
  (field) => {
    const options = setup();
    expect(() =>
      createMerchantRuntime({
        ...options,
        productPublicationWarningAcknowledgement: { [field]: {} } as never,
      }),
    ).toThrow(expect.objectContaining({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" }));
    expect(mocks.publication).not.toHaveBeenCalled();
  },
);
it("rejects orphan assembly configuration", () => {
  const {
    productPublicationV2: _pub,
    productPublicationWarningAcknowledgement: _ack,
    ...options
  } = setup();
  void _pub;
  void _ack;
  expect(() => createMerchantRuntime(options)).toThrow(
    expect.objectContaining({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" }),
  );
});

it("assembles ordinary publication and consent with fixed current runtime authorities", () => {
  const {
    productPublicationSources: _sources,
    productPublicationV2: _pub,
    productPublicationWarningAcknowledgement: _ack,
    ...base
  } = setup();
  void _sources;
  void _pub;
  void _ack;
  const ordinary = {
    sources: {} as never,
    auditReference: vi.fn(),
    maximumApprovalValiditySeconds: 300,
  };
  const result = createMerchantRuntime({ ...base, productPublicationRuntime: ordinary });
  expect(mocks.ordinary).toHaveBeenCalledExactlyOnceWith(ordinary.sources);
  expect(mocks.assemble).not.toHaveBeenCalled();
  expect(mocks.publication).toHaveBeenCalledExactlyOnceWith({
    merchant: base.persistence,
    authentication: mocks.service,
    currentRuntime: true,
    auditReference: ordinary.auditReference,
    maximumApprovalValiditySeconds: 300,
    sourceFactory: mocks.publicationFactory,
  });
  expect(mocks.acknowledgement).toHaveBeenCalledExactlyOnceWith({
    merchant: base.persistence,
    authentication: mocks.service,
    currentRuntime: true,
    auditReference: ordinary.auditReference,
    sourceFactory: mocks.acknowledgementFactory,
  });
  expect(mocks.management).toHaveBeenCalledExactlyOnceWith({
    merchant: base.persistence,
    authentication: mocks.service,
    currentRuntime: true,
  });
  expect(mocks.report).toHaveBeenCalledExactlyOnceWith({
    merchant: base.persistence,
    authentication: mocks.service,
    currentRuntime: true,
  });
  expect(mocks.resolution).toHaveBeenCalledExactlyOnceWith({
    merchant: base.persistence,
    authentication: mocks.service,
    currentRuntime: true,
    auditReference: ordinary.auditReference,
  });
  expect(result.productPublicationResolution).toBe(mocks.resolutionCommand);
  expect(result.productPublicationV2).toBe(mocks.publicationCommand);
  expect(result.productPublicationWarningAcknowledgement).toBe(mocks.acknowledgementCommand);
});
it.each([
  "productPublicationSources",
  "productPublicationV2",
  "productPublicationWarningAcknowledgement",
  "productPublicationManagementV2",
  "productPublicationValidationReportV2",
  "productPublicationResolution",
])("refuses ambiguous ordinary runtime and %s", (field) => {
  const {
    productPublicationSources: _sources,
    productPublicationV2: _pub,
    productPublicationWarningAcknowledgement: _ack,
    ...base
  } = setup();
  void _sources;
  void _pub;
  void _ack;
  expect(() =>
    createMerchantRuntime({
      ...base,
      productPublicationRuntime: {
        sources: {} as never,
        auditReference: vi.fn(),
        maximumApprovalValiditySeconds: 300,
      },
      [field]: {},
    }),
  ).toThrow(expect.objectContaining({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" }));
  expect(mocks.ordinary).not.toHaveBeenCalled();
  expect(mocks.publication).not.toHaveBeenCalled();
});

it("composes Option publication Context only from actual runtime persistence and authentication", () => {
  const options = setup(),
    query = vi.fn();
  mocks.optionPublicationContext.mockReturnValue(query);
  const result = createMerchantRuntime({ ...options, optionSetPublicationContext: true });
  expect(result.optionSetPublicationContext).toBe(query);
  expect(mocks.optionPublicationContext).toHaveBeenCalledExactlyOnceWith({
    merchant: options.persistence,
    authentication: mocks.service,
  });
});
it("leaves unconfigured Option publication Context explicitly unavailable", () => {
  const result = createMerchantRuntime(setup());
  expect(result.optionSetPublicationContext).toBeUndefined();
  expect(mocks.optionPublicationContext).not.toHaveBeenCalled();
});

it("composes Option publication command and resolution only from fixed selectors and actual runtime authority", () => {
  const options = setup(),
    command = vi.fn(),
    resolution = vi.fn(),
    ref = "01902421-7600-7000-8000-000000000002";
  const commandOptions = {
      generateReference: () => ref,
      policyReference: ref,
      policyVersion: 1,
      brandConfigurationVersionReference: ref,
      expectedBrandVersion: 1,
      mediaScope: createMediaScope({
        kind: "Brand",
        brandReference: parseBrandReference(ref),
        storeReference: null,
      }),
      optionSetPolicyFamilyReference: ref,
    },
    resolutionOptions = { auditReference: () => ref, optionSetPolicyFamilyReference: ref };
  mocks.optionPublicationCommand.mockReturnValue(command);
  mocks.optionPublicationResolution.mockReturnValue(resolution);
  const result = createMerchantRuntime({
    ...options,
    optionSetPublicationCommand: commandOptions,
    optionSetPublicationResolution: resolutionOptions,
  });
  expect(result.optionSetPublicationCommand).toBe(command);
  expect(result.optionSetPublicationResolution).toBe(resolution);
  expect(mocks.optionPublicationCommand).toHaveBeenCalledExactlyOnceWith({
    ...commandOptions,
    merchant: options.persistence,
    authentication: mocks.service,
  });
  expect(mocks.optionPublicationResolution).toHaveBeenCalledExactlyOnceWith({
    ...resolutionOptions,
    merchant: options.persistence,
    authentication: mocks.service,
  });
});
it("leaves unconfigured Option publication command and resolution explicitly unavailable", () => {
  const result = createMerchantRuntime(setup());
  expect(result.optionSetPublicationCommand).toBeUndefined();
  expect(result.optionSetPublicationResolution).toBeUndefined();
  expect(mocks.optionPublicationCommand).not.toHaveBeenCalled();
  expect(mocks.optionPublicationResolution).not.toHaveBeenCalled();
});

it("constructs Product Option picker only for explicit ordinary runtime configuration", () => {
  const options = setup(),
    picker = vi.fn();
  mocks.productOptionPicker.mockReturnValue(picker);
  expect(createMerchantRuntime(options).productOptionPicker).toBeUndefined();
  expect(
    createMerchantRuntime({ ...options, productOptionPicker: false }).productOptionPicker,
  ).toBeUndefined();
  expect(mocks.productOptionPicker).not.toHaveBeenCalled();
  expect(createMerchantRuntime({ ...options, productOptionPicker: true }).productOptionPicker).toBe(
    picker,
  );
  expect(mocks.productOptionPicker).toHaveBeenCalledExactlyOnceWith({
    merchant: options.persistence,
    authentication: mocks.service,
  });
});
