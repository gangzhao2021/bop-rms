import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  parseTenantBrandConfigurationContentRequest,
  parseTenantStoreReferenceRequest,
  tenantBrandConfigurationRequiredFields,
} from "@bop/tenant";
import {
  CatalogError,
  copyCategoryPersistenceValue,
  parseCatalogInstant,
  parseCatalogReference,
  parseProductPublicationCommandV2,
  parseCatalogProductPublicationWarningAcknowledgementCommand,
  parseCatalogProductPublicationReferenceRequestV2,
  parseCatalogProductWarningAcknowledgementReferenceRequest,
  parseCatalogProductContentRegistry,
  parseCatalogProductTaxClassificationRegistry,
  parseCatalogFullOptionSetPublicationContent,
  productPublicationWriteFieldsV2,
  productPublicationWarningAcknowledgementFields,
  productEditorSnapshotFields,
  productPublicationValidationReportReadFields,
  type ProductPublicationStoreOptionsV2,
  type ProductPublicationWarningAcknowledgementStoreOptions,
  productPublicationSourceFieldsV2,
  productPublicationQualificationHistoryFields,
  productWarningAcknowledgementQualificationHistoryFields,
  productPublicationReferenceHistoryFieldsV2,
  productWarningAcknowledgementReferenceHistoryFields,
  productPublicationMenuReferenceSourceFieldsV2,
  productWarningAcknowledgementMenuReferenceSourceFields,
  productPublicationBundleReferenceSourceFieldsV2,
  productWarningAcknowledgementBundleReferenceSourceFields,
  productPublicationAvailabilityReferenceSourceFieldsV2,
  productWarningAcknowledgementAvailabilityReferenceSourceFields,
  productPublicationFrozenFullOptionSetContentFields,
  contentRegistryFields,
  taxClassificationRegistryFields,
} from "@rms/catalog";
import {
  parseRecipeProductPublicationReferenceRequestV2,
  parseRecipeInventoryProductPublicationReferenceRequestV2,
  recipeProductPublicationReferenceSourceFieldsV2,
  recipeInventoryProductPublicationReferenceSourceFieldsV2,
} from "@rms/recipe";
import {
  parseInventoryProductPublicationReferenceRequestV2,
  inventoryConfigurationReferencePermissions,
  inventoryProductPublicationSkuMappingReferenceFieldsV2,
} from "@rms/inventory";
import {
  parsePricingProductPublicationReferenceRequestV2,
  productPublicationConfigurationReferenceSourceFieldsV2,
  productPublicationPriceBookReferenceSourceFieldsV2,
  productPublicationOptionPriceReferenceSourceFieldsV2,
  productPublicationPromotionReferenceSourceFieldsV2,
} from "@rms/pricing";
import { currentProductPolicyFields } from "./current-product-publication-policy.js";
import type { MerchantProductCurrentAuthorization } from "./merchant-product-current-authorization.js";
import type { MerchantProductPublicationSourceFactoryV2Input } from "./merchant-product-publication-command-v2.js";
import type { MerchantProductWarningAcknowledgementSourceFactoryInput } from "./merchant-product-publication-warning-acknowledgement-command.js";
import type { MerchantProductPublicationSourcesConfiguration as Configuration } from "./merchant-product-publication-sources.js";

type Host =
  | MerchantProductPublicationSourceFactoryV2Input
  | MerchantProductWarningAcknowledgementSourceFactoryInput;
type RecordValue = Record<string, unknown>;
type References = Pick<
  Configuration["publicationReferences"],
  | "historyAuthority"
  | "availabilityAuthority"
  | "bundleAuthority"
  | "menuAuthority"
  | "recipeAuthority"
  | "recipeInventoryAuthority"
  | "inventoryAuthority"
  | "pricingAuthority"
  | "priceBookAuthority"
  | "optionPriceAuthority"
  | "promotionAuthority"
>;
type AckReferences = Pick<Configuration["acknowledgementReferences"], keyof References>;
export interface MerchantProductPublicationRuntimeAuthority {
  readonly publicationAuthority: ProductPublicationStoreOptionsV2["authority"];
  readonly acknowledgementAuthority: ProductPublicationWarningAcknowledgementStoreOptions["authority"];
  readonly acknowledgementContentAuthority: ProductPublicationWarningAcknowledgementStoreOptions["contentAuthority"];
  readonly acknowledgementHistoryAuthority: ProductPublicationWarningAcknowledgementStoreOptions["historyAuthority"];
  readonly acknowledgementReportAuthority: ProductPublicationWarningAcknowledgementStoreOptions["reportAuthority"];
  readonly contentPolicy: Pick<
    Configuration["contentPolicy"],
    "brandAuthority" | "policyAuthority"
  >;
  readonly scope: Pick<Configuration["scope"], "historyAuthority" | "tenantAuthority">;
  readonly variant: Pick<Configuration["variant"], "authority">;
  readonly options: Pick<Configuration["options"], "authority">;
  readonly tax: Pick<Configuration["tax"], "authority">;
  readonly registeredContent: Pick<Configuration["registeredContent"], "registryAuthority">;
  readonly publicationReferences: References;
  readonly acknowledgementReferences: AckReferences;
}
const hash = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
const equal = (left: unknown, right: unknown) =>
  canonicalizeRfc8785(left) === canonicalizeRfc8785(right);
const unavailable = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};
function record(value: unknown, fields: readonly string[]): RecordValue {
  if (
    !value ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== fields.length
  )
    return unavailable();
  const result: RecordValue = {};
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor?.enumerable || !("value" in descriptor)) return unavailable();
    result[field] = copyCategoryPersistenceValue(descriptor.value);
  }
  return result;
}
const identityFields = ["tenantReference", "brandReference", "actorReference", "actorKind"];
const intentFields = [
  "command",
  "commandPurposeCode",
  "originalIntentDigest",
  "requestObservedAt",
  "requestValidUntil",
];
const catalogRead = ["catalog.manage", "catalog.product.read"];
const catalogHistory = ["catalog.manage", "catalog.product.history.read"];

/** Fixed server profiles authorize only their published owner fields. No field
 * names, actions or permissions supplied by a browser become grants. Screen
 * capability is held by the command host, including original operation replay. */
export function createMerchantProductPublicationRuntimeAuthority(
  host: Host,
): MerchantProductPublicationRuntimeAuthority {
  const tx = host.transaction,
    query = tx?.query,
    authorization: MerchantProductCurrentAuthorization | undefined = host.currentAuthorization;
  if (
    typeof query !== "function" ||
    typeof host.clock?.now !== "function" ||
    typeof host.registerBeforeCommit !== "function" ||
    typeof authorization?.authorizeActions !== "function"
  )
    return unavailable();
  const authorizeActions = authorization.authorizeActions.bind(authorization),
    now = host.clock.now.bind(host.clock),
    register = host.registerBeforeCommit.bind(host),
    raw = copyCategoryPersistenceValue(host.command),
    command =
      (raw as RecordValue).profile === "CatalogProductPublicationCommandV2"
        ? parseProductPublicationCommandV2(raw)
        : parseCatalogProductPublicationWarningAcknowledgementCommand(raw),
    tenant = parseCatalogReference(host.tenantReference),
    brand = parseCatalogReference(host.brandReference),
    actor = parseCatalogReference(host.actorReference),
    store = parseCatalogReference(host.storeReference),
    session = parseCatalogReference(host.sessionReference),
    originalUntil = parseCatalogInstant(host.originalValidUntil),
    originalDigest = hash(command),
    commandText = canonicalizeRfc8785(command),
    isPublication = command.profile === "CatalogProductPublicationCommandV2";
  if (
    !equal(raw, command) ||
    command.actorKind !== "User" ||
    command.tenantReference !== tenant ||
    command.brandReference !== brand ||
    command.actorReference !== actor ||
    !store ||
    !session
  )
    return unavailable();
  let latest = parseCatalogInstant(now()),
    deadline: string = originalUntil,
    failed = false,
    registration: Promise<void> | undefined,
    activeAuthorization = false,
    guardRan = false;
  if (originalUntil <= latest || Date.parse(originalUntil) - Date.parse(latest) > 5000)
    return unavailable();
  const actions = new Set<string>();
  function fail(error?: unknown): never {
    failed = true;
    if (error instanceof CatalogError && error.code === "CATALOG_PERMISSION_DENIED") throw error;
    return unavailable();
  }
  function check() {
    try {
      const at = parseCatalogInstant(now());
      if (failed || tx.query !== query || at < latest || at >= deadline) return fail();
      latest = at;
      return at;
    } catch (error) {
      return fail(error);
    }
  }
  async function current(required: readonly string[]) {
    check();
    if (activeAuthorization) return fail();
    activeAuthorization = true;
    try {
      if ((await authorizeActions(Object.freeze([...required]))) !== undefined) return fail();
      check();
    } catch (error) {
      return fail(error);
    } finally {
      activeAuthorization = false;
    }
  }
  function ensureRegistered() {
    registration ??= (async () => {
      if (
        (await register(
          tx,
          async () => {
            if (guardRan || actions.size === 0 || activeReads.size > 0) return fail();
            guardRan = true;
            await current([...actions]);
          },
          () => {
            if (!guardRan || activeAuthorization || activeReads.size > 0) return fail();
            check();
          },
        )) !== undefined
      )
        return fail();
      check();
    })();
    return registration;
  }
  function lease(observed: unknown, until: unknown = originalUntil) {
    const at = parseCatalogInstant(observed),
      end = parseCatalogInstant(until);
    if (
      at > check() ||
      at < new Date(Date.parse(originalUntil) - 5000).toISOString() ||
      end <= at ||
      end > originalUntil ||
      Date.parse(end) - Date.parse(at) > 5000
    )
      return fail();
    if (end < deadline) deadline = end;
    check();
    return { observedAt: at, validUntil: deadline };
  }
  function fields(r: RecordValue, expected: readonly string[]) {
    if (!equal(r.requiredFields, expected)) return fail();
  }
  function identity(r: RecordValue) {
    if (
      r.tenantReference !== tenant ||
      r.brandReference !== brand ||
      r.actorReference !== actor ||
      r.actorKind !== "User"
    )
      return fail();
  }
  function fullIntent(r: RecordValue, purposeField = "commandPurposeCode") {
    if (
      canonicalizeRfc8785(r.command) !== commandText ||
      r[purposeField] !== command.purposeCode ||
      r.originalIntentDigest !== originalDigest
    )
      return fail();
    if ("replacementIntentDigest" in r) {
      if (
        typeof r.replacementIntentDigest !== "string" ||
        !/^sha256:[0-9a-f]{64}$/.test(r.replacementIntentDigest) ||
        (isPublication && r.replacementIntentDigest !== command.replacementIntentDigest)
      )
        return fail();
    }
  }
  function catalogRequest(value: unknown, publication: boolean) {
    if (publication !== isPublication) return fail();
    const request = publication
      ? parseCatalogProductPublicationReferenceRequestV2(value)
      : parseCatalogProductWarningAcknowledgementReferenceRequest(value);
    if (
      canonicalizeRfc8785(request.command) !== commandText ||
      request.originalIntentDigest !== originalDigest
    )
      return fail();
    lease(request.observedAt, request.validUntil);
    return request;
  }
  async function hold(
    actual: unknown,
    value: unknown,
    keys: readonly string[],
    required: readonly string[],
    validate: (r: RecordValue) => void,
  ) {
    // Capture before the first await; even a caught malformed packet poisons the
    // mandatory outer guard rather than becoming an authorization bypass.
    let r: RecordValue | undefined, error: unknown;
    try {
      if (actual !== tx) return fail();
      r = record(value, keys);
      validate(r);
    } catch (caught) {
      failed = true;
      error = caught;
    }
    await ensureRegistered();
    if (!r || error) return fail(error);
    for (const action of required) actions.add(action);
    await current(required);
  }
  const policyKeys = [
    "command",
    "actorKind",
    "purposeCode",
    "originalIntentDigest",
    "replacementIntentDigest",
    "tenantReference",
    "brandReference",
    "actorReference",
    "policyReference",
    "policyVersion",
    "requiredFields",
    "observedAt",
    "validUntil",
  ];
  const policyAuthority: Configuration["contentPolicy"]["policyAuthority"] = Object.freeze({
    holdUntilTransactionCompletes: (actual: unknown, value: unknown) =>
      hold(actual, value, policyKeys, catalogRead, (r) => {
        identity(r);
        fullIntent(r, "purposeCode");
        fields(r, currentProductPolicyFields);
        parseCatalogReference(r.policyReference);
        if (
          typeof r.policyVersion !== "number" ||
          !Number.isSafeInteger(r.policyVersion) ||
          r.policyVersion < 1 ||
          r.policyVersion > 2147483647
        )
          return fail();
        lease(r.observedAt, r.validUntil);
      }),
  });
  const brandKeys = [
    "command",
    "actorKind",
    "purposeCode",
    "originalIntentDigest",
    "replacementIntentDigest",
    "request",
    "requiredFields",
  ];
  const brandHold = (actual: unknown, value: unknown) =>
    hold(actual, value, brandKeys, catalogRead, (r) => {
      fullIntent(r, "purposeCode");
      fields(r, tenantBrandConfigurationRequiredFields);
      const request = parseTenantBrandConfigurationContentRequest(r.request);
      if (
        r.actorKind !== "User" ||
        request.tenantReference !== tenant ||
        request.brandReference !== brand ||
        request.actorReference !== actor ||
        request.purposeCode !== "CATALOG_PRODUCT_CONTENT" ||
        request.originalIntentDigest !== originalDigest
      )
        return fail();
      lease(request.observedAt, request.validUntil);
    });
  const tenantKeys = [...intentFields, "actorKind", "replacementIntentDigest", "request"];
  const tenantHold = (actual: unknown, value: unknown) =>
    hold(actual, value, tenantKeys, catalogRead, (r) => {
      fullIntent(r);
      if (r.actorKind !== "User") return fail();
      const request = parseTenantStoreReferenceRequest(r.request);
      if (
        request.brandReference !== brand ||
        request.actorReference !== actor ||
        request.purposeCode !== command.purposeCode ||
        request.originalIntentDigest !== originalDigest
      )
        return fail();
      lease(r.requestObservedAt, r.requestValidUntil);
      lease(request.observedAt, r.requestValidUntil);
    });
  const activeReads = new Set<string>();
  async function withRead<T>(
    kind: string,
    authorize: (value: unknown) => Promise<void>,
    value: unknown,
    keys: readonly string[],
    work: () => Promise<T>,
  ): Promise<T> {
    let captured: RecordValue | undefined, captureError: unknown;
    try {
      captured = record(value, keys);
      if (activeReads.has(kind)) return fail();
    } catch (error) {
      failed = true;
      captureError = error;
    }
    await ensureRegistered();
    if (!captured || captureError) return fail(captureError);
    activeReads.add(kind);
    try {
      if (typeof work !== "function") return fail();
      await authorize(captured);
      const result = await work();
      await authorize(captured);
      check();
      return result;
    } catch (error) {
      return fail(error);
    } finally {
      activeReads.delete(kind);
    }
  }
  const historyAuthority: Configuration["scope"]["historyAuthority"] = Object.freeze({
    holdUntilTransactionCompletes: (actual: unknown, value: unknown) =>
      hold(
        actual,
        value,
        [
          ...identityFields,
          ...intentFields,
          "replacementIntentDigest",
          "productReference",
          "purposeCode",
          "permission",
          "owningActions",
          "requiredFields",
          "observedAt",
        ],
        catalogHistory,
        (r) => {
          identity(r);
          fullIntent(r);
          fields(r, productPublicationSourceFieldsV2);
          if (
            r.productReference !== command.productReference ||
            r.purposeCode !== "CATALOG_PRODUCT_PUBLICATION_SOURCE" ||
            r.permission !== "catalog.manage" ||
            !equal(r.owningActions, ["catalog.product.history.read"])
          )
            return fail();
          lease(r.requestObservedAt, r.requestValidUntil);
          lease(r.observedAt, r.requestValidUntil);
        },
      ),
  });
  const variantAuthority: Configuration["variant"]["authority"] = Object.freeze({
    holdUntilTransactionCompletes: (actual: unknown, value: unknown) =>
      hold(
        actual,
        value,
        [
          ...identityFields,
          ...intentFields,
          "replacementIntentDigest",
          "request",
          "purposeCode",
          "permission",
          "owningAction",
          "requiredScope",
          "requiredFields",
          "observedAt",
        ],
        catalogHistory,
        (r) => {
          identity(r);
          fullIntent(r);
          fields(
            r,
            isPublication
              ? productPublicationQualificationHistoryFields
              : productWarningAcknowledgementQualificationHistoryFields,
          );
          const expected = isPublication
            ? "CATALOG_PRODUCT_PUBLICATION_QUALIFICATION_HISTORY_READ"
            : "CATALOG_PRODUCT_WARNING_ACKNOWLEDGEMENT_QUALIFICATION_HISTORY_READ";
          if (
            r.purposeCode !== expected ||
            r.permission !== "catalog.manage" ||
            r.owningAction !== "catalog.product.history.read" ||
            r.requiredScope !== "FullBrandScope"
          )
            return fail();
          const request = catalogRequest(r.request, isPublication);
          if (
            r.replacementIntentDigest !== request.replacementIntentDigest ||
            r.requestObservedAt !== request.observedAt ||
            r.requestValidUntil !== request.validUntil
          )
            return fail();
          lease(r.observedAt, request.validUntil);
        },
      ),
  });
  function registry(tax: boolean) {
    return Object.freeze({
      holdUntilTransactionCompletes: (actual: unknown, value: unknown) =>
        hold(
          actual,
          value,
          [
            ...identityFields,
            ...intentFields,
            "purposeCode",
            "permission",
            "action",
            "registry",
            "requiredFields",
            "observedAt",
            ...(tax ? ["mode"] : []),
          ],
          [
            "catalog.manage",
            tax ? "catalog.tax-classification.read" : "catalog.content-registry.read",
          ],
          (r) => {
            identity(r);
            fullIntent(r);
            fields(r, tax ? taxClassificationRegistryFields : contentRegistryFields);
            if (
              r.purposeCode !==
                (tax
                  ? "CATALOG_PRODUCT_TAX_CLASSIFICATION_REGISTRY"
                  : "CATALOG_PRODUCT_CONTENT_REGISTRY") ||
              r.permission !== "catalog.manage" ||
              r.action !==
                (tax ? "catalog.tax-classification.read" : "catalog.content-registry.read") ||
              (tax && r.mode !== "Read")
            )
              return fail();
            if (r.registry !== null) {
              const parsed = tax
                ? parseCatalogProductTaxClassificationRegistry(r.registry)
                : parseCatalogProductContentRegistry(r.registry);
              if (
                parsed.tenantReference !== tenant ||
                parsed.brandReference !== brand ||
                !equal(parsed, r.registry)
              )
                return fail();
            }
            lease(r.requestObservedAt, r.requestValidUntil);
            lease(r.observedAt, r.requestValidUntil);
          },
        ),
    });
  }
  const optionAuthority: Configuration["options"]["authority"] = Object.freeze({
    async holdUntilTransactionCompletes(actual: unknown, value: unknown) {
      let observation: string | undefined;
      await hold(
        actual,
        value,
        [
          ...identityFields,
          "permission",
          "action",
          "purposeCode",
          "requiredFields",
          "command",
          "originalIntentDigest",
          "replacementIntentDigest",
          "warningBindingDigest",
          "requestObservedAt",
          "requestValidUntil",
          "optionSetReference",
          "versionReference",
          "content",
          "observedAt",
        ],
        ["catalog.manage", "catalog.option_set.read"],
        (r) => {
          identity(r);
          // Ack carries the warning binding; its target is resolved by its owning
          // holder. The publication protocol carries the exact replacement digest.
          if (
            canonicalizeRfc8785(r.command) !== commandText ||
            r.originalIntentDigest !== originalDigest ||
            r.purposeCode !== command.purposeCode ||
            r.permission !== "catalog.manage" ||
            r.action !== "catalog.option_set.read" ||
            r.replacementIntentDigest !==
              (isPublication ? command.replacementIntentDigest : null) ||
            r.warningBindingDigest !== (isPublication ? null : command.warningBindingDigest)
          )
            return fail();
          fields(r, productPublicationFrozenFullOptionSetContentFields);
          parseCatalogReference(r.optionSetReference);
          parseCatalogReference(r.versionReference);
          // The owning reader parses the frozen content. Authorization admits only
          // its exact tuple and cannot expand into another Tenant/Brand/object.
          if (r.content !== null) {
            const parsed = parseCatalogFullOptionSetPublicationContent(r.content),
              c = parsed.supportedContent;
            if (
              c.tenantReference !== tenant ||
              c.brandReference !== brand ||
              c.optionSetReference !== r.optionSetReference ||
              c.versionReference !== r.versionReference
            )
              return fail();
          }
          lease(r.requestObservedAt, r.requestValidUntil);
          observation = lease(r.observedAt, r.requestValidUntil).observedAt;
        },
      );
      if (!observation) return fail();
      return Object.freeze({ observedAt: observation, validUntil: deadline });
    },
  });
  function referenceHolder(profile: {
    readonly purpose: string | null;
    readonly fields: readonly string[];
    readonly actions: readonly string[];
    readonly parser: (value: unknown) => unknown;
    readonly catalog?: boolean;
    readonly publication?: boolean;
    readonly history?: boolean;
    readonly multi?: boolean;
  }) {
    return Object.freeze({
      holdUntilTransactionCompletes: (actual: unknown, value: unknown) =>
        hold(
          actual,
          value,
          [
            "tenantReference",
            "actorKind",
            "request",
            "requiredScope",
            "requiredFields",
            "observedAt",
            ...(profile.history ? ["brandReference", "actorReference", "owningAction"] : []),
            ...(profile.purpose ? ["purposeCode"] : []),
            profile.multi ? "requiredPermissions" : "permission",
          ],
          profile.actions,
          (r) => {
            fields(r, profile.fields);
            if (
              r.tenantReference !== tenant ||
              r.actorKind !== "User" ||
              r.requiredScope !== "FullBrandScope" ||
              (profile.purpose && r.purposeCode !== profile.purpose) ||
              (profile.multi
                ? !equal(r.requiredPermissions, profile.actions)
                : r.permission !== profile.actions[0]) ||
              (profile.history &&
                (r.brandReference !== brand ||
                  r.actorReference !== actor ||
                  r.owningAction !== "catalog.product.history.read"))
            )
              return fail();
            if (profile.catalog) {
              const request = catalogRequest(r.request, profile.publication === true);
              lease(r.observedAt, request.validUntil);
            } else {
              const request = profile.parser(r.request) as RecordValue;
              identity(request);
              if (
                request.originalIntentDigest !== originalDigest ||
                request.operationReference !== command.operationReference ||
                request.productReference !== command.productReference ||
                request.versionReference !== command.versionReference ||
                (isPublication &&
                  request.replacementIntentDigest !== command.replacementIntentDigest)
              )
                return fail();
              lease(request.observedAt, request.validUntil);
              lease(r.observedAt, request.validUntil);
            }
          },
        ),
    });
  }
  const shared = {
    recipeAuthority: referenceHolder({
      purpose: "CATALOG_PRODUCT_PUBLICATION_RECIPE_SOURCE_READ",
      fields: recipeProductPublicationReferenceSourceFieldsV2,
      actions: ["recipe.manage"],
      parser: parseRecipeProductPublicationReferenceRequestV2,
    }),
    recipeInventoryAuthority: referenceHolder({
      purpose: "CATALOG_PRODUCT_PUBLICATION_RECIPE_INVENTORY_SOURCE_READ",
      fields: recipeInventoryProductPublicationReferenceSourceFieldsV2,
      actions: ["recipe.manage"],
      parser: parseRecipeInventoryProductPublicationReferenceRequestV2,
    }),
    inventoryAuthority: referenceHolder({
      purpose: null,
      fields: inventoryProductPublicationSkuMappingReferenceFieldsV2,
      actions: inventoryConfigurationReferencePermissions,
      multi: true,
      parser: parseInventoryProductPublicationReferenceRequestV2,
    }),
    pricingAuthority: referenceHolder({
      purpose: "CATALOG_PRODUCT_PUBLICATION_PRICING_SOURCE_READ",
      fields: productPublicationConfigurationReferenceSourceFieldsV2,
      actions: ["pricing.price-book.manage", "pricing.promotion.manage"],
      multi: true,
      parser: parsePricingProductPublicationReferenceRequestV2,
    }),
    priceBookAuthority: referenceHolder({
      purpose: "CATALOG_PRODUCT_PUBLICATION_PRICING_SOURCE_READ",
      fields: productPublicationPriceBookReferenceSourceFieldsV2,
      actions: ["pricing.price-book.manage"],
      parser: parsePricingProductPublicationReferenceRequestV2,
    }),
    optionPriceAuthority: referenceHolder({
      purpose: "CATALOG_PRODUCT_PUBLICATION_PRICING_SOURCE_READ",
      fields: productPublicationOptionPriceReferenceSourceFieldsV2,
      actions: ["pricing.price-book.manage"],
      parser: parsePricingProductPublicationReferenceRequestV2,
    }),
    promotionAuthority: referenceHolder({
      purpose: "CATALOG_PRODUCT_PUBLICATION_PRICING_SOURCE_READ",
      fields: productPublicationPromotionReferenceSourceFieldsV2,
      actions: ["pricing.promotion.manage"],
      parser: parsePricingProductPublicationReferenceRequestV2,
    }),
  };
  function references(publication: boolean) {
    const prefix = publication
      ? "CATALOG_PRODUCT_PUBLICATION"
      : "CATALOG_PRODUCT_WARNING_ACKNOWLEDGEMENT";
    const owner = (suffix: string, requiredFields: readonly string[], history = false) =>
      referenceHolder({
        purpose: `${prefix}_${suffix}`,
        fields: requiredFields,
        actions: ["catalog.manage", ...(history ? ["catalog.product.history.read"] : [])],
        parser: publication
          ? parseCatalogProductPublicationReferenceRequestV2
          : parseCatalogProductWarningAcknowledgementReferenceRequest,
        publication,
        catalog: true,
        history,
      });
    return Object.freeze({
      ...shared,
      historyAuthority: owner(
        "REFERENCE_HISTORY_READ",
        publication
          ? productPublicationReferenceHistoryFieldsV2
          : productWarningAcknowledgementReferenceHistoryFields,
        true,
      ),
      menuAuthority: owner(
        "MENU_SOURCE_READ",
        publication
          ? productPublicationMenuReferenceSourceFieldsV2
          : productWarningAcknowledgementMenuReferenceSourceFields,
      ),
      bundleAuthority: owner(
        "BUNDLE_SOURCE_READ",
        publication
          ? productPublicationBundleReferenceSourceFieldsV2
          : productWarningAcknowledgementBundleReferenceSourceFields,
      ),
      availabilityAuthority: owner(
        "AVAILABILITY_SOURCE_READ",
        publication
          ? productPublicationAvailabilityReferenceSourceFieldsV2
          : productWarningAcknowledgementAvailabilityReferenceSourceFields,
      ),
    });
  }
  const publicationPermissions = [
    "catalog.product.read",
    command.action === "Validate"
      ? "catalog.product.validate"
      : command.action === "SubmitReview"
        ? "catalog.product.submit"
        : command.action === "Approve" || command.action === "Reject"
          ? "catalog.product.approve"
          : "catalog.product.publish",
    "catalog.product.history.read",
    "catalog.product.approval.read",
  ];
  const ackPermissions = [
    "catalog.manage",
    "catalog.product.manage",
    "catalog.product.acknowledge-warnings",
    "catalog.product.read",
    "catalog.product.history.read",
  ];
  const publicationAuthority: ProductPublicationStoreOptionsV2["authority"] = Object.freeze({
    holdUntilTransactionCompletes: (actual: unknown, value: unknown) =>
      hold(
        actual,
        value,
        ["command", "requiredPermissions", "requiredFields", "requiredScope", "observedAt"],
        ["catalog.manage", "catalog.product.manage", ...publicationPermissions],
        (r) => {
          if (
            !isPublication ||
            canonicalizeRfc8785(r.command) !== commandText ||
            !equal(r.requiredPermissions, publicationPermissions) ||
            r.requiredScope !== "FullBrandScope"
          )
            return fail();
          fields(r, productPublicationWriteFieldsV2);
          lease(r.observedAt);
        },
      ),
  });
  const acknowledgementAuthority: ProductPublicationWarningAcknowledgementStoreOptions["authority"] =
    Object.freeze({
      holdUntilTransactionCompletes: (actual: unknown, value: unknown) =>
        hold(
          actual,
          value,
          [
            "command",
            "mode",
            "purposeCode",
            "permission",
            "requiredPermissions",
            "requiredScope",
            "requiredFields",
            "observedAt",
          ],
          ackPermissions,
          (r) => {
            if (
              isPublication ||
              canonicalizeRfc8785(r.command) !== commandText ||
              (r.mode !== "Acknowledge" && r.mode !== "Replay") ||
              r.purposeCode !== command.purposeCode ||
              r.permission !== "catalog.manage" ||
              !equal(r.requiredPermissions, ackPermissions) ||
              r.requiredScope !== "FullBrandScope"
            )
              return fail();
            fields(r, productPublicationWarningAcknowledgementFields);
            lease(r.observedAt);
          },
        ),
    });
  const acknowledgementContentAuthority: ProductPublicationWarningAcknowledgementStoreOptions["contentAuthority"] =
    Object.freeze({
      holdUntilTransactionCompletes: (actual: unknown, value: unknown) =>
        hold(
          actual,
          value,
          [
            ...identityFields,
            "productReference",
            "purposeCode",
            "permission",
            "owningAction",
            "requiredFields",
            "observedAt",
          ],
          ["catalog.manage", "catalog.product.manage", "catalog.product.read", "catalog.sku.read"],
          (r) => {
            identity(r);
            fields(r, productEditorSnapshotFields);
            if (
              isPublication ||
              r.productReference !== command.productReference ||
              r.purposeCode !== "CATALOG_PRODUCT_EDITOR_READ" ||
              r.permission !== "catalog.manage" ||
              r.owningAction !== "catalog.product.manage"
            )
              return fail();
            lease(r.observedAt);
          },
        ),
    });
  const acknowledgementHistoryAuthority: ProductPublicationWarningAcknowledgementStoreOptions["historyAuthority"] =
    Object.freeze({
      holdUntilTransactionCompletes: (actual: unknown, value: unknown) =>
        hold(
          actual,
          value,
          [
            ...identityFields,
            "productReference",
            "purposeCode",
            "permission",
            "owningActions",
            "requiredFields",
            "observedAt",
          ],
          catalogHistory,
          (r) => {
            identity(r);
            fields(r, productPublicationSourceFieldsV2);
            if (
              isPublication ||
              r.productReference !== command.productReference ||
              r.purposeCode !== "CATALOG_PRODUCT_PUBLICATION_SOURCE" ||
              r.permission !== "catalog.manage" ||
              !equal(r.owningActions, ["catalog.product.history.read"])
            )
              return fail();
            lease(r.observedAt);
          },
        ),
    });
  const acknowledgementReportAuthority: ProductPublicationWarningAcknowledgementStoreOptions["reportAuthority"] =
    Object.freeze({
      holdUntilTransactionCompletes: (actual: unknown, value: unknown) =>
        hold(
          actual,
          value,
          [
            ...identityFields,
            "productReference",
            "versionReference",
            "expectedAggregateVersion",
            "expectedPublicationVersion",
            "purposeCode",
            "permission",
            "owningActions",
            "requiredScope",
            "requiredFields",
            "observedAt",
          ],
          ["catalog.manage", "catalog.product.read", "catalog.product.history.read"],
          (r) => {
            identity(r);
            fields(r, productPublicationValidationReportReadFields);
            if (
              isPublication ||
              r.productReference !== command.productReference ||
              r.versionReference !== command.versionReference ||
              r.expectedAggregateVersion !== command.expectedProductAggregateVersion ||
              typeof r.expectedPublicationVersion !== "number" ||
              !Number.isSafeInteger(r.expectedPublicationVersion) ||
              r.expectedPublicationVersion < 1 ||
              r.expectedPublicationVersion > 2147483647 ||
              r.purposeCode !== "CATALOG_PRODUCT_PUBLICATION_VALIDATION_REPORT_READ" ||
              r.permission !== "catalog.manage" ||
              !equal(r.owningActions, ["catalog.product.read", "catalog.product.history.read"]) ||
              r.requiredScope !== "FullBrandScope"
            )
              return fail();
            lease(r.observedAt);
          },
        ),
    });
  const brandAuthority: Configuration["contentPolicy"]["brandAuthority"] = Object.freeze({
    withCurrentContentRead<T>(actual: unknown, value: unknown, work: () => Promise<T>): Promise<T> {
      return withRead("Brand", (captured) => brandHold(actual, captured), value, brandKeys, work);
    },
    async isCurrent(actual: unknown, value: unknown) {
      await brandHold(actual, value);
      return true;
    },
  });
  const tenantAuthority: Configuration["scope"]["tenantAuthority"] = Object.freeze({
    withCurrentBrandReferenceRead<T>(
      actual: unknown,
      value: unknown,
      work: () => Promise<T>,
    ): Promise<T> {
      return withRead("Store", (captured) => tenantHold(actual, captured), value, tenantKeys, work);
    },
    async isCurrent(actual: unknown, value: unknown) {
      await tenantHold(actual, value);
      return true;
    },
  });
  return Object.freeze({
    publicationAuthority,
    acknowledgementAuthority,
    acknowledgementContentAuthority,
    acknowledgementHistoryAuthority,
    acknowledgementReportAuthority,
    contentPolicy: Object.freeze({ policyAuthority, brandAuthority }),
    scope: Object.freeze({ historyAuthority, tenantAuthority }),
    variant: Object.freeze({ authority: variantAuthority }),
    options: Object.freeze({ authority: optionAuthority }),
    tax: Object.freeze({ authority: registry(true) }),
    registeredContent: Object.freeze({ registryAuthority: registry(false) }),
    publicationReferences: references(true),
    acknowledgementReferences: references(false),
  });
}
