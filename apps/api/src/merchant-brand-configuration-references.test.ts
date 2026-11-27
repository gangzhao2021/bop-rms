import { beforeEach, expect, it, vi } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { createIdentityActor } from "@bop/identity";
import {
  BrandConfigurationOperationError,
  createBrand,
  createBrandAdministrationContext,
  createBrandConfigurationVersion,
  createPlatformBrandTemplateRevision,
  parseBrandConfigurationCommand,
  type BrandConfigurationAuthoringStoreOptions,
} from "@bop/tenant";
import {
  brandCatalogSourceRequiredFields,
  parseBrandCatalogSourceExact,
  parseBrandCatalogSourceScope,
  type createPostgresBrandAdministrationCatalogSourceStore,
} from "@rms/catalog";
import type { createPostgresPlatformTemplateBrandReferenceSource } from "@bop/publishing";
import type { MerchantBrandConfigurationOrdinaryOptions } from "./merchant-brand-configuration-ordinary.js";
import { createMerchantBrandConfigurationReferences } from "./merchant-brand-configuration-references.js";
const factories = vi.hoisted(() => ({ template: vi.fn(), catalog: vi.fn() }));
vi.mock("@bop/publishing", async (original) => ({
  ...(await original<typeof import("@bop/publishing")>()),
  createPostgresPlatformTemplateBrandReferenceSource: factories.template,
}));
vi.mock("@rms/catalog", async (original) => ({
  ...(await original<typeof import("@rms/catalog")>()),
  createPostgresBrandAdministrationCatalogSourceStore: factories.catalog,
}));
const id = (n: number) => `01902606-2421-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-10-06T12:00:00.000Z",
  until = "2026-10-06T12:00:05.000Z";
type Configure = MerchantBrandConfigurationOrdinaryOptions["configure"];
type Host = Parameters<Configure>[2];
type Input = Parameters<BrandConfigurationAuthoringStoreOptions["prepareFresh"]>[1];
type TemplateOptions = Parameters<typeof createPostgresPlatformTemplateBrandReferenceSource>[0];
type CatalogOptions = Parameters<typeof createPostgresBrandAdministrationCatalogSourceStore>[0];
beforeEach(() => vi.resetAllMocks());
/** Composition-only evidence: owning constructors are controlled module mocks.
 * Actual public material constructors/parsers and the administrative host binding
 * run here. This suite does not prove native source locks or publication facts. */
function fixture() {
  const scope = { tenantReference: id(2), brandReference: id(2), actorReference: id(3) };
  const actor = createIdentityActor({
    actorType: "User",
    actorReference: id(3),
    accountKind: "Workforce",
    status: "Active",
    authenticationMethod: "Oidc",
    verificationLevel: "SingleFactor",
    authenticatedAt: at,
    recentMfaAt: null,
  });
  const brand = createBrand({
    brandReference: id(2),
    code: "BRAND",
    displayName: "Controlled Brand",
    defaultLocale: "en-CA",
    currencyCode: "CAD",
    lifecycle: "Draft",
    version: 1,
    createdAt: at,
    updatedAt: at,
  });
  const content = {
    code: "STANDARD",
    name: "Standard",
    defaultLocale: "en-CA",
    supportedLocales: ["en-CA", "fr-CA"],
    overrideAllowedFieldCodes: ["CONTACT"],
    hardRequirementFieldCodes: ["SECURITY.REAUTH"],
    effectiveFrom: at,
    effectiveUntil: null,
    reasonCode: "INITIAL_CONFIGURATION",
  };
  const template = createPlatformBrandTemplateRevision(
    {
      profile: "PlatformBrandTemplateRevisionV1",
      templateReference: id(11),
      templateVersionReference: id(12),
      revision: 1,
      recordKind: "AuthoredContent",
      content,
      supersedesVersionReference: null,
      authoredByReference: id(13),
      operationReference: id(14),
      auditReference: id(15),
      createdAt: at,
      recordedAt: at,
      dataClassification: "ConfigurationMetadata",
    },
    { canonicalize: canonicalizeRfc8785, hashIntent: (text) => "sha256:" + sha256Hex(text) },
  );
  const editable = {
    defaultLocale: "en-CA",
    supportedLocales: ["en-CA"],
    mediaThemeReference: null,
    catalogSourceReference: id(4),
    platformTemplateReference: template.templateVersionReference,
    overrideAllowedFieldCodes: ["CONTACT"],
    hardRequirementFieldCodes: ["SECURITY.REAUTH"],
    effectiveFrom: at,
    effectiveUntil: null,
    reasonCode: "INITIAL_CONFIGURATION",
  };
  const command = parseBrandConfigurationCommand({
    profile: "TenantBrandConfigurationCommandV1",
    ...scope,
    command: "SaveConfigurationDraft",
    operationReference: id(20),
    expectedBrandVersion: 1,
    expectedHead: null,
    configuration: editable,
    reviewValidUntil: null,
    purposeCode: "BRAND_CONFIGURATION",
  });
  const configuration = createBrandConfigurationVersion({
    ...editable,
    configurationVersionReference: id(21),
    brandReference: id(2),
    configurationVersion: 1,
    lifecycle: "Draft",
    supersedesVersionReference: null,
    authoredByReference: id(3),
    approvedByReference: null,
    approvalEvidenceReference: null,
    publicationReference: null,
    createdAt: at,
    updatedAt: at,
    dataClassification: "ConfigurationMetadata",
  });
  const input: Input = { command, current: null, configuration, observedAt: at, validUntil: until };
  const catalog = parseBrandCatalogSourceExact(
    {
      profile: "BrandCatalogSourceExactV1",
      ...scope,
      requestedSourceReference: id(4),
      source: {
        profile: "BrandCatalogSourceRegisteredIdentityV1",
        tenantReference: id(2),
        brandReference: id(2),
        sourceReference: id(4),
        code: "MAIN",
        label: "Actual identity",
        registeredByReference: id(3),
        operationReference: id(30),
        auditReference: id(31),
        registeredAt: at,
        dataClassification: "ConfigurationMetadata",
      },
      observedAt: at,
      validUntil: until,
      publicationStatus: "NotEvaluated",
      referenceEligibility: "NotEvaluated",
    },
    parseBrandCatalogSourceScope(scope),
    id(4),
    at,
  );
  const state = {
    now: at,
    allowed: true,
    selection: "Published" as "Published" | "Missing" | "Unpublished",
    templateFinal: false,
    catalogFinal: false,
  };
  const tx: CatalogOptions["transaction"] = {
    query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
  };
  const hooks: { guard: () => Promise<void>; final: () => void }[] = [],
    after: (() => unknown)[] = [];
  const host: Host = {
    holdCurrentBrandAdministration: vi.fn(async (actual, request) => {
      expect(actual).toBe(tx);
      expect(request.scope).toEqual(scope);
      if (!state.allowed || state.now >= request.validUntil)
        throw new BrandConfigurationOperationError("BRAND_CONFIGURATION_PERMISSION_DENIED");
      return {
        administrationContext: createBrandAdministrationContext(actor, brand, state.now),
        validUntil: request.validUntil,
      };
    }),
    async registerBeforeCommit(actual, guard, final) {
      expect(actual).toBe(tx);
      hooks.push({ guard, final });
    },
    registerAfterCommit(actual, final) {
      expect(actual).toBe(tx);
      after.push(final);
    },
  };
  let templateOptions: TemplateOptions | undefined, catalogOptions: CatalogOptions | undefined;
  const templateCurrent = vi.fn(),
    catalogExact = vi.fn();
  const templateFinal = vi.fn(() => {
      if (!state.templateFinal) throw new Error("Controlled Template not sealed");
    }),
    catalogFinal = vi.fn(() => {
      if (!state.catalogFinal) throw new Error("Controlled Catalog not sealed");
    });
  factories.template.mockImplementation((options: TemplateOptions) => {
    templateOptions = options;
    const hold = () =>
      options.authority.holdUntilTransactionCompletes(tx, {
        scope,
        purposeCode: "BRAND_ADMINISTRATION",
        permission: "organization.manage",
        observedAt: at,
        validUntil: until,
      });
    templateCurrent.mockImplementation(async (request) => {
      expect(request).toEqual({ templateVersionReference: template.templateVersionReference });
      await hold();
      await options.registerBeforeCommit(
        tx,
        async () => {
          await hold();
          options.clock.now();
        },
        () => {
          state.templateFinal = true;
        },
      );
      return {
        profile: "PlatformTemplateBrandReferenceCurrentV1",
        scope,
        reference:
          state.selection === "Published"
            ? {
                template,
                releaseReference: id(40),
                releaseSequence: 1,
                publishedAt: at,
                publicationSourceDigest: "sha256:" + "a".repeat(64),
              }
            : null,
        observedAt: at,
        validUntil: until,
      };
    });
    return { current: templateCurrent, assertFinalized: templateFinal };
  });
  factories.catalog.mockImplementation((options: CatalogOptions) => {
    catalogOptions = options;
    const hold = () =>
      options.authority.holdUntilTransactionCompletes(tx, {
        ...parseBrandCatalogSourceScope(scope),
        mode: "Read",
        original: null,
        requiredFields: brandCatalogSourceRequiredFields,
        purposeCode: "BRAND_ADMINISTRATION",
        permission: "organization.manage",
        observedAt: at,
        validUntil: until,
      });
    catalogExact.mockImplementation(async (reference) => {
      expect(reference).toBe(id(4));
      await hold();
      await options.registerBeforeCommit(
        tx,
        async () => {
          await hold();
          options.clock.now();
        },
        () => {
          state.catalogFinal = true;
        },
      );
      return catalog;
    });
    return { exact: catalogExact, assertFinalized: catalogFinal };
  });
  const options = { now: () => state.now };
  const configure = createMerchantBrandConfigurationReferences(options),
    configured = configure(tx, scope, host);
  const consume = (
    actual = tx,
    value = input,
    work: Parameters<typeof configured.references.withCurrentReferences>[2] = async (
      material,
      held,
    ) => {
      expect(held).toBe(tx);
      return material;
    },
  ) => configured.references.withCurrentReferences(actual, value, work);
  const finalize = async () => {
    for (const hook of hooks) await hook.guard();
    for (const hook of hooks) hook.final();
    for (const final of after) final();
  };
  return {
    scope,
    input,
    tx,
    host,
    state,
    options,
    consume,
    finalize,
    hooks,
    after,
    template,
    catalog,
    templateCurrent,
    catalogExact,
    templateFinal,
    catalogFinal,
    templateOptions: () => templateOptions,
    catalogOptions: () => catalogOptions,
  };
}
it("maps immutable owning Template content and exact Catalog without a fictitious Theme", async () => {
  const f = fixture(),
    material = await f.consume();
  expect(material).toEqual({
    catalog: f.catalog,
    template: {
      reference: f.template.templateVersionReference,
      digest: f.template.contentDigest,
      supportedLocales: f.template.content.supportedLocales,
      overrideAllowedFieldCodes: f.template.content.overrideAllowedFieldCodes,
      hardRequirementFieldCodes: f.template.content.hardRequirementFieldCodes,
      effectiveFrom: at,
      effectiveUntil: null,
    },
    theme: null,
  });
  expect(f.templateFinal).not.toHaveBeenCalled();
  expect(f.catalogFinal).not.toHaveBeenCalled();
  expect(f.host.holdCurrentBrandAdministration).toHaveBeenNthCalledWith(1, f.tx, {
    scope: f.scope,
    observedAt: at,
    validUntil: until,
  });
  expect(f.host.holdCurrentBrandAdministration).toHaveBeenNthCalledWith(2, f.tx, {
    scope: f.scope,
    observedAt: at,
    validUntil: until,
  });
  for (const hook of f.hooks) await hook.guard();
  for (const hook of f.hooks) hook.final();
  f.state.now = "2026-10-06T12:00:10.000Z";
  for (const final of f.after) final();
  expect(f.templateFinal).toHaveBeenCalledOnce();
  expect(f.catalogFinal).toHaveBeenCalledOnce();
  expect(f.tx.query).not.toHaveBeenCalled();
});
it.each(["Missing", "Unpublished"] as const)(
  "rejects owning %s selection without substituting another template",
  async (selection) => {
    const f = fixture();
    f.state.selection = selection;
    await expect(f.consume()).rejects.toMatchObject({
      code: "BRAND_CONFIGURATION_VERSION_CONFLICT",
    });
    expect(f.catalogExact).not.toHaveBeenCalled();
    await expect(f.finalize()).rejects.toThrow();
  },
);
it("refuses nonnull Theme without its real owner rather than converting it to null", async () => {
  const f = fixture();
  const configuration = createBrandConfigurationVersion({
    ...f.input.configuration,
    mediaThemeReference: id(45),
  });
  await expect(f.consume(f.tx, { ...f.input, configuration })).rejects.toThrow();
  expect(factories.template).not.toHaveBeenCalled();
  await expect(f.finalize()).rejects.toThrow();
});
it.each(["transaction", "scope"])("refuses changed %s before owner reads", async (field) => {
  const f = fixture();
  await expect(
    f.consume(
      field === "transaction" ? { query: f.tx.query } : f.tx,
      field === "scope"
        ? {
            ...f.input,
            command: parseBrandConfigurationCommand({ ...f.input.command, actorReference: id(99) }),
          }
        : f.input,
    ),
  ).rejects.toThrow();
  expect(factories.template).not.toHaveBeenCalled();
});
it.each(["purpose", "permission", "scope", "window", "transaction"])(
  "rejects invalid owning authority %s forwarding",
  async (field) => {
    const f = fixture();
    await f.consume();
    const options = f.templateOptions();
    if (!options) throw new Error("Controlled owner required");
    const request = {
      scope: f.scope,
      purposeCode: "BRAND_ADMINISTRATION",
      permission: "organization.manage",
      observedAt: at,
      validUntil: until,
    };
    const bad =
      field === "purpose"
        ? { ...request, purposeCode: "PLATFORM_BRAND_TEMPLATE" }
        : field === "permission"
          ? { ...request, permission: "catalog.manage" }
          : field === "scope"
            ? { ...request, scope: { ...f.scope, actorReference: id(98) } }
            : field === "window"
              ? { ...request, validUntil: "2026-10-06T12:00:06.000Z" }
              : request;
    await expect(
      Reflect.apply(options.authority.holdUntilTransactionCompletes, options.authority, [
        field === "transaction" ? { query: f.tx.query } : f.tx,
        bad,
      ]),
    ).rejects.toThrow();
  },
);
it.each(["mode", "original", "requiredFields"])(
  "refuses Catalog %s that would turn an exact read into another operation",
  async (field) => {
    const f = fixture();
    await f.consume();
    const options = f.catalogOptions();
    if (!options) throw new Error("Controlled owner required");
    const request = {
      ...f.scope,
      mode: "Read",
      original: null,
      requiredFields: brandCatalogSourceRequiredFields,
      purposeCode: "BRAND_ADMINISTRATION",
      permission: "organization.manage",
      observedAt: at,
      validUntil: until,
    };
    const bad =
      field === "mode"
        ? { ...request, mode: "Register" }
        : field === "original"
          ? { ...request, original: {} }
          : { ...request, requiredFields: [] };
    const previous = vi.mocked(f.host.holdCurrentBrandAdministration).mock.calls.length;
    await expect(
      Reflect.apply(options.authority.holdUntilTransactionCompletes, options.authority, [
        f.tx,
        bad,
      ]),
    ).rejects.toThrow();
    expect(f.host.holdCurrentBrandAdministration).toHaveBeenCalledTimes(previous);
  },
);
it.each(["IAM", "clock", "query", "host", "scope"])(
  "refuses late %s drift before source finalization",
  async (field) => {
    const f = fixture();
    await f.consume();
    if (field === "IAM") f.state.allowed = false;
    else if (field === "clock") f.state.now = until;
    else if (field === "query")
      Object.defineProperty(f.tx, "query", { value: async () => ({ rows: [] }) });
    else if (field === "host")
      Object.defineProperty(f.host, "holdCurrentBrandAdministration", { value: async () => ({}) });
    else f.scope.actorReference = id(97);
    await expect(f.finalize()).rejects.toThrow();
    expect(f.templateFinal).not.toHaveBeenCalled();
  },
);
it("captures the clock port and poisons a caught work failure before COMMIT", async () => {
  const f = fixture();
  await expect(
    f.consume(f.tx, f.input, async () => {
      throw new Error("Controlled work failed");
    }),
  ).rejects.toThrow();
  await expect(f.finalize()).rejects.toThrow();
  const g = fixture();
  await g.consume();
  Object.defineProperty(g.options, "now", { value: () => at });
  await expect(g.finalize()).rejects.toThrow();
});
it("does not permit independent reuse or allocate identity/Audit through its read ports", async () => {
  const f = fixture();
  await f.consume();
  await expect(f.consume()).rejects.toThrow();
  await expect(f.finalize()).rejects.toThrow();
  const g = fixture();
  await g.consume();
  const options = g.catalogOptions();
  if (!options) throw new Error("Controlled owner required");
  expect(() => options.nextReference("Source")).toThrow();
  await expect(
    options.appendAudit(g.tx, {
      ...parseBrandCatalogSourceScope({
        tenantReference: id(2),
        brandReference: id(2),
        actorReference: id(3),
      }),
      operationReference: id(50),
      intentDigest: "sha256:" + "a".repeat(64),
      purposeCode: "BRAND_CATALOG_SOURCE",
      mode: "Register",
      sourceReference: id(4),
      auditReference: id(51),
      occurredAt: at,
    }),
  ).rejects.toThrow();
});
