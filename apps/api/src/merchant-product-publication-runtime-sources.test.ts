import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { parsePublishingProductPublicationPolicy } from "@bop/publishing";
import {
  CatalogError,
  bindCatalogProductPublicationQualificationContext,
  deriveCatalogProductPublicationContentIdentity,
  parseCatalogProductPublicationWarningAcknowledgementCommand,
  parseCatalogInstant,
  parseProductAggregate,
  parseProductPublicationCommandV2,
} from "@rms/catalog";
import { beforeEach, expect, it, vi } from "vitest";
import type { MerchantProductPublicationSourceFactoryV2Input } from "./merchant-product-publication-command-v2.js";
import type { MerchantProductWarningAcknowledgementSourceFactoryInput } from "./merchant-product-publication-warning-acknowledgement-command.js";
import type { MerchantProductPublicationBusinessPolicyOptions } from "./merchant-product-publication-business-policy.js";
import type { MerchantProductPublicationSourcesConfiguration } from "./merchant-product-publication-sources.js";
import { createMerchantProductPublicationRuntimeSources } from "./merchant-product-publication-runtime-sources.js";

// Controlled constructor seams: these tests exercise runtime wiring and the
// real fixed-rule builder/held configuration, not owning SQL or permission.
const mocks = vi.hoisted(() => ({
  authority: vi.fn(),
  shared: vi.fn(),
  business: vi.fn(),
  currentPublished: vi.fn(),
}));
vi.mock("./current-published-product-option-binding-source.js", () => ({
  createCurrentPublishedProductOptionBindingSource: mocks.currentPublished,
}));
vi.mock("./merchant-product-publication-runtime-authority.js", () => ({
  createMerchantProductPublicationRuntimeAuthority: mocks.authority,
}));
vi.mock("./merchant-product-publication-sources.js", () => ({
  createMerchantProductPublicationSources: mocks.shared,
}));
vi.mock("./merchant-product-publication-business-policy.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./merchant-product-publication-business-policy.js")>()),
  createMerchantProductPublicationBusinessPolicy: mocks.business,
}));

type Host = MerchantProductPublicationSourceFactoryV2Input;
type BusinessOptions = MerchantProductPublicationBusinessPolicyOptions;
type ConfigurationInput = Parameters<
  BusinessOptions["configurations"]["withCurrentConfiguration"]
>[1];
const id = (n: number) => `019a2421-0070-7000-8000-${n.toString(16).padStart(12, "0")}`,
  at = "2026-10-04T12:00:00.000Z",
  plus = (ms: number) => new Date(Date.parse(at) + ms).toISOString(),
  hash = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
let businessOptions: BusinessOptions | undefined,
  assembled: MerchantProductPublicationSourcesConfiguration | undefined;
const unused = async (): Promise<never> => {
  throw Error("unused controlled constructor seam");
};
const publicationResult = {
  sources: { withCurrentPolicy: unused, withHeldCurrentFacts: unused },
  editorContentAuthority: unused,
};
const acknowledgementResult = { sources: { withHeldCurrentObservation: unused } };
const currentPublished = { withBindingAssessment: unused, resolveVersion: unused };
beforeEach(() => {
  vi.resetAllMocks();
  businessOptions = undefined;
  assembled = undefined;
  mocks.currentPublished.mockReturnValue(currentPublished);
  mocks.business.mockImplementation((options: BusinessOptions) => {
    businessOptions = options;
    return { withAssessment: unused };
  });
  mocks.shared.mockImplementation(
    (configuration: MerchantProductPublicationSourcesConfiguration) => {
      assembled = configuration;
      return {
        publication: () => publicationResult,
        acknowledgement: () => acknowledgementResult,
      };
    },
  );
});
function fixture() {
  const aggregate = parseProductAggregate({
    productReference: id(1),
    brandReference: id(2),
    internalCode: "RUNTIME_SOURCES",
    productType: "PreparedFood",
    lifecycle: "Draft",
    aggregateVersion: 1,
    createdAt: at,
    updatedAt: at,
    createdByActorReference: id(3),
    draft: {
      versionReference: id(4),
      baseVersionReference: null,
      status: "Draft",
      defaultLocale: "en-CA",
      localizedNames: { "en-CA": "Runtime assembly" },
      taxClassificationReference: null,
      createdAt: at,
      updatedAt: at,
      skus: [
        {
          skuReference: id(5),
          productReference: id(1),
          brandReference: id(2),
          skuCode: "ONE",
          lifecycle: "Active",
          localizedNames: { "en-CA": "One" },
          variantSelections: [],
          unitOfSale: "EA",
          unitQuantity: "1",
          createdAt: at,
          createdByActorReference: id(3),
        },
      ],
      optionBindings: [],
      editorContent: {
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
      },
    },
  });
  const identity = deriveCatalogProductPublicationContentIdentity(aggregate),
    none = { profile: "CatalogProductNoReplacementIntentV1", mode: "None" },
    command = parseProductPublicationCommandV2({
      profile: "CatalogProductPublicationCommandV2",
      purposeCode: "CATALOG_PRODUCT_VERSION_PUBLICATION",
      tenantReference: id(10),
      brandReference: id(2),
      actorReference: id(3),
      actorKind: "User",
      operationReference: id(11),
      productReference: id(1),
      versionReference: id(4),
      expectedProductAggregateVersion: 1,
      expectedPublicationVersion: 0,
      action: "Validate",
      contentDigest: identity.contentDigest,
      configurationDigest: identity.configurationDigest,
      scopeSet: [{ level: "Store", reference: id(12), channelCodes: [], orderTypeCodes: [] }],
      effectivePeriod: {
        timeZone: "UTC",
        effectiveFrom: {
          instant: at,
          localDateTime: at.slice(0, -1),
          utcOffsetMinutes: 0,
        },
        effectiveUntil: null,
      },
      scheduleReference: null,
      replacementVersionReference: null,
      successorDraftVersionReference: null,
      occurredAt: at,
      reasonCode: "CONTROLLED_RUNTIME",
      replacementIntent: { ...none, digest: hash(none) },
      replacementIntentDigest: hash(none),
    }),
    context = bindCatalogProductPublicationQualificationContext(
      { command, aggregate, current: null, content: null, observedAt: at },
      plus(5000),
    ),
    policy = {
      content: parsePublishingProductPublicationPolicy({
        profile: "PublishingProductPublicationPolicyV1",
        tenantReference: id(10),
        brandReference: id(2),
        familyReference: id(20),
        policyReference: id(21),
        policyVersion: 7,
        scopeOrder: ["Store", "StoreGroup", "Region", "Channel", "OrderType", "Brand"],
        approvalPolicy: "Required",
        warningOverrideAllowed: true,
        requiredLocales: ["en-CA"],
        mediaRequirement: "Optional",
        effectiveFrom: at,
        effectiveUntil: plus(86400000),
      }),
      currentPublicationReference: id(22),
      observedAt: context.observedAt,
      validUntil: plus(2000),
    };
  let time = at;
  const tx: Host["transaction"] = { query: async () => ({ rows: [], rowCount: 0 }) },
    guards: { asyncGuard: () => Promise<void>; finalAssert: () => void }[] = [],
    register: Host["registerBeforeCommit"] = async (actual, asyncGuard, finalAssert) => {
      expect(actual).toBe(tx);
      guards.push({ asyncGuard, finalAssert });
    },
    host: Host = {
      transaction: tx,
      command,
      tenantReference: command.tenantReference,
      brandReference: command.brandReference,
      actorReference: command.actorReference,
      storeReference: id(12),
      sessionReference: id(13),
      clock: { now: () => time },
      originalValidUntil: plus(5000),
      registerBeforeCommit: register,
      authorizeMediaAccess: unused,
      capability: {
        holdUntilCommit: vi.fn(async () => undefined),
        leaseDeadline: () => plus(5000),
      },
      currentAuthorization: {
        authorizeActions: unused,
        withCurrentStoreScope: unused,
        assertCurrent: () => parseCatalogInstant(time),
      },
    },
    policyHold = vi.fn(async () => undefined),
    holder = { holdUntilTransactionCompletes: unused },
    references = Object.fromEntries(
      [
        "history",
        "availability",
        "bundle",
        "menu",
        "recipe",
        "recipeInventory",
        "inventory",
        "pricing",
        "priceBook",
        "optionPrice",
        "promotion",
      ].map((name) => [name + "Authority", holder]),
    ),
    authority = {
      contentPolicy: {
        policyAuthority: { holdUntilTransactionCompletes: policyHold },
        brandAuthority: { withCurrentContentRead: unused, isCurrent: unused },
      },
      scope: {
        historyAuthority: holder,
        tenantAuthority: {
          withCurrentBrandReferenceRead: unused,
          isCurrent: unused,
        },
      },
      variant: { authority: holder },
      options: { authority: holder },
      tax: { authority: holder },
      registeredContent: { registryAuthority: holder },
      publicationReferences: references,
      acknowledgementReferences: references,
    };
  mocks.authority.mockReturnValue(authority);
  const options = {
    contentPolicy: {
      configurationVersionReference: id(30),
      expectedBrandVersion: 2,
      policyReference: id(21),
      policyVersion: 7,
    },
    evidenceReference: vi.fn(() => id(31)),
    reviewReference: vi.fn(() => id(32)),
  };
  return {
    host,
    context,
    policy,
    options,
    authority,
    policyHold,
    tx,
    guards,
    setTime: (value: string) => {
      time = value;
    },
    async commit(later?: () => Promise<void>) {
      for (const guard of guards) await guard.asyncGuard();
      if (later) await later();
      for (const guard of guards) expect(guard.finalAssert()).toBeUndefined();
    },
  };
}
function captured() {
  if (!businessOptions || !assembled) throw Error("controlled factory was not invoked");
  return { configuration: businessOptions.configurations, assembled };
}
function start(f: ReturnType<typeof fixture>) {
  createMerchantProductPublicationRuntimeSources(f.options).publication(f.host);
  return captured().configuration;
}
function input(f: ReturnType<typeof fixture>): ConfigurationInput {
  return {
    context: f.context,
    policy: f.policy,
    registerBeforeCommit: f.host.registerBeforeCommit,
  };
}

it("captures configuration without reads and wires the full actual Publication host", () => {
  const f = fixture(),
    factory = createMerchantProductPublicationRuntimeSources(f.options);
  expect(mocks.authority).not.toHaveBeenCalled();
  expect(mocks.shared).not.toHaveBeenCalled();
  expect(mocks.currentPublished).not.toHaveBeenCalled();
  expect(f.options.evidenceReference).not.toHaveBeenCalled();
  f.options.contentPolicy.policyVersion = 99;
  expect(factory.publication(f.host)).toBe(publicationResult);
  expect(mocks.authority).toHaveBeenCalledExactlyOnceWith(f.host);
  const config = captured().assembled;
  expect(config.contentPolicy.policyVersion).toBe(7);
  expect(config.options.currentPublished).toBe(currentPublished);
  expect(mocks.currentPublished).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      transaction: f.host.transaction,
      currentAuthorization: f.host.currentAuthorization,
      capability: f.host.capability,
      clock: f.host.clock,
      originalValidUntil: f.host.originalValidUntil,
      registerBeforeCommit: f.host.registerBeforeCommit,
      tenantReference: f.host.tenantReference,
      brandReference: f.host.brandReference,
      storeReference: f.host.storeReference,
      actorReference: f.host.actorReference,
      sessionReference: f.host.sessionReference,
    }),
  );
  expect(f.host.capability?.holdUntilCommit).not.toHaveBeenCalled();
  expect(config.contentPolicy.brandAuthority).toBe(f.authority.contentPolicy.brandAuthority);
  expect(config.publicationReferences).toBe(f.authority.publicationReferences);
  expect(config.acknowledgementReferences).toBe(f.authority.acknowledgementReferences);
  expect(f.policyHold).not.toHaveBeenCalled();
});
it("retains the distinct Ack command without executing or changing its action", () => {
  const f = fixture(),
    command = parseCatalogProductPublicationWarningAcknowledgementCommand({
      profile: "CatalogProductPublicationWarningAcknowledgementCommandV1",
      purposeCode: "CATALOG_PRODUCT_PUBLICATION_WARNING_ACKNOWLEDGEMENT",
      action: "AcknowledgeProductPublicationWarnings",
      tenantReference: id(10),
      brandReference: id(2),
      actorReference: id(3),
      actorKind: "User",
      operationReference: id(40),
      productReference: id(1),
      versionReference: id(4),
      expectedProductAggregateVersion: 2,
      reportOperationReference: id(41),
      reportDigest: hash("controlled report"),
      warningBindingDigest: hash("controlled warning"),
      warningCodes: ["ChangeImpact"],
      reasonCode: "CONTROLLED_ACK",
      occurredAt: at,
    }),
    host: MerchantProductWarningAcknowledgementSourceFactoryInput = { ...f.host, command };
  expect(createMerchantProductPublicationRuntimeSources(f.options).acknowledgement(host)).toBe(
    acknowledgementResult,
  );
  expect(mocks.authority).toHaveBeenCalledExactlyOnceWith(host);
  expect(mocks.currentPublished).toHaveBeenCalledTimes(1);
  expect(captured().assembled.options.currentPublished).toBe(currentPublished);
  expect(mocks.currentPublished.mock.calls[0]?.[0].capability).toBe(host.capability);
  expect(f.policyHold).not.toHaveBeenCalled();
});
it("refuses an unconfigured authorization host", () => {
  const f = fixture();
  expect(() =>
    createMerchantProductPublicationRuntimeSources(f.options).publication({
      ...f.host,
      currentAuthorization: undefined,
    } as never),
  ).toThrow(CatalogError);
  expect(mocks.shared).not.toHaveBeenCalled();
});
it.each([0, -1, 1.5, Number.NaN])("rejects invalid selector revision %s", (value) => {
  const f = fixture();
  f.options.contentPolicy.policyVersion = value;
  expect(() => createMerchantProductPublicationRuntimeSources(f.options)).toThrow(CatalogError);
});
it("rejects selector accessors without invoking them", () => {
  const f = fixture(),
    getter = vi.fn(() => id(21));
  Object.defineProperty(f.options.contentPolicy, "policyReference", {
    get: getter,
    enumerable: true,
  });
  expect(() => createMerchantProductPublicationRuntimeSources(f.options)).toThrow();
  expect(getter).not.toHaveBeenCalled();
});
it("uses the actual held Published policy identity and fixed Owner rules", async () => {
  const f = fixture(),
    configuration = start(f),
    value = { saved: true };
  const result = await configuration.withCurrentConfiguration(
    f.tx,
    input(f),
    async (config, tx) => {
      expect(tx).toBe(f.tx);
      expect(config.configurationReference).toBe(f.policy.content.policyReference);
      expect(config.configurationRevision).toBe(f.policy.content.policyVersion);
      expect(config.validUntil).toBe(plus(2000));
      expect(config).toMatchObject({
        backdateAnchor: "ServerObservation",
        backdateMaximumMilliseconds: 604800000,
      });
      expect(config.requirements).toEqual([
        {
          skuReference: id(5),
          Pricing: "RequiredWarning",
          Recipe: "RequiredWarning",
          Inventory: "RequiredWarning",
          Menu: "RequiredWarning",
        },
      ]);
      return value;
    },
  );
  expect(result).toBe(value);
  await f.commit();
  expect(f.policyHold).toHaveBeenCalledTimes(3);
});
it("captures the original policy-authority method before deferred acquisition", async () => {
  const f = fixture(),
    configuration = start(f);
  f.authority.contentPolicy.policyAuthority.holdUntilTransactionCompletes = vi.fn(unused);
  await configuration.withCurrentConfiguration(f.tx, input(f), async () => undefined);
  await f.commit();
  expect(f.policyHold).toHaveBeenCalledTimes(3);
});
it("retains the original minimum deadline after all async guards finish", async () => {
  const f = fixture(),
    configuration = start(f);
  let commits = 0;
  await configuration.withCurrentConfiguration(f.tx, input(f), async () => undefined);
  await expect(
    (async () => {
      await f.commit(async () => {
        f.setTime(plus(2000));
      });
      commits++;
    })(),
  ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(commits).toBe(0);
});
it("preserves a late current permission denial", async () => {
  const f = fixture(),
    configuration = start(f);
  await configuration.withCurrentConfiguration(f.tx, input(f), async () => undefined);
  f.policyHold.mockRejectedValueOnce(new CatalogError("CATALOG_PERMISSION_DENIED"));
  await expect(f.commit()).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
});
it.each(["transaction", "command", "query", "rollback"] as const)(
  "poisons invalid %s binding",
  async (kind) => {
    const f = fixture(),
      configuration = start(f),
      original = input(f);
    const actual = kind === "transaction" ? { query: f.tx.query } : f.tx;
    const supplied =
      kind === "command"
        ? ({
            ...original,
            context: { ...f.context, command: { ...f.context.command, reasonCode: "CHANGED" } },
          } as ConfigurationInput)
        : original;
    await expect(
      configuration.withCurrentConfiguration(actual, supplied, async () => {
        if (kind === "query") f.tx.query = async () => ({ rows: [], rowCount: 0 });
        if (kind === "rollback") f.setTime(plus(-1));
      }),
    ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
    await expect(f.commit()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  },
);
it("caught same-host reentry still prevents the outer consumer and commit", async () => {
  const f = fixture(),
    configuration = start(f);
  let afterInner = 0,
    commits = 0;
  await expect(
    configuration.withCurrentConfiguration(f.tx, input(f), async () => {
      await expect(
        configuration.withCurrentConfiguration(f.tx, input(f), async () => undefined),
      ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
      afterInner++;
    }),
  ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  await expect(
    (async () => {
      await f.commit();
      commits++;
    })(),
  ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(afterInner).toBe(1);
  expect(commits).toBe(0);
});

it("refuses a runtime host without its actual captured Screen capability before creating sources", () => {
  const f = fixture(),
    { capability, ...withoutCapability } = f.host;
  expect(capability).toBeDefined();
  expect(() =>
    createMerchantProductPublicationRuntimeSources(f.options).publication(withoutCapability),
  ).toThrow(CatalogError);
  expect(mocks.currentPublished).not.toHaveBeenCalled();
  expect(mocks.authority).not.toHaveBeenCalled();
  expect(mocks.shared).not.toHaveBeenCalled();
});
it("keeps the CurrentPublished producer request-local and refuses event generation on this read-only path", () => {
  const f = fixture(),
    factory = createMerchantProductPublicationRuntimeSources(f.options);
  factory.publication(f.host);
  factory.publication(f.host);
  expect(mocks.currentPublished).toHaveBeenCalledTimes(2);
  for (const [sourceOptions] of mocks.currentPublished.mock.calls) {
    expect(sourceOptions.transaction).toBe(f.tx);
    expect(() => sourceOptions.events.generateReference()).toThrow(CatalogError);
  }
});
