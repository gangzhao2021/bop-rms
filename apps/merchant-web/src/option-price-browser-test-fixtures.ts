/** Synthetic browser transport fixtures only. No native IAM, approval or SQL claim.
 * Public owning constructors supply exact full Price snapshots and intent hashes. */
import { parseProductAggregate } from "../../../packages/rms/catalog/src/index.js";
import {
  createCurrencyMetadataSnapshot,
  materializeOptionPriceVersion,
  optionPriceWireSnapshot,
  optionPriceWireState,
  parseCurrencyCode,
  parseOptionPriceAuthoringCommand,
  parseOptionPriceAuthoringState,
  parsePricingDigest,
  parsePricingReference,
  optionPriceIntentDigest,
  type OptionPriceAuthoringState,
} from "../../../packages/rms/pricing/src/index.js";
import { seal, digest } from "./product-publication-v2-test-fixtures.js";
export const priceBrowserId = (n: number) =>
  parsePricingReference(`01902421-7d00-7000-8000-${n.toString(16).padStart(12, "0")}`);
export const priceBrowserCsrf = "p".repeat(43);
const id = priceBrowserId;
export const priceBrowserScope = {
  tenantReference: id(1),
  brandReference: id(2),
  storeReference: id(3),
  actorReference: id(70),
};
export const priceBrowserBinding = {
  bindingReference: id(22),
  optionSetReference: id(32),
  optionSetVersionReference: id(33),
  purpose: "EXTRAS",
  sortOrder: 0,
  enabledOptionReferences: [id(23)],
  defaultSelections: [],
  minimumSelectionOverride: null,
  maximumSelectionOverride: null,
  includedSkuReferences: [],
  excludedSkuReferences: [],
  channelCodes: [],
  storeOverrideAllowed: false,
};
export const priceBrowserCurrency = createCurrencyMetadataSnapshot({
  currencyCode: parseCurrencyCode("CAD"),
  minorUnitExponent: 2,
  metadataVersion: 1,
  metadataVersionReference: id(8),
  metadataDigest: parsePricingDigest(digest("synthetic CAD metadata")),
});
export const priceBrowserCreatedAt = new Date(Date.now() - 3600000).toISOString();
export const priceBrowserWindow = (at = new Date().toISOString()) => ({
  observedAt: at,
  validUntil: new Date(Date.parse(at) + 5000).toISOString(),
});
export function priceBrowserEditor(removed = false) {
  const bindings = removed ? [] : [priceBrowserBinding],
    at = priceBrowserCreatedAt;
  const editorContent = {
    profile: "CatalogProductEditorContentV1",
    localizedShortDescriptions: {},
    localizedDescriptions: { "en-CA": "Synthetic option price Product" },
    preparationNotes: {},
    tagReferences: [],
    attributeValues: [],
    media: [],
    variantDimensions: [],
    variantCombinations: [],
    optionRules: bindings.map((b) => ({
      bindingReference: b.bindingReference,
      versionResolution: "CurrentPublished",
      pricingRule: null,
      conditionalRule: null,
      conflictRule: null,
      variantCondition: [],
    })),
    allergenReferences: [],
    nutritionProfile: null,
  };
  const aggregate = parseProductAggregate({
    productReference: id(4),
    brandReference: id(2),
    internalCode: "SYNTH_PRICE",
    productType: "PreparedFood",
    lifecycle: "Draft",
    aggregateVersion: 7,
    createdAt: at,
    createdByActorReference: id(70),
    updatedAt: at,
    draft: {
      versionReference: id(6),
      baseVersionReference: null,
      status: "Draft",
      defaultLocale: "en-CA",
      localizedNames: { "en-CA": "Synthetic price Product" },
      taxClassificationReference: null,
      skus: [
        {
          skuReference: id(35),
          productReference: id(4),
          brandReference: id(2),
          skuCode: "SYNTH",
          lifecycle: "Active",
          localizedNames: { "en-CA": "Synthetic base SKU" },
          variantSelections: [],
          unitOfSale: "EA",
          unitQuantity: "1",
          createdAt: at,
          createdByActorReference: id(70),
        },
      ],
      optionBindings: bindings,
      createdAt: at,
      updatedAt: at,
      editorContent,
    },
  });
  return seal({
    profile: "CatalogProductEditorSnapshotV1",
    tenantReference: id(1),
    brandReference: id(2),
    productReference: id(4),
    aggregateVersion: 7,
    aggregate,
    contentDigest: digest(editorContent),
    configurationDigest: digest(aggregate.draft),
    contentStatus: "Present",
    ...priceBrowserWindow(),
    referenceEligibility: "NotEvaluated",
    publishValidation: "Incomplete",
    eligibility: "NotEvaluated",
  });
}
export function priceBrowserCurrent(
  states: readonly OptionPriceAuthoringState[],
  actorReference: string,
) {
  const window = priceBrowserWindow(),
    scope = { ...priceBrowserScope, actorReference };
  return {
    profile: "MerchantOptionPriceAuthoringQueryV1",
    ...scope,
    context: {
      profile: "MerchantOptionPriceContextV1",
      ...scope,
      productReference: id(4),
      productAggregateVersion: 7,
      productVersionReference: id(6),
      productSnapshotDigest: digest("saved synthetic Product root7"),
      binding: priceBrowserBinding,
      versionResolution: "CurrentPublished",
      optionReference: id(23),
      optionSetReference: id(32),
      optionSetVersionReference: id(33),
      optionSourceDigest: digest("synthetic current option snapshot"),
      optionSourceAuthority: "CurrentPublishingReleaseAndFrozenContent",
      defaultLocale: "en-CA",
      localizedNames: { "en-CA": "Synthetic choices" },
      choices: [
        {
          optionReference: id(23),
          stableCode: "CHOICE",
          lifecycle: "Active",
          localizedNames: { "en-CA": "Synthetic priced choice" },
        },
      ],
      skus: [
        {
          skuReference: id(35),
          skuCode: "SYNTH",
          lifecycle: "Active",
          localizedNames: { "en-CA": "Synthetic base SKU" },
        },
      ],
      currencyMetadata: priceBrowserCurrency,
      referenceEligibility: "NotEvaluated",
      publishValidation: "Incomplete",
      ...window,
    },
    states: states.map(optionPriceWireState),
    ...window,
  };
}
export function materializePriceBrowserCommand(
  value: unknown,
  current: OptionPriceAuthoringState | null,
  actorReference: string,
  versionReference: string,
) {
  const command = parseOptionPriceAuthoringCommand(value),
    occurredAt = new Date().toISOString();
  const version = materializeOptionPriceVersion({
    command,
    current,
    brandReference: id(2),
    versionReference,
    occurredAt,
    currencyMetadata: priceBrowserCurrency,
  });
  const wire = optionPriceWireSnapshot(version),
    old = current ? optionPriceWireState(current) : null;
  const state = parseOptionPriceAuthoringState({
    profile: "OptionPriceAuthoringStateV1",
    brandReference: id(2),
    ruleReference: command.ruleReference,
    bindingReference: current?.bindingReference ?? command.bindingReference,
    optionReference: current?.optionReference ?? command.optionReference,
    aggregateVersion: (current?.aggregateVersion ?? 0) + 1,
    createdAt: current?.createdAt ?? occurredAt,
    createdByActorReference: current?.createdByActorReference ?? actorReference,
    updatedAt: occurredAt,
    draftAuthorActorReference:
      command.action === "Publish" || command.action === "Archive" ? null : actorReference,
    draft: command.action === "Publish" || command.action === "Archive" ? null : wire,
    currentPublished:
      command.action === "Publish"
        ? wire
        : command.action === "Archive"
          ? null
          : (old?.currentPublished ?? null),
    latestVersion: wire,
  });
  const receipt = {
    profile: "MerchantOptionPriceAuthoringResultV1",
    action: command.action,
    operationReference: command.operationReference,
    ...priceBrowserScope,
    actorReference,
    outcome: "Committed",
    state: optionPriceWireState(state),
    occurredAt,
    ...priceBrowserWindow(occurredAt),
  };
  return { state, receipt, command, intentDigest: optionPriceIntentDigest(command) };
}
