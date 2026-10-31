import { createMerchantOptionPriceAuthoringCommand } from "../../apps/api/dist/merchant-option-price-authoring-command.js";
import { createMerchantOptionPriceReviewCommand } from "../../apps/api/dist/merchant-option-price-review-command.js";
import {
  createCurrencyMetadataSnapshot,
  parsePricingReference,
} from "../../packages/rms/pricing/src/index.ts";
import { createMerchantProductOptionPickerQuery } from "../../apps/api/dist/merchant-product-option-picker-query.js";
import { createMerchantOptionSetPublicationCommand } from "../../apps/api/dist/merchant-option-set-publication-command.js";
import { createMerchantOptionSetPublicationResolutionCommand } from "../../apps/api/dist/merchant-option-set-publication-resolution-command.js";
import { createMediaScope } from "../../packages/bop/media/src/index.ts";
import { createMerchantOptionSetPublicationContextQuery } from "../../apps/api/dist/merchant-option-set-publication-context-query.js";
import { createMerchantProductSellingUnitRegistry } from "../../apps/api/dist/merchant-product-selling-unit-registry.js";
import { createMerchantOptionSetAuthoringCommand } from "../../apps/api/dist/merchant-option-set-authoring-command.js";
import { createMerchantOptionSetHistoryQuery } from "../../apps/api/dist/merchant-option-set-history-query.js";
import { createMerchantOptionSetCurrentPublicationQuery } from "../../apps/api/dist/merchant-option-set-current-publication-query.js";
import { createMerchantOptionSetEditorQuery } from "../../apps/api/dist/merchant-option-set-editor-query.js";
import { createMerchantOptionSetAuthoringContextQuery } from "../../apps/api/dist/merchant-option-set-authoring-context-query.js";
import { createMerchantOptionSetAuthoringResolutionCommand } from "../../apps/api/dist/merchant-option-set-authoring-resolution-command.js";
import { createMerchantOptionSetListQuery } from "../../apps/api/dist/merchant-option-set-list-query.js";
import { createMerchantProductCreationCommand } from "../../apps/api/dist/merchant-product-creation-command.js";
import { createMerchantProductDraftCommand } from "../../apps/api/dist/merchant-product-draft-command.js";
import { createMerchantProductAuthoringResolutionCommand } from "../../apps/api/dist/merchant-product-authoring-resolution-command.js";
import { createMerchantProductAuthoringContextQuery } from "../../apps/api/dist/merchant-product-authoring-context-query.js";
import { createHash } from "node:crypto";
import { readClosedRecord } from "../../packages/bop/identity/src/index.ts";
import { parseCatalogReference } from "../../packages/rms/catalog/src/index.ts";
import { createMerchantProductPublicationRuntime } from "../../apps/api/dist/merchant-product-runtime.js";
import { createMerchantProductEditorQuery } from "../../apps/api/dist/merchant-product-editor-query.js";
import { createMerchantProductLifecycleCommand } from "../../apps/api/dist/merchant-product-lifecycle-command.js";
import { createMerchantProductListRuntime } from "../../apps/api/dist/merchant-product-list-runtime.js";
import { createMerchantStoreCapability } from "../../apps/api/dist/merchant-store-capability.js";

/** Explicit local composition. Selectors name actual owner records and never
 * enable FeatureControl, provision an Actor, or supply a validation outcome. */
export async function createInternalMerchantProduct(
  resources,
  { persistence, authentication, configuration, createCursorKey },
) {
  const scope = readClosedRecord(configuration.scope, [
      "tenantReference",
      "brandReference",
      "storeReference",
    ]),
    product = readClosedRecord(configuration.product, [
      "contentPolicy",
      "maximumApprovalValiditySeconds",
      ...(Object.hasOwn(configuration.product, "authoringSources") ? ["authoringSources"] : []),
      ...(Object.hasOwn(configuration.product, "optionPriceSources") ? ["optionPriceSources"] : []),
      ...(Object.hasOwn(configuration.product, "optionSetPublicationSources")
        ? ["optionSetPublicationSources"]
        : []),
    ]),
    actual = {
      tenantReference: resources.publicProfile.binding.tenantReference,
      ...resources.scope,
    };
  for (const key of Object.keys(actual))
    if (parseCatalogReference(scope[key]) !== actual[key])
      throw new Error("INTERNAL_PRODUCT_SCOPE_DENIED");
  const namespace = [actual.tenantReference, actual.brandReference, actual.storeReference].join(
      ":",
    ),
    reference = (purpose) => (operation) => {
      const id = parseCatalogReference(operation),
        digest = createHash("sha256")
          .update("bop-rms/internal-product/v1:" + namespace + ":" + purpose + ":" + id)
          .digest("hex");
      // Preserve the original operation timestamp and separate artifact kinds.
      return (
        id.slice(0, 14) +
        "7" +
        digest.slice(0, 3) +
        "-8" +
        digest.slice(3, 6) +
        "-" +
        digest.slice(6, 18)
      );
    };
  const authoringSources =
    product.authoringSources === undefined
      ? undefined
      : readClosedRecord(product.authoringSources, [
          "configurationVersionReference",
          "expectedBrandVersion",
          "policyReference",
          "policyVersion",
          "allergenRegistryVersionReference",
        ]);
  const optionPublicationSources = Object.hasOwn(product, "optionSetPublicationSources")
    ? (() => {
        const selected = readClosedRecord(product.optionSetPublicationSources, [
          "brandConfigurationVersionReference",
          "expectedBrandVersion",
          "policyReference",
          "policyVersion",
          "optionSetPolicyFamilyReference",
          "mediaScope",
        ]);
        const mediaScope = createMediaScope(
          readClosedRecord(selected.mediaScope, ["kind", "brandReference", "storeReference"]),
        );
        for (const key of [
          "brandConfigurationVersionReference",
          "policyReference",
          "optionSetPolicyFamilyReference",
        ])
          parseCatalogReference(selected[key]);
        for (const key of ["expectedBrandVersion", "policyVersion"])
          if (
            !Number.isSafeInteger(selected[key]) ||
            selected[key] < 1 ||
            selected[key] > 2147483647
          )
            throw new Error("INTERNAL_OPTION_PUBLICATION_CONFIGURATION_DENIED");
        if (
          mediaScope.brandReference !== actual.brandReference ||
          (mediaScope.kind === "Store" && mediaScope.storeReference !== actual.storeReference)
        )
          throw new Error("INTERNAL_OPTION_PUBLICATION_SCOPE_DENIED");
        return Object.freeze({ ...selected, mediaScope });
      })()
    : undefined;
  const optionPriceSources = Object.hasOwn(product, "optionPriceSources")
    ? (() => {
        try {
          const selected = readClosedRecord(product.optionPriceSources, [
            "currencyMetadata",
            "publicationPolicyFamilyReference",
          ]);
          return Object.freeze({
            currencyMetadata: createCurrencyMetadataSnapshot(selected.currencyMetadata),
            publicationPolicyFamilyReference: parsePricingReference(
              selected.publicationPolicyFamilyReference,
            ),
          });
        } catch {
          throw new Error("INTERNAL_OPTION_PRICE_CONFIGURATION_DENIED");
        }
      })()
    : undefined;
  const generateOptionReference =
    typeof resources.credentials?.reference === "function"
      ? resources.credentials.reference.bind(resources.credentials)
      : undefined;
  if (optionPublicationSources !== undefined && generateOptionReference === undefined)
    throw new Error("INTERNAL_OPTION_PUBLICATION_GENERATOR_UNAVAILABLE");
  if (optionPriceSources !== undefined && generateOptionReference === undefined)
    throw new Error("INTERNAL_OPTION_PRICE_GENERATOR_UNAVAILABLE");
  const publication = createMerchantProductPublicationRuntime({
    merchant: persistence,
    authentication,
    configuration: {
      sources: {
        contentPolicy: product.contentPolicy,
        evidenceReference: reference("evidence"),
        reviewReference: reference("review"),
      },
      auditReference: reference("audit"),
      maximumApprovalValiditySeconds: product.maximumApprovalValiditySeconds,
    },
  });
  const cursorKey = await createCursorKey();
  return Object.freeze({
    ...publication,
    ...(optionPriceSources === undefined
      ? {}
      : {
          optionPriceAuthoring: createMerchantOptionPriceAuthoringCommand({
            merchant: persistence,
            authentication,
            ...optionPriceSources,
            references: { generate: () => parsePricingReference(generateOptionReference()) },
          }),
          optionPriceReview: createMerchantOptionPriceReviewCommand({
            merchant: persistence,
            authentication,
            ...optionPriceSources,
            references: { generate: () => parsePricingReference(generateOptionReference()) },
          }),
        }),
    ...(optionPublicationSources === undefined
      ? {}
      : {
          optionSetPublicationCommand: createMerchantOptionSetPublicationCommand({
            merchant: persistence,
            authentication,
            ...optionPublicationSources,
            generateReference: () => parseCatalogReference(generateOptionReference()),
          }),
          optionSetPublicationResolution: createMerchantOptionSetPublicationResolutionCommand({
            merchant: persistence,
            authentication,
            optionSetPolicyFamilyReference: optionPublicationSources.optionSetPolicyFamilyReference,
            auditReference: reference("option-publication-resolution-audit"),
          }),
        }),
    productOptionPicker: createMerchantProductOptionPickerQuery({
      merchant: persistence,
      authentication,
    }),
    optionSetCurrentPublication: createMerchantOptionSetCurrentPublicationQuery({
      merchant: persistence,
      authentication,
    }),
    optionSetHistory: createMerchantOptionSetHistoryQuery({
      merchant: persistence,
      authentication,
    }),
    optionSetPublicationContext: createMerchantOptionSetPublicationContextQuery({
      merchant: persistence,
      authentication,
    }),
    optionSetList: createMerchantOptionSetListQuery({
      merchant: persistence,
      authentication,
      cursorKey,
    }),
    ...(generateOptionReference === undefined
      ? {}
      : {
          optionSetAuthoring: createMerchantOptionSetAuthoringCommand({
            merchant: persistence,
            authentication,
            references: { generate: () => parseCatalogReference(generateOptionReference()) },
          }),
          optionSetEditor: createMerchantOptionSetEditorQuery({
            merchant: persistence,
            authentication,
          }),
          optionSetAuthoringContext: createMerchantOptionSetAuthoringContextQuery({
            merchant: persistence,
            authentication,
          }),
          optionSetAuthoringResolution: createMerchantOptionSetAuthoringResolutionCommand({
            merchant: persistence,
            authentication,
            auditReference: reference("option-authoring-resolution-audit"),
          }),
        }),
    ...(authoringSources === undefined
      ? {}
      : {
          productSellingUnitRegistry: createMerchantProductSellingUnitRegistry({
            merchant: persistence,
            authentication,
            auditReference: reference("selling-unit-audit"),
          }),
          productCreation: createMerchantProductCreationCommand({
            merchant: persistence,
            authentication,
            currentRuntime: true,
            authoringSources,
            auditReference: reference("authoring-create-audit"),
          }),
          productDraft: createMerchantProductDraftCommand({
            merchant: persistence,
            authentication,
            currentRuntime: true,
            authoringSources,
            auditReference: reference("authoring-draft-audit"),
          }),
        }),
    productAuthoringResolution: createMerchantProductAuthoringResolutionCommand({
      merchant: persistence,
      authentication,
      auditReference: reference("authoring-resolution-audit"),
    }),
    productAuthoringContext: createMerchantProductAuthoringContextQuery({
      merchant: persistence,
      authentication,
    }),
    productLifecycle: createMerchantProductLifecycleCommand({
      merchant: persistence,
      authentication,
      currentRuntime: true,
      auditReference: reference("audit"),
    }),
    productList: createMerchantProductListRuntime({ merchant: persistence, cursorKey }),
    productEditor: createMerchantProductEditorQuery({
      merchant: persistence,
      authentication,
      currentRuntime: true,
    }),
    storeCapability: createMerchantStoreCapability({
      persistence,
      authentication,
      currentProductRuntime: true,
    }).observe,
  });
}
