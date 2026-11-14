import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { readClosedRecord } from "@bop/identity";
import {
  createPostgresTenantBrandConfigurationContentSource,
  parseTenantBrandConfigurationContentRequest,
  tenantBrandConfigurationRequiredFields,
} from "@bop/tenant";
import {
  CatalogError,
  createPostgresProductVariantCreationSource,
  createPostgresProductVariantIdentityHistorySource,
  frozenFullOptionSetContentFields,
  parseCatalogFullOptionSetPublicationContent,
  parseProductAggregate,
  parseProductVariantCreationRequest,
  parseProductVariantIdentityHistoryRequest,
  productEditorContentFields,
  productVariantCreationFields,
  productVariantHistoryFields,
  type FrozenFullOptionSetContentAuthority,
  contentRegistryFields,
  copyCategoryPersistenceValue,
  parseCatalogInstant,
  parseCatalogReference,
  parseCatalogHash,
  parseCatalogProductContentRegistry,
  catalogProductDraftCategoryAssignmentPolicyV1,
  productCategoryAssignmentFields,
  type CatalogContentRegistryAuthority,
} from "@rms/catalog";
import {
  createCurrentBrandConfigurationContentSource,
  type CurrentBrandConfigurationContent,
} from "./current-brand-configuration-content.js";
import {
  currentProductPolicyFields,
  type createCurrentProductPublicationPolicySource,
} from "./current-product-publication-policy.js";
import type { MerchantProductCategoryPolicy } from "./merchant-product-category-assignments.js";
import {
  remainingProductEditorMediaSafetyChecks,
  type MerchantProductEditorMediaSafetyRemainingAuthority,
} from "./merchant-product-editor-media-safety-authority.js";
import type { MerchantProductEditorRuntimeMediaSafetyHost } from "./merchant-product-editor-runtime-media-safety.js";

type BrandOptions = Parameters<typeof createPostgresTenantBrandConfigurationContentSource>[0];
type CreationAuthority = Parameters<
  typeof createPostgresProductVariantCreationSource
>[0]["authority"];
type HistoryAuthority = Parameters<
  typeof createPostgresProductVariantIdentityHistorySource
>[0]["authority"];
type PolicyOptions = Parameters<typeof createCurrentProductPublicationPolicySource>[0];
const equal = (a: unknown, b: unknown) => canonicalizeRfc8785(a) === canonicalizeRfc8785(b);
const unavailable = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};

export interface MerchantProductAuthoringSources {
  readonly configurationVersionReference: string;
  readonly expectedBrandVersion: number;
  readonly policyReference: string;
  readonly policyVersion: number;
  readonly allergenRegistryVersionReference: string | null;
}
/** Server selectors only. No permission, source-fact or assessment callbacks. */
export function parseMerchantProductAuthoringSources(
  value: unknown,
): MerchantProductAuthoringSources {
  try {
    const input = readClosedRecord(copyCategoryPersistenceValue(value), [
      "configurationVersionReference",
      "expectedBrandVersion",
      "policyReference",
      "policyVersion",
      "allergenRegistryVersionReference",
    ]);
    const expectedBrandVersion = input.expectedBrandVersion,
      policyVersion = input.policyVersion;
    if (
      typeof expectedBrandVersion !== "number" ||
      !Number.isSafeInteger(expectedBrandVersion) ||
      expectedBrandVersion < 1 ||
      expectedBrandVersion > 2147483647 ||
      typeof policyVersion !== "number" ||
      !Number.isSafeInteger(policyVersion) ||
      policyVersion < 1 ||
      policyVersion > 2147483647
    )
      return unavailable();
    return Object.freeze({
      configurationVersionReference: parseCatalogReference(input.configurationVersionReference),
      expectedBrandVersion,
      policyReference: parseCatalogReference(input.policyReference),
      policyVersion,
      allergenRegistryVersionReference:
        input.allergenRegistryVersionReference === null
          ? null
          : parseCatalogReference(input.allergenRegistryVersionReference),
    });
  } catch {
    return unavailable();
  }
}
/** Fixed server selection of owning configuration versions, with actual held
 * Brand/release reads. Generic hardRequirementFieldCodes govern overrides;
 * this composition does not invent Product field requirements from them. */
export function createMerchantProductEditorRuntimeBrandSources(
  host: MerchantProductEditorRuntimeMediaSafetyHost,
  options: {
    readonly configurationVersionReference: string;
    readonly expectedBrandVersion: number;
    readonly policyReference: string;
  },
) {
  if (
    typeof host.transaction?.query !== "function" ||
    typeof host.currentAuthorization?.authorizeActions !== "function" ||
    typeof host.currentAuthorization?.assertCurrent !== "function" ||
    typeof host.clock?.now !== "function" ||
    typeof host.registerBeforeCommit !== "function" ||
    !Number.isSafeInteger(options.expectedBrandVersion) ||
    options.expectedBrandVersion < 1 ||
    options.expectedBrandVersion > 2147483647
  )
    return unavailable();
  const tx = host.transaction,
    query = tx.query,
    now = host.clock.now.bind(host.clock),
    authorize = host.currentAuthorization.authorizeActions.bind(host.currentAuthorization),
    assertCurrent = host.currentAuthorization.assertCurrent.bind(host.currentAuthorization),
    register = host.registerBeforeCommit.bind(host),
    identity = Object.freeze({
      tenantReference: parseCatalogReference(host.tenantReference),
      brandReference: parseCatalogReference(host.brandReference),
      storeReference: parseCatalogReference(host.storeReference),
      actorReference: parseCatalogReference(host.actorReference),
      sessionReference: parseCatalogReference(host.sessionReference),
      productReference: parseCatalogReference(host.productReference),
      operationReference: parseCatalogReference(host.operationReference),
    }),
    configurationVersionReference = parseCatalogReference(options.configurationVersionReference),
    expectedBrandVersion = options.expectedBrandVersion,
    policyReference = parseCatalogReference(options.policyReference),
    observedAt = parseCatalogInstant(now()),
    originalUntil = parseCatalogInstant(host.originalValidUntil),
    action = host.action,
    expectedRoot = host.expectedAggregateVersion,
    originalIntentDigest =
      "sha256:" +
      sha256Hex(
        canonicalizeRfc8785({
          ...identity,
          action,
          expectedAggregateVersion: expectedRoot,
        }),
      );
  if (originalUntil <= observedAt || Date.parse(originalUntil) - Date.parse(observedAt) > 5000)
    return unavailable();
  if (
    (action === "Create" && expectedRoot !== null) ||
    (action === "ReplaceDraft" &&
      (!Number.isSafeInteger(expectedRoot) || expectedRoot === null || expectedRoot < 1)) ||
    (action !== "Create" && action !== "ReplaceDraft")
  )
    return unavailable();
  let latest = observedAt,
    failed = false,
    activeAuthorization = false,
    activeBrandAuthorityRead = false,
    activeBrandRead = false,
    activeHeldOptionValidation = false,
    registered = false,
    ready = false,
    finalized = false,
    guardRan = false,
    acquiredBrand = false,
    originalBrandIdentity: string | undefined,
    permissionFailure: CatalogError | undefined,
    heldBrand: CurrentBrandConfigurationContent | undefined;
  const actions = new Set<string>();
  const fail = (error?: unknown): never => {
    failed = true;
    if (error instanceof CatalogError && error.code === "CATALOG_PERMISSION_DENIED")
      permissionFailure = error;
    if (permissionFailure) throw permissionFailure;
    return unavailable();
  };
  function check() {
    try {
      const at = parseCatalogInstant(now());
      if (failed || tx.query !== query || at < latest || at >= originalUntil) return fail();
      assertCurrent();
      latest = at;
      return at;
    } catch (error) {
      return fail(error);
    }
  }
  async function hold(selected: readonly string[]) {
    check();
    if (activeAuthorization || finalized) return fail();
    activeAuthorization = true;
    try {
      selected.forEach((action) => actions.add(action));
      // Each port obtains fresh decisions for its own required actions. The
      // accumulated union is passed explicitly by the final COMMIT guard.
      if ((await authorize(Object.freeze([...new Set(selected)].sort()))) !== undefined)
        return fail();
      check();
    } catch (error) {
      return fail(error);
    } finally {
      activeAuthorization = false;
    }
  }
  async function ensureRegistered() {
    if (registered) return;
    registered = true;
    if (
      (await register(
        tx,
        async () => {
          check();
          if (
            !ready ||
            activeBrandRead ||
            activeHeldOptionValidation ||
            activeBrandAuthorityRead ||
            activeAuthorization ||
            guardRan ||
            finalized
          )
            return fail();
          guardRan = true;
          await hold([...actions]);
          if (acquiredBrand) await withBrand(async () => undefined, true);
        },
        () => {
          check();
          if (
            !ready ||
            activeBrandRead ||
            activeHeldOptionValidation ||
            activeBrandAuthorityRead ||
            activeAuthorization ||
            !guardRan ||
            finalized
          )
            return fail();
          finalized = true;
        },
      )) !== undefined
    )
      return fail();
    check();
  }
  function validateBrandRequest(value: unknown, fields: readonly string[]) {
    const request = parseTenantBrandConfigurationContentRequest(value);
    if (
      !equal(fields, tenantBrandConfigurationRequiredFields) ||
      request.tenantReference !== identity.tenantReference ||
      request.brandReference !== identity.brandReference ||
      request.actorReference !== identity.actorReference ||
      request.configurationVersionReference !== configurationVersionReference ||
      request.expectedBrandVersion !== expectedBrandVersion ||
      request.observedAt < observedAt ||
      request.observedAt > check() ||
      request.validUntil <= check()
    )
      return fail();
    return request;
  }
  const brandAuthority: BrandOptions["authority"] = Object.freeze({
    async withCurrentContentRead(request, fields, work) {
      try {
        validateBrandRequest(request, fields);
        if (typeof work !== "function" || activeBrandAuthorityRead || finalized) return fail();
        activeBrandAuthorityRead = true;
        await ensureRegistered();
        await hold(["catalog.manage", "catalog.product.read"]);
        acquiredBrand = true;
        const result = await work();
        check();
        await hold(["catalog.manage", "catalog.product.read"]);
        ready = true;
        return result;
      } catch (error) {
        return fail(error);
      } finally {
        activeBrandAuthorityRead = false;
      }
    },
    async isCurrent(actual, request, fields) {
      try {
        if (actual !== tx) return fail();
        validateBrandRequest(request, fields);
        await hold(["catalog.manage", "catalog.product.read"]);
        return true;
      } catch (error) {
        return fail(error);
      }
    },
  });
  const brandSource = createCurrentBrandConfigurationContentSource(
    createPostgresTenantBrandConfigurationContentSource({
      brandReference: identity.brandReference,
      clock: now,
      transactions: { run: (work) => work(tx) },
      authority: brandAuthority,
    }),
  );
  async function withBrand<T>(
    work: (brand: CurrentBrandConfigurationContent) => Promise<T>,
    revalidate = false,
  ): Promise<T> {
    check();
    if (activeBrandRead || finalized) return fail();
    activeBrandRead = true;
    try {
      if (heldBrand !== undefined && !revalidate) {
        if (heldBrand.validUntil <= check()) return fail();
        await hold(["catalog.manage", "catalog.product.read"]);
        const answer = await work(heldBrand);
        check();
        if (heldBrand.validUntil <= check()) return fail();
        await hold(["catalog.manage", "catalog.product.read"]);
        return answer;
      }
      const request = parseTenantBrandConfigurationContentRequest({
        tenantReference: identity.tenantReference,
        brandReference: identity.brandReference,
        actorReference: identity.actorReference,
        purposeCode: "CATALOG_PRODUCT_CONTENT",
        configurationVersionReference,
        expectedBrandVersion,
        originalIntentDigest,
        observedAt,
        validUntil: originalUntil,
      });
      let calls = 0,
        completed = false,
        answer: T | undefined;
      const result = await brandSource.withCurrentContent(request, async (brand, actual) => {
        if (
          ++calls !== 1 ||
          actual !== tx ||
          brand.tenantReference !== identity.tenantReference ||
          brand.brandReference !== identity.brandReference ||
          brand.brandVersion !== expectedBrandVersion ||
          brand.configurationVersionReference !== configurationVersionReference ||
          brand.originalIntentDigest !== originalIntentDigest ||
          brand.observedAt !== observedAt ||
          brand.validUntil > originalUntil ||
          brand.validUntil <= check()
        )
          return fail();
        const fingerprint = canonicalizeRfc8785({
          configurationVersionReference: brand.configurationVersionReference,
          brandVersion: brand.brandVersion,
          contentDigest: brand.contentDigest,
          currentPublicationReference: brand.currentPublicationReference,
          defaultLocale: brand.defaultLocale,
          supportedLocales: brand.supportedLocales,
        });
        if (originalBrandIdentity !== undefined && originalBrandIdentity !== fingerprint)
          return fail();
        originalBrandIdentity = fingerprint;
        acquiredBrand = true;
        if (heldBrand === undefined) {
          const detached = copyCategoryPersistenceValue(brand) as CurrentBrandConfigurationContent;
          heldBrand = Object.freeze({
            ...detached,
            supportedLocales: Object.freeze([...detached.supportedLocales]),
            overrideAllowedFieldCodes: Object.freeze([...detached.overrideAllowedFieldCodes]),
            hardRequirementFieldCodes: Object.freeze([...detached.hardRequirementFieldCodes]),
          });
        }
        answer = await work(heldBrand);
        completed = true;
        check();
        return answer;
      });
      if (calls !== 1 || !completed || !Object.is(result, answer)) return fail();
      check();
      ready = true;
      return result;
    } catch (error) {
      return fail(error);
    } finally {
      activeBrandRead = false;
    }
  }
  const registryAuthority: CatalogContentRegistryAuthority = Object.freeze({
    async holdUntilTransactionCompletes(
      actual: Parameters<CatalogContentRegistryAuthority["holdUntilTransactionCompletes"]>[0],
      value: Parameters<CatalogContentRegistryAuthority["holdUntilTransactionCompletes"]>[1],
    ) {
      try {
        check();
        if (actual !== tx || finalized) return fail();
        const input = readClosedRecord(copyCategoryPersistenceValue(value), [
          "tenantReference",
          "brandReference",
          "actorReference",
          "actorKind",
          "purposeCode",
          "permission",
          "action",
          "registry",
          "requiredFields",
          "observedAt",
        ]);
        if (
          input.tenantReference !== identity.tenantReference ||
          input.brandReference !== identity.brandReference ||
          input.actorReference !== identity.actorReference ||
          input.actorKind !== "User" ||
          input.purposeCode !== "CATALOG_PRODUCT_CONTENT_REGISTRY" ||
          input.permission !== "catalog.manage" ||
          input.action !== "catalog.content-registry.read" ||
          !equal(input.requiredFields, contentRegistryFields) ||
          parseCatalogInstant(input.observedAt) < observedAt ||
          parseCatalogInstant(input.observedAt) > check()
        )
          return fail();
        const registry =
            input.registry === null ? null : parseCatalogProductContentRegistry(input.registry),
          sourceAt = parseCatalogInstant(input.observedAt);
        await ensureRegistered();
        await hold(["catalog.manage", "catalog.content-registry.read"]);
        // A retained record has no proposed registry definitions to qualify.
        // Current write holders separately acquire the actual Brand content.
        if (registry === null) {
          ready = true;
          return;
        }
        await withBrand(async (brand) => {
          if (
            registry.tenantReference !== identity.tenantReference ||
            registry.brandReference !== identity.brandReference ||
            registry.registeredAt > sourceAt ||
            !brand.supportedLocales.includes(registry.defaultLocale)
          )
            return fail();
          const names = [
            ...registry.tags,
            ...registry.attributes,
            ...registry.attributes.flatMap((attribute) =>
              attribute.type === "Enum" ? attribute.values : [],
            ),
          ];
          if (
            names.some((definition) =>
              Object.keys(definition.localizedNames).some(
                (locale) => !brand.supportedLocales.includes(locale),
              ),
            )
          )
            return fail();
        });
      } catch (error) {
        return fail(error);
      }
    },
  });
  const policyAuthority: PolicyOptions["authority"] = Object.freeze({
    async holdUntilTransactionCompletes(
      actual: Parameters<PolicyOptions["authority"]["holdUntilTransactionCompletes"]>[0],
      value: Parameters<PolicyOptions["authority"]["holdUntilTransactionCompletes"]>[1],
    ) {
      try {
        check();
        if (actual !== tx || finalized) return fail();
        const input = readClosedRecord(copyCategoryPersistenceValue(value), [
          "tenantReference",
          "brandReference",
          "actorReference",
          "actorKind",
          "purposeCode",
          "policyReference",
          "requiredFields",
          "observedAt",
        ]);
        if (
          input.tenantReference !== identity.tenantReference ||
          input.brandReference !== identity.brandReference ||
          input.actorReference !== identity.actorReference ||
          input.actorKind !== "User" ||
          input.purposeCode !== "CATALOG_PRODUCT_VERSION_PUBLICATION" ||
          input.policyReference !== policyReference ||
          !equal(input.requiredFields, currentProductPolicyFields) ||
          parseCatalogInstant(input.observedAt) < observedAt ||
          parseCatalogInstant(input.observedAt) > check()
        )
          return fail();
        await ensureRegistered();
        await hold(["catalog.manage", "catalog.product.read"]);
        ready = true;
      } catch (error) {
        return fail(error);
      }
    },
  });
  const categoryPolicy: MerchantProductCategoryPolicy = async (actual, value) => {
    try {
      check();
      if (actual !== tx || finalized) return fail();
      const input = readClosedRecord(copyCategoryPersistenceValue(value), [
        "tenantReference",
        "brandReference",
        "actorReference",
        "productReference",
        "productVersionReference",
        "purposeCode",
        "permission",
        "referencedPermission",
        "requiredFields",
        "referencedFields",
        "observedAt",
      ]);
      if (
        input.tenantReference !== identity.tenantReference ||
        input.brandReference !== identity.brandReference ||
        input.actorReference !== identity.actorReference ||
        input.productReference !== identity.productReference ||
        !["CATALOG_PRODUCT_CATEGORY_ACCESS", "CATALOG_PRODUCT_CATEGORY_MUTATION"].includes(
          String(input.purposeCode),
        ) ||
        input.permission !== "catalog.product.manage" ||
        input.referencedPermission !== "catalog.manage" ||
        !equal(input.requiredFields, productCategoryAssignmentFields) ||
        !equal(input.referencedFields, ["categoryReference", "brandReference", "lifecycle"]) ||
        parseCatalogInstant(input.observedAt) < observedAt ||
        parseCatalogInstant(input.observedAt) > check()
      )
        return fail();
      parseCatalogReference(input.productVersionReference);
      await ensureRegistered();
      await hold(["catalog.manage", "catalog.product.manage"]);
      return await withBrand(async () => catalogProductDraftCategoryAssignmentPolicyV1);
    } catch (error) {
      return fail(error);
    }
  };
  // These are fixed server authorities for the existing owning readers. They
  // retain IAM and the original command identity; SQL still proves absence,
  // identity history and frozen OptionSet content independently.
  let creationRequest: string | undefined,
    historyRequest: string | undefined,
    originalWrite: string | undefined,
    admittedWriteAggregate: string | undefined,
    recordedReadAggregate: string | undefined,
    recordedReadRecord: string | undefined;
  const frozenContent = new Map<string, string>();
  function sourceScope(
    input: {
      tenantReference: string;
      brandReference: string;
      actorReference: string;
      observedAt: string;
    },
    actual: typeof tx,
  ) {
    if (
      actual !== tx ||
      finalized ||
      input.tenantReference !== identity.tenantReference ||
      input.brandReference !== identity.brandReference ||
      input.actorReference !== identity.actorReference ||
      parseCatalogInstant(input.observedAt) < observedAt ||
      parseCatalogInstant(input.observedAt) > check()
    )
      return fail();
  }
  const creationAuthority: CreationAuthority = Object.freeze({
    async holdUntilTransactionCompletes(
      actual: Parameters<CreationAuthority["holdUntilTransactionCompletes"]>[0],
      input: Parameters<CreationAuthority["holdUntilTransactionCompletes"]>[1],
    ) {
      try {
        check();
        sourceScope(input, actual);
        const request = parseProductVariantCreationRequest(
          copyCategoryPersistenceValue(input.request),
        );
        if (
          action !== "Create" ||
          input.actorKind !== "User" ||
          input.permission !== "catalog.product.history.read" ||
          input.owningAction !== "catalog.product.create" ||
          input.requiredScope !== "FullBrandScope" ||
          input.purposeCode !== "CATALOG_PRODUCT_VARIANT_CREATION_CHECK" ||
          !equal(input.requiredFields, productVariantCreationFields) ||
          request.operationReference !== identity.operationReference ||
          request.aggregate.productReference !== identity.productReference ||
          request.aggregate.brandReference !== identity.brandReference ||
          request.aggregate.createdByActorReference !== identity.actorReference ||
          request.observedAt < observedAt ||
          request.observedAt > check() ||
          request.validUntil <= check() ||
          input.validUntil !== request.validUntil
        )
          return fail();
        const fingerprint = canonicalizeRfc8785(request);
        if (creationRequest !== undefined && creationRequest !== fingerprint) return fail();
        creationRequest = fingerprint;
        await ensureRegistered();
        await hold(["catalog.manage", "catalog.product.create", "catalog.product.history.read"]);
        ready = true;
      } catch (error) {
        return fail(error);
      }
    },
  });
  const historyAuthority: HistoryAuthority = Object.freeze({
    async holdUntilTransactionCompletes(
      actual: Parameters<HistoryAuthority["holdUntilTransactionCompletes"]>[0],
      input: Parameters<HistoryAuthority["holdUntilTransactionCompletes"]>[1],
    ) {
      try {
        check();
        sourceScope(input, actual);
        const request = parseProductVariantIdentityHistoryRequest(
          copyCategoryPersistenceValue(input.request),
        );
        if (
          action !== "ReplaceDraft" ||
          input.permission !== "catalog.product.history.read" ||
          input.purposeCode !== "CATALOG_PRODUCT_VARIANT_IDENTITY_HISTORY" ||
          !equal(input.requiredFields, productVariantHistoryFields) ||
          request.productReference !== identity.productReference ||
          request.expectedAggregateVersion !== expectedRoot
        )
          return fail();
        const fingerprint = canonicalizeRfc8785(request);
        if (historyRequest !== undefined && historyRequest !== fingerprint) return fail();
        historyRequest = fingerprint;
        await ensureRegistered();
        await hold(["catalog.manage", "catalog.product.history.read"]);
        ready = true;
      } catch (error) {
        return fail(error);
      }
    },
  });
  const optionAuthority: FrozenFullOptionSetContentAuthority = Object.freeze({
    async holdUntilTransactionCompletes(
      actual: Parameters<FrozenFullOptionSetContentAuthority["holdUntilTransactionCompletes"]>[0],
      input: Parameters<FrozenFullOptionSetContentAuthority["holdUntilTransactionCompletes"]>[1],
    ) {
      try {
        check();
        sourceScope(input, actual);
        if (
          input.actorKind !== "User" ||
          input.permission !== "catalog.manage" ||
          input.action !== "catalog.option_set.read" ||
          input.purposeCode !== "CATALOG_OPTION_SET_FROZEN_CONTENT" ||
          !equal(input.requiredFields, frozenFullOptionSetContentFields)
        )
          return fail();
        const set = parseCatalogReference(input.optionSetReference),
          version = parseCatalogReference(input.versionReference),
          sourceAt = parseCatalogInstant(input.observedAt),
          content =
            input.content === null
              ? null
              : parseCatalogFullOptionSetPublicationContent(
                  copyCategoryPersistenceValue(input.content),
                );
        await ensureRegistered();
        await hold(["catalog.manage", "catalog.option_set.read"]);
        const validateHeldOption = (brand: CurrentBrandConfigurationContent) => {
          if (content === null) return;
          const supported = content.supportedContent,
            draft = content.editorContent.sourceAggregate.draft;
          if (
            supported.tenantReference !== identity.tenantReference ||
            supported.brandReference !== identity.brandReference ||
            supported.optionSetReference !== set ||
            supported.versionReference !== version ||
            supported.sealedAt > sourceAt ||
            !brand.supportedLocales.includes(draft.defaultLocale)
          )
            return fail();
          const maps = [
            draft.localizedNames,
            draft.localizedDescriptions,
            ...draft.options.flatMap((option) => [
              option.localizedNames,
              option.localizedDescriptions,
            ]),
            ...content.editorContent.optionDetails.flatMap((detail) =>
              detail.media === null ? [] : [detail.media.altText],
            ),
          ];
          if (
            maps.some((map) =>
              Object.keys(map).some((locale) => !brand.supportedLocales.includes(locale)),
            )
          )
            return fail();
          const key = set + ":" + version,
            fingerprint = canonicalizeRfc8785(content);
          if (frozenContent.has(key) && frozenContent.get(key) !== fingerprint) return fail();
          frozenContent.set(key, fingerprint);
        };
        if (activeBrandRead) {
          // Policy holds the actual owning Brand source while its remaining
          // chain acquires Frozen Option content. Only this fixed validation
          // may consume that same original packet; generic Brand reentry stays
          // forbidden and the owning source remains revalidated at COMMIT.
          if (
            !acquiredBrand ||
            !heldBrand ||
            originalBrandIdentity === undefined ||
            activeHeldOptionValidation ||
            heldBrand.validUntil <= check()
          )
            return fail();
          activeHeldOptionValidation = true;
          try {
            const fingerprint = canonicalizeRfc8785({
              configurationVersionReference: heldBrand.configurationVersionReference,
              brandVersion: heldBrand.brandVersion,
              contentDigest: heldBrand.contentDigest,
              currentPublicationReference: heldBrand.currentPublicationReference,
              defaultLocale: heldBrand.defaultLocale,
              supportedLocales: heldBrand.supportedLocales,
            });
            if (fingerprint !== originalBrandIdentity) return fail();
            await hold(["catalog.manage", "catalog.product.read"]);
            validateHeldOption(heldBrand);
            check();
            if (heldBrand.validUntil <= check()) return fail();
            await hold(["catalog.manage", "catalog.product.read"]);
            if (heldBrand.validUntil <= check()) return fail();
          } finally {
            activeHeldOptionValidation = false;
          }
        } else await withBrand(async (brand) => validateHeldOption(brand));
        ready = true;
        return Object.freeze({ observedAt: sourceAt, validUntil: originalUntil });
      } catch (error) {
        return fail(error);
      }
    },
  });
  // Final complete-record authority in Policy -> Pinned -> Media -> remaining
  // composition. Earlier actual owning holders assess policy and binding graphs;
  // this port supplies no independent qualification or generic requirements.
  const remainingAuthority: MerchantProductEditorMediaSafetyRemainingAuthority = async (
    actual,
    value,
  ) => {
    try {
      check();
      const input = readClosedRecord(copyCategoryPersistenceValue(value), [
          "tenantReference",
          "brandReference",
          "storeReference",
          "actorReference",
          "sessionReference",
          "productReference",
          "operationReference",
          "permission",
          "owningAction",
          "purposeCode",
          "observedAt",
          "validUntil",
          "mode",
          "aggregate",
          "requiredFields",
          "requiredReferenceChecks",
        ]),
        aggregate = parseProductAggregate(input.aggregate),
        sourceAt = parseCatalogInstant(input.observedAt),
        sourceUntil = parseCatalogInstant(input.validUntil);
      if (
        actual !== tx ||
        finalized ||
        Object.entries(identity).some(([key, reference]) => input[key] !== reference) ||
        input.permission !== "catalog.manage" ||
        input.owningAction !== "catalog.product.manage" ||
        input.purposeCode !==
          (action === "Create" ? "CATALOG_PRODUCT_CREATE" : "CATALOG_PRODUCT_DRAFT_REPLACE") ||
        (input.mode !== "Read" && input.mode !== "DraftWrite") ||
        sourceAt < observedAt ||
        sourceAt > check() ||
        sourceUntil <= check() ||
        Date.parse(sourceUntil) - Date.parse(sourceAt) !== 5000 ||
        !equal(input.requiredFields, productEditorContentFields) ||
        !equal(
          input.requiredReferenceChecks,
          input.mode === "Read" ? [] : remainingProductEditorMediaSafetyChecks,
        ) ||
        aggregate.brandReference !== identity.brandReference ||
        aggregate.productReference !== identity.productReference ||
        aggregate.draft.editorContent === undefined ||
        (action === "Create" &&
          (aggregate.aggregateVersion !== 1 ||
            (input.mode === "DraftWrite" &&
              aggregate.createdByActorReference !== identity.actorReference)))
      )
        return fail();
      if (input.mode === "DraftWrite") {
        if (
          aggregate.aggregateVersion !== (action === "Create" ? 1 : (expectedRoot ?? fail()) + 1) ||
          aggregate.lifecycle !== "Draft" ||
          aggregate.draft.editorContent.nutritionProfile !== null
        )
          return fail();
        const fingerprint = canonicalizeRfc8785(input);
        if (originalWrite !== undefined && originalWrite !== fingerprint) return fail();
        originalWrite = fingerprint;
      } else if (aggregate.aggregateVersion !== (action === "Create" ? 1 : expectedRoot)) {
        // The owner reads back its own tentative persisted successor. That is
        // recorded access, not a new history root or reference qualification.
        // Permit this host's successfully admitted exact Write candidate or
        // exact immutable original receipt supplied by the owning SQL reader.
        if (
          action !== "ReplaceDraft" ||
          expectedRoot === null ||
          aggregate.aggregateVersion !== expectedRoot + 1 ||
          (admittedWriteAggregate !== canonicalizeRfc8785(aggregate) &&
            recordedReadAggregate !== canonicalizeRfc8785(aggregate))
        )
          return fail();
      }
      await ensureRegistered();
      // Complete authoring preserves the registry/history/option read rights
      // previously held by the legacy wrappers, in one fresh owner batch.
      await hold([
        "catalog.manage",
        "catalog.product.read",
        "catalog.sku.read",
        "catalog.content-registry.read",
        "catalog.product.history.read",
        "catalog.option_set.read",
      ]);
      if (input.mode === "DraftWrite") admittedWriteAggregate = canonicalizeRfc8785(aggregate);
      ready = true;
    } catch (error) {
      return fail(error);
    }
  };
  return Object.freeze({
    brandAuthority,
    creationAuthority,
    historyAuthority,
    optionAuthority,
    remainingAuthority,
    registryAuthority,
    policyAuthority,
    categoryPolicy,
    /** Called only by the ordinary command's owning StoredOperation callback,
     * after the Catalog reader has validated the immutable SQL receipt. This
     * admits recorded access, never prospective Write or current qualification. */
    async admitStoredOperationRead(actual: typeof tx, value: unknown): Promise<void> {
      try {
        check();
        await ensureRegistered();
        if (actual !== tx || finalized || action !== "ReplaceDraft" || expectedRoot === null)
          return fail();
        const record = readClosedRecord(copyCategoryPersistenceValue(value), [
            "action",
            "operationReference",
            "operationIntentHash",
            "aggregate",
          ]),
          aggregate = parseProductAggregate(record.aggregate),
          operation = parseCatalogReference(record.operationReference),
          intent = parseCatalogHash(record.operationIntentHash);
        if (
          record.action !== "ReplaceDraft" ||
          operation !== identity.operationReference ||
          aggregate.brandReference !== identity.brandReference ||
          aggregate.productReference !== identity.productReference ||
          aggregate.aggregateVersion !== expectedRoot + 1 ||
          aggregate.draft.editorContent === undefined
        )
          return fail();
        const fingerprint = canonicalizeRfc8785({
          action: record.action,
          operationReference: operation,
          operationIntentHash: intent,
          aggregate,
        });
        if (recordedReadRecord !== undefined && recordedReadRecord !== fingerprint) return fail();
        await hold([
          "catalog.manage",
          "catalog.product.read",
          "catalog.sku.read",
          "catalog.content-registry.read",
          "catalog.product.history.read",
          "catalog.option_set.read",
        ]);
        check();
        recordedReadRecord = fingerprint;
        recordedReadAggregate = canonicalizeRfc8785(aggregate);
        ready = true;
      } catch (error) {
        return fail(error);
      }
    },
    async withCurrentBrandContent<T>(
      actual: typeof tx,
      work: (brand: CurrentBrandConfigurationContent) => Promise<T>,
    ): Promise<T> {
      try {
        check();
        if (actual !== tx || typeof work !== "function" || finalized) return fail();
        await ensureRegistered();
        await hold(["catalog.manage", "catalog.product.read"]);
        return await withBrand(work);
      } catch (error) {
        return fail(error);
      }
    },
  });
}
