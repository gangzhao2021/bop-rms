import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  CatalogError,
  matchCatalogProductPublicationReferenceGraphs,
  parseCatalogProductPublicationReferenceProvenance,
  parseCatalogProductRetirementCoverage,
  buildCatalogProductWarningAcknowledgementReferenceRequest,
  parseCatalogProductWarningAcknowledgementReferenceRequest,
  bindCatalogProductWarningAcknowledgementQualificationContext,
  parseProductWarningAcknowledgementReferenceHistorySnapshot,
  parseProductWarningAcknowledgementMenuReferenceSourceSnapshot,
  parseProductWarningAcknowledgementBundleReferenceSourceSnapshot,
  parseProductWarningAcknowledgementAvailabilityReferenceSourceSnapshot,
  createPostgresProductWarningAcknowledgementReferenceHistorySource,
  createPostgresProductWarningAcknowledgementMenuReferenceSource,
  createPostgresProductWarningAcknowledgementBundleReferenceSource,
  createPostgresProductWarningAcknowledgementAvailabilityReferenceSource,
  type CatalogProductWarningAcknowledgementReferenceRequest,
  type CatalogProductWarningAcknowledgementQualificationInput,
  type ProductAggregate,
  bindCatalogProductPublicationReferenceRequestV2,
  bindCatalogProductPublicationValidationContextV2,
  deriveCatalogProductPublicationContentIdentity,
  parseProductPublicationReferenceHistorySnapshotV2,
  parseProductPublicationMenuReferenceSourceSnapshotV2,
  parseProductPublicationBundleReferenceSourceSnapshotV2,
  parseProductPublicationAvailabilityReferenceSourceSnapshotV2,
  createPostgresProductPublicationReferenceHistorySourceV2,
  createPostgresProductPublicationMenuReferenceSourceV2,
  createPostgresProductPublicationBundleReferenceSourceV2,
  createPostgresProductPublicationAvailabilityReferenceSourceV2,
  type CatalogProductPublicationReferenceRequestV2,
  type CatalogProductPublicationValidationContextV2,
  type RecordedProductReferenceConfiguration,
  type CatalogProductPublicationValidationSourceEvidence,
} from "@rms/catalog";
import {
  RecipeWorkflowError,
  parseRecipeProductPublicationReferenceRequestV2,
  parseRecipeInventoryProductPublicationReferenceRequestV2,
  parseRecipeProductPublicationReferenceSnapshotV2,
  parseRecipeInventoryProductPublicationReferenceSnapshotV2,
  matchRecipeProductPublicationReferenceGraphsV2,
  matchRecipeInventoryProductPublicationReferenceRootsV2,
  createPostgresRecipeProductPublicationReferenceSourceV2,
  createPostgresRecipeInventoryProductPublicationReferenceSourceV2,
} from "@rms/recipe";
import {
  InventoryItemError,
  parseInventoryProductPublicationReferenceRequestV2,
  parseInventoryProductPublicationSkuMappingReferenceSnapshotV2,
  matchInventoryProductPublicationSkuMappingReferenceGraphsV2,
  createPostgresInventoryProductPublicationSkuMappingReferenceSourceV2,
} from "@rms/inventory";
import {
  parsePricingProductPublicationReferenceRequestV2,
  parseProductPublicationConfigurationReferenceSourceSnapshotV2,
  matchProductPublicationPricingConfigurationReferencesV2,
  matchProductPublicationRecordedPricingConfigurationReferencesV2,
  createPostgresProductPublicationConfigurationReferenceSourceV2,
} from "@rms/pricing";
import { joinMerchantRecipeInventoryReferenceGraphs } from "./merchant-product-recipe-inventory-reference-matches.js";

const hash = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
const fail = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};
interface BoundInput {
  readonly request: CatalogProductPublicationReferenceRequestV2;
  readonly context: CatalogProductPublicationValidationContextV2;
}
/** Preserve the actual command/action, aggregate and head before crossing owners.
 * Opaque owner digests are derived here, never asserted as owner authentication. */
export function bindMerchantProductPublicationReferenceRequestsV2(input: BoundInput) {
  const request = bindCatalogProductPublicationReferenceRequestV2(input.request, input.context),
    context = bindCatalogProductPublicationValidationContextV2({
      command: request.command,
      aggregate: input.context.aggregate,
      current: input.context.current,
      content: input.context.content,
      observedAt: request.observedAt,
    });
  bindCatalogProductPublicationReferenceRequestV2(request, context);
  const c = request.command,
    common = {
      tenantReference: c.tenantReference,
      brandReference: c.brandReference,
      actorReference: c.actorReference,
      actorKind: c.actorKind,
      operationReference: c.operationReference,
      productReference: c.productReference,
      versionReference: c.versionReference,
      originalIntentDigest: request.originalIntentDigest,
      replacementIntentDigest: request.replacementIntentDigest,
      aggregateSnapshotDigest: request.aggregateSnapshotDigest,
      currentPublicationDigest: request.currentPublicationDigest,
      observedAt: request.observedAt,
      validUntil: request.validUntil,
    };
  return Object.freeze({ request, context, ...ownerRequests(common) });
}
function ownerRequests(common: {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly actorReference: string;
  readonly actorKind: "User" | "System";
  readonly operationReference: string;
  readonly productReference: string;
  readonly versionReference: string;
  readonly originalIntentDigest: string;
  readonly replacementIntentDigest: string;
  readonly aggregateSnapshotDigest: string;
  readonly currentPublicationDigest: string | null;
  readonly observedAt: string;
  readonly validUntil: string;
}) {
  return Object.freeze({
    recipe: parseRecipeProductPublicationReferenceRequestV2({
      ...common,
      profile: "RecipeProductPublicationReferenceRequestV2",
      purposeCode: "CATALOG_PRODUCT_PUBLICATION_RECIPE_SOURCE_READ",
    }),
    recipeInventory: parseRecipeInventoryProductPublicationReferenceRequestV2({
      ...common,
      profile: "RecipeInventoryProductPublicationReferenceRequestV2",
      purposeCode: "CATALOG_PRODUCT_PUBLICATION_RECIPE_INVENTORY_SOURCE_READ",
    }),
    inventory: parseInventoryProductPublicationReferenceRequestV2({
      ...common,
      profile: "InventoryProductPublicationReferenceRequestV2",
      purposeCode: "CATALOG_PRODUCT_PUBLICATION_INVENTORY_CONFIGURATION_SOURCE_READ",
    }),
    pricing: parsePricingProductPublicationReferenceRequestV2({
      ...common,
      profile: "PricingProductPublicationReferenceRequestV2",
      purposeCode: "CATALOG_PRODUCT_PUBLICATION_PRICING_SOURCE_READ",
    }),
  });
}
interface AcknowledgementBoundInput {
  readonly request: CatalogProductWarningAcknowledgementReferenceRequest;
  readonly context: CatalogProductWarningAcknowledgementQualificationInput;
}
/** The independent Ack is rebound to the actual report/root/head. No publication
 * action is constructed, and the old source request parser stays closed. */
export function bindMerchantProductWarningAcknowledgementReferenceRequests(
  input: AcknowledgementBoundInput,
) {
  const context = bindCatalogProductWarningAcknowledgementQualificationContext(input.context),
    request = buildCatalogProductWarningAcknowledgementReferenceRequest({
      command: context.command,
      aggregate: context.aggregate,
      current: context.current,
      report: context.report,
      observedAt: context.observedAt,
      validUntil: context.validUntil,
    });
  if (
    canonicalizeRfc8785(request) !==
    canonicalizeRfc8785(parseCatalogProductWarningAcknowledgementReferenceRequest(input.request))
  )
    return fail();
  const c = context.command;
  return Object.freeze({
    request,
    context,
    ...ownerRequests({
      tenantReference: c.tenantReference,
      brandReference: c.brandReference,
      actorReference: c.actorReference,
      actorKind: c.actorKind,
      operationReference: c.operationReference,
      productReference: c.productReference,
      versionReference: c.versionReference,
      originalIntentDigest: request.originalIntentDigest,
      replacementIntentDigest: request.replacementIntentDigest,
      aggregateSnapshotDigest: request.aggregateSnapshotDigest,
      currentPublicationDigest: request.currentPublicationDigest,
      observedAt: request.observedAt,
      validUntil: request.validUntil,
    }),
  });
}
/** Pure composition of parsed stored-reference facts. Currentness and authority
 * come from the enclosing actual owner callbacks, not these DTOs or digests. */
export function composeMerchantProductPublicationReferenceMatchesV2(
  input: BoundInput & {
    readonly history: unknown;
    readonly availability: unknown;
    readonly bundle: unknown;
    readonly menu: unknown;
    readonly recipe: unknown;
    readonly recipeInventory: unknown;
    readonly inventory: unknown;
    readonly pricing: unknown;
    readonly now: string;
  },
) {
  try {
    const bound = bindMerchantProductPublicationReferenceRequestsV2(input),
      { request } = bound,
      history = parseProductPublicationReferenceHistorySnapshotV2(
        input.history,
        request,
        input.now,
      ),
      availability = parseProductPublicationAvailabilityReferenceSourceSnapshotV2(
        input.availability,
        request,
        input.now,
      ),
      bundle = parseProductPublicationBundleReferenceSourceSnapshotV2(
        input.bundle,
        request,
        input.now,
      ),
      menu = parseProductPublicationMenuReferenceSourceSnapshotV2(input.menu, request, input.now),
      recipe = parseRecipeProductPublicationReferenceSnapshotV2(
        input.recipe,
        bound.recipe,
        input.now,
      ),
      recipeInventory = parseRecipeInventoryProductPublicationReferenceSnapshotV2(
        input.recipeInventory,
        bound.recipeInventory,
        input.now,
      ),
      inventory = parseInventoryProductPublicationSkuMappingReferenceSnapshotV2(
        input.inventory,
        bound.inventory,
        input.now,
      ),
      pricing = parseProductPublicationConfigurationReferenceSourceSnapshotV2(
        input.pricing,
        bound.pricing,
        input.now,
      );
    return matchReferenceGraphs(
      bound,
      { history, availability, bundle, menu, recipe, recipeInventory, inventory, pricing },
      input.now,
      "MerchantProductPublicationStoredReferenceMatchesV2",
    );
  } catch {
    return fail();
  }
}
export function composeMerchantProductWarningAcknowledgementReferenceMatches(
  input: AcknowledgementBoundInput & {
    readonly history: unknown;
    readonly availability: unknown;
    readonly bundle: unknown;
    readonly menu: unknown;
    readonly recipe: unknown;
    readonly recipeInventory: unknown;
    readonly inventory: unknown;
    readonly pricing: unknown;
    readonly now: string;
  },
) {
  try {
    const bound = bindMerchantProductWarningAcknowledgementReferenceRequests(input),
      { request } = bound,
      history = parseProductWarningAcknowledgementReferenceHistorySnapshot(
        input.history,
        request,
        input.now,
      ),
      availability = parseProductWarningAcknowledgementAvailabilityReferenceSourceSnapshot(
        input.availability,
        request,
        input.now,
      ),
      bundle = parseProductWarningAcknowledgementBundleReferenceSourceSnapshot(
        input.bundle,
        request,
        input.now,
      ),
      menu = parseProductWarningAcknowledgementMenuReferenceSourceSnapshot(
        input.menu,
        request,
        input.now,
      ),
      recipe = parseRecipeProductPublicationReferenceSnapshotV2(
        input.recipe,
        bound.recipe,
        input.now,
      ),
      recipeInventory = parseRecipeInventoryProductPublicationReferenceSnapshotV2(
        input.recipeInventory,
        bound.recipeInventory,
        input.now,
      ),
      inventory = parseInventoryProductPublicationSkuMappingReferenceSnapshotV2(
        input.inventory,
        bound.inventory,
        input.now,
      ),
      pricing = parseProductPublicationConfigurationReferenceSourceSnapshotV2(
        input.pricing,
        bound.pricing,
        input.now,
      );
    return matchReferenceGraphs(
      bound,
      { history, availability, bundle, menu, recipe, recipeInventory, inventory, pricing },
      input.now,
      "MerchantProductWarningAcknowledgementStoredReferenceMatchesV1",
    );
  } catch {
    return fail();
  }
}

interface ImpactInputs {
  readonly referenceProvenance: unknown;
  readonly publicationCoverage: unknown;
}
function captureImpactInputs(referenceProvenance: unknown, publicationCoverage: unknown) {
  // Both owning inputs retain their individual bounded parsers. A joint generic
  // JSON copy would impose an unrelated shared node budget on complete history.
  return Object.freeze({
    referenceProvenance: parseCatalogProductPublicationReferenceProvenance(referenceProvenance),
    publicationCoverage: parseCatalogProductRetirementCoverage(publicationCoverage),
  });
}
function impactProperty(input: object, field: keyof ImpactInputs): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(input, field);
  if (!descriptor?.enumerable || !("value" in descriptor)) return fail();
  return descriptor.value;
}
/** Join already acquired owning reference facts to exact publication content.
 * This preserves every unresolved relation and grants no impact classification. */
export function composeMerchantProductPublicationImpactReferencesV2(
  input: Parameters<typeof composeMerchantProductPublicationReferenceMatchesV2>[0] & ImpactInputs,
) {
  try {
    const captured = captureImpactInputs(
      impactProperty(input, "referenceProvenance"),
      impactProperty(input, "publicationCoverage"),
    );
    const matches = composeMerchantProductPublicationReferenceMatchesV2(input);
    return joinImpactReferences(
      matches,
      captured,
      input.now,
      "MerchantProductPublicationImpactReferencesV2",
    );
  } catch {
    return fail();
  }
}
export function composeMerchantProductWarningAcknowledgementImpactReferences(
  input: Parameters<typeof composeMerchantProductWarningAcknowledgementReferenceMatches>[0] &
    ImpactInputs,
) {
  try {
    const captured = captureImpactInputs(
      impactProperty(input, "referenceProvenance"),
      impactProperty(input, "publicationCoverage"),
    );
    const matches = composeMerchantProductWarningAcknowledgementReferenceMatches(input);
    return joinImpactReferences(
      matches,
      captured,
      input.now,
      "MerchantProductWarningAcknowledgementImpactReferencesV1",
    );
  } catch {
    return fail();
  }
}
export type MerchantProductPublicationImpactReferencesV2 = ReturnType<
  typeof composeMerchantProductPublicationImpactReferencesV2
>;
export type MerchantProductWarningAcknowledgementImpactReferences = ReturnType<
  typeof composeMerchantProductWarningAcknowledgementImpactReferences
>;
export type MerchantProductPublicationReferenceEvidence =
  readonly CatalogProductPublicationValidationSourceEvidence[];
// These helpers only receive owning-parser output below. Fixed field lists keep
// command/observation metadata out of consent semantics without dropping actual
// foreign version pins, effective periods, stored relationships or unknowns.
function referenceFields(value: object, fields: readonly string[]) {
  return Object.freeze(
    Object.fromEntries(
      fields.map((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor?.enumerable || !("value" in descriptor)) return fail();
        return [key, descriptor.value];
      }),
    ),
  );
}
function referenceSet<T>(values: readonly T[]) {
  return Object.freeze(
    [...new Map(values.map((value) => [canonicalizeRfc8785(value), value]))]
      .sort(([a], [b]) => a.localeCompare(b, "en"))
      .map(([, value]) => value),
  );
}
type StoredReferenceMatches =
  | ReturnType<typeof composeMerchantProductPublicationReferenceMatchesV2>
  | ReturnType<typeof composeMerchantProductWarningAcknowledgementReferenceMatches>;
function joinImpactReferences<
  Matches extends StoredReferenceMatches,
  Profile extends
    | "MerchantProductPublicationImpactReferencesV2"
    | "MerchantProductWarningAcknowledgementImpactReferencesV1",
>(
  matches: Matches,
  captured: ReturnType<typeof captureImpactInputs>,
  now: string,
  profile: Profile,
) {
  const { referenceProvenance, publicationCoverage } = captured;
  const catalog = matchCatalogProductPublicationReferenceGraphs({
    request: matches.request,
    referenceProvenance,
    publicationCoverage,
    menuSource: matches.catalog.menu,
    bundleSource: matches.catalog.bundle,
    availabilitySource: matches.catalog.availability,
    now,
  });
  const equal = (a: unknown, b: unknown) => canonicalizeRfc8785(a) === canonicalizeRfc8785(b);
  const expected = new Map<string, RecordedProductReferenceConfiguration>();
  for (const entry of referenceProvenance.operationProvenance) {
    const digest = hash(entry.referenceConfiguration),
      old = expected.get(digest);
    if (old && !equal(old, entry.referenceConfiguration)) return fail();
    expected.set(digest, entry.referenceConfiguration);
  }
  const stored = new Map<string, Matches["recorded"][number]>();
  for (const item of matches.recorded) {
    const digest = hash(item.configuration);
    if (
      stored.has(digest) ||
      !expected.has(digest) ||
      !equal(expected.get(digest), item.configuration) ||
      !item.recipe ||
      !item.recipeInventory ||
      !item.inventory
    )
      return fail();
    stored.set(digest, item);
  }
  const pricing = new Map<string, Matches["recordedPricing"]["configurations"][number]>();
  for (const item of matches.recordedPricing.configurations) {
    const configuration = expected.get(item.catalogConfigurationDigest);
    if (
      pricing.has(item.catalogConfigurationDigest) ||
      !configuration ||
      configuration.versionReference !== item.versionReference
    )
      return fail();
    pricing.set(item.catalogConfigurationDigest, item);
  }
  const catalogs = new Map<string, (typeof catalog.configurations)[number]>();
  for (const item of catalog.configurations) {
    const digest = item.referenceConfigurationDigest;
    if (
      catalogs.has(digest) ||
      digest !== hash(item.referenceConfiguration) ||
      !expected.has(digest) ||
      !equal(expected.get(digest), item.referenceConfiguration)
    )
      return fail();
    catalogs.set(digest, item);
  }
  if (
    stored.size !== expected.size ||
    pricing.size !== expected.size ||
    catalogs.size !== expected.size
  )
    return fail();
  const recorded = Object.freeze(
    [...expected.keys()].sort().map((digest) => {
      const owner = catalogs.get(digest),
        old = stored.get(digest),
        price = pricing.get(digest);
      if (!owner || !old || !price || !old.recipe || !old.recipeInventory || !old.inventory)
        return fail();
      return Object.freeze({
        ...owner,
        recipe: old.recipe,
        recipeInventory: old.recipeInventory,
        inventory: old.inventory,
        pricing: price,
      });
    }),
  );
  const byDigest = new Map(recorded.map((item) => [item.referenceConfigurationDigest, item]));
  const currentOperation = referenceProvenance.operationProvenance.at(-1);
  if (
    !currentOperation ||
    currentOperation.fullIdentity.coverage !== "FullEditorContent" ||
    !equal(matches.request, referenceProvenance.request) ||
    !equal(matches.current.configuration, currentOperation.referenceConfiguration) ||
    catalog.currentReferenceConfigurationDigest !== hash(currentOperation.referenceConfiguration)
  )
    return fail();
  const currentReferences = byDigest.get(hash(currentOperation.referenceConfiguration));
  if (
    !currentReferences ||
    !matches.current.recipe ||
    !matches.current.recipeInventory ||
    !matches.current.inventory
  )
    return fail();
  // Set-SKU mapping deliberately pins H(minimal reference configuration), not
  // the full publication configuration identity. Keep both provenances distinct.
  const current = Object.freeze({
    ...currentReferences,
    recipe: matches.current.recipe,
    recipeInventory: matches.current.recipeInventory,
    inventory: matches.current.inventory,
    pricing: matches.current.pricing,
    operationProvenance: currentOperation,
  });
  const publications = Object.freeze(
    catalog.publicationCoverage.entries.map((entry) => {
      const references = byDigest.get(hash(entry.referenceConfiguration));
      if (!references || !equal(references.referenceConfiguration, entry.referenceConfiguration))
        return fail();
      return Object.freeze({ ...entry, references });
    }),
  );
  type Configuration = (typeof recorded)[number];
  const perConfiguration = (project: (configuration: Configuration) => unknown) =>
    referenceSet(
      recorded.map((configuration) =>
        Object.freeze({
          referenceConfigurationDigest: configuration.referenceConfigurationDigest,
          references: project(configuration),
        }),
      ),
    );
  const recipeVersion = (value: object) =>
    referenceFields(value, [
      "recipeVersionReference",
      "recipeReference",
      "brandReference",
      "versionNumber",
      "lifecycle",
      "snapshotDigest",
      "effectiveFrom",
      "effectiveUntil",
      "timeZone",
    ]);
  const recipeRoot = (value: object) =>
    referenceFields(value, ["recipeReference", "brandReference", "currentVersionReference"]);
  const modifier = (value: object) =>
    referenceFields(value, [
      "ruleVersionReference",
      "ruleReference",
      "brandReference",
      "recipeReference",
      "recipeVersionReference",
      "bindingReference",
      "optionReference",
      "version",
      "lifecycle",
      "ruleDigest",
      "effectiveFrom",
      "effectiveUntil",
    ]);
  const menuReferences = (contexts: Configuration["menuReferences"]) =>
    referenceSet(
      contexts.map((m) => ({
        review: referenceFields(m.review, [
          "reviewReference",
          "brandReference",
          "menuReference",
          "menuVersionReference",
          "snapshotDigest",
        ]),
        placements: referenceSet(m.placements),
        revisions: referenceSet(
          m.revisions.map((v) =>
            referenceFields(v, [
              "reviewReference",
              "brandReference",
              "menuReference",
              "menuVersionReference",
              "snapshotDigest",
              "state",
            ]),
          ),
        ),
        releases: referenceSet(
          m.releases.map((v) =>
            referenceFields(v, [
              "releaseReference",
              "reviewReference",
              "brandReference",
              "menuReference",
              "menuVersionReference",
              "snapshotDigest",
              "releaseSequence",
              "previousReleaseReference",
              "releaseKind",
            ]),
          ),
        ),
        periods: referenceSet(
          m.periods.map((v) =>
            referenceFields(v, [
              "timingReference",
              "releaseReference",
              "brandReference",
              "menuReference",
              "timeZone",
              "effectiveFrom",
              "effectiveUntil",
              "periodDigest",
            ]),
          ),
        ),
        lifecycle: m.lifecycle?.state ?? null,
      })),
    );
  const availabilityRule = (value: object) =>
    referenceFields(value, [
      "ruleReference",
      "brandReference",
      "sellableType",
      "sellableReference",
      "storeReference",
      "lifecycle",
      "effectiveFrom",
      "effectiveUntil",
    ]);
  const mapping = (value: object) =>
    referenceFields(value, [
      "tenantReference",
      "brandReference",
      "mappingReference",
      "itemReference",
      "mappingVersion",
      "sourceItemVersion",
      "sourceConfigurationOperationReference",
      "action",
      "target",
      "current",
      "sourceConfigurationState",
    ]);
  const requirement = (
    value: Configuration["recipeInventory"]["recipeReachability"]["requirements"][number],
  ) => ({
    kind: value.kind,
    rootRecipeVersionReference: value.rootRecipeVersionReference,
    ownerRecipeVersionReference: value.ownerRecipeVersionReference,
    conditional: value.conditional,
    reference: value.reference,
    modifier: value.modifier === null ? null : modifier(value.modifier),
  });
  const priceVersion = (value: object) =>
    referenceFields(value, [
      "ruleReference",
      "versionReference",
      "versionNumber",
      "snapshotDigest",
      "lifecycle",
      "skuReference",
      "scopeKind",
      "scopeReference",
      "channelCode",
      "orderType",
      "timeZone",
      "effectiveFrom",
      "effectiveUntil",
      "isCurrentVersion",
    ]);
  const priceRoot = (value: object) =>
    referenceFields(value, [
      "ruleReference",
      "brandReference",
      "bindingReference",
      "optionReference",
      "currentVersionReference",
    ]);
  const semantic = {
    history: {
      configurations: referenceSet(recorded.map((c) => c.referenceConfiguration)),
      // A successful Schedule adds this target's own Scheduled head. Its target
      // scope/period is already bound independently; that workflow step cannot
      // invalidate the same references at ActivateScheduled.
      otherPublications: referenceSet(
        publications
          .filter(
            (entry) =>
              entry.publication.versionReference !== matches.request.command.versionReference,
          )
          .map((entry) => ({
            publication: referenceFields(entry.publication, [
              "versionReference",
              "state",
              "contentDigest",
              "configurationDigest",
              "scopeDigest",
              "periodDigest",
              "publishedAt",
              "supersededAt",
            ]),
            referenceConfigurationDigest: hash(entry.referenceConfiguration),
            retirements: referenceSet(
              entry.retirements.map(({ retirement }) => ({
                intent: referenceFields(retirement.replacementIntent, [
                  "previousVersionReference",
                  "previousPublicationOperationReference",
                  "previousScopeDigest",
                  "previousPeriodDigest",
                  "previousSelectorIndex",
                  "previousSelectorDigest",
                ]),
                retiredAt: retirement.retiredAt,
              })),
            ),
          })),
      ),
    },
    menu: {
      configurations: perConfiguration((c) => menuReferences(c.menuReferences)),
      unresolved: menuReferences(catalog.unresolvedMenuReferences),
    },
    bundle: perConfiguration((c) =>
      referenceSet(
        c.bundleReferences.map((b) => ({
          bundle: referenceFields(b.bundle, [
            "bundleReference",
            "brandReference",
            "lifecycle",
            "currentVersionReference",
          ]),
          version: referenceFields(b.version, [
            "bundleVersionReference",
            "bundleReference",
            "brandReference",
            "versionStatus",
            "publishedAt",
            "validationDigest",
          ]),
          group: b.group,
          member: b.member,
          isCurrentBundleVersion: b.isCurrentBundleVersion,
        })),
      ),
    ),
    availability: perConfiguration((c) => ({
      direct: referenceSet(c.availabilityReferences.map(availabilityRule)),
      throughBundles: referenceSet(
        c.bundleAvailabilityReferences.map((b) => ({
          bundleReference: b.bundleReference,
          rule: availabilityRule(b.rule),
        })),
      ),
    })),
    recipe: perConfiguration((c) => ({
      targetMembership: c.recipe.targetMembership,
      references: referenceSet(
        c.recipe.references.map((r) => ({
          recipe: recipeRoot(r.recipe),
          version: recipeVersion(r.version),
          isCurrentRecipeVersion: r.isCurrentRecipeVersion,
          bindings: referenceSet(r.bindings),
          modifiers: referenceSet(
            r.modifiers.map((m) => ({
              reference: {
                ...modifier(m.reference),
                selectedQuantity: m.reference.selectedQuantity,
              },
              matchedSkuReferences: referenceSet(m.matchedSkuReferences),
            })),
          ),
        })),
      ),
      unresolved: referenceSet(
        c.recipe.unresolved.map((r) => ({
          recipe: recipeRoot(r.recipe),
          version: recipeVersion(r.version),
          bindings: referenceSet(r.bindings),
          modifiers: referenceSet(
            r.modifiers.map((m) => ({
              reference: {
                ...modifier(m.reference),
                selectedQuantity: m.reference.selectedQuantity,
              },
              reason: m.reason,
            })),
          ),
        })),
      ),
    })),
    recipeInventory: perConfiguration((c) => ({
      targetMembership: c.recipeInventory.targetMembership,
      rootContexts: referenceSet(c.recipeInventory.rootContexts),
      roots: referenceSet(c.recipeInventory.recipeReachability.rootRecipeVersionReferences),
      versions: referenceSet(
        c.recipeInventory.recipeReachability.reachableVersions.map((v) => ({
          rootRecipeVersionReference: v.rootRecipeVersionReference,
          version: recipeVersion(v.version),
          conditional: v.conditional,
          isCurrentRecipeVersion: v.isCurrentRecipeVersion,
        })),
      ),
      requirements: referenceSet(
        c.recipeInventory.recipeReachability.requirements.map(requirement),
      ),
      inventoryReferences: referenceSet(
        c.recipeInventory.inventoryReferences.map((r) => ({
          requirement: requirement(r.requirement),
          resolution:
            r.resolution.state === "Unresolved"
              ? r.resolution
              : {
                  state: r.resolution.state,
                  item: referenceFields(r.resolution.item, [
                    "tenantReference",
                    "brandReference",
                    "itemReference",
                    "itemType",
                    "currentItemVersion",
                    "currentOperationReference",
                  ]),
                  operation: r.resolution.operation,
                  version: referenceFields(r.resolution.version, [
                    "tenantReference",
                    "brandReference",
                    "itemReference",
                    "itemVersion",
                    "itemType",
                    "lifecycle",
                  ]),
                  isCurrentItemConfiguration: r.resolution.isCurrentItemConfiguration,
                },
        })),
      ),
    })),
    inventory: perConfiguration((c) => {
      const relatedItems = new Set([
        ...c.inventory.references.map((r) => r.mapping.itemReference),
        ...c.inventory.clears.map((r) => r.itemReference),
        ...c.recipeInventory.inventoryReferences.flatMap((r) =>
          r.requirement.kind === "ModifierRemove" ? [] : [r.requirement.reference.sourceReference],
        ),
      ]);
      return {
        references: referenceSet(
          c.inventory.references.map((r) => ({
            mapping: mapping(r.mapping),
            configurationMatch: r.configurationMatch,
            gaps: referenceSet(r.gaps),
          })),
        ),
        clears: referenceSet(c.inventory.clears.map(mapping)),
        // Complete raw unknown coverage stays in the original composite. An
        // unrelated Brand Item is not a discovered Product reference.
        unresolvedItemCoverage: referenceSet(
          c.inventory.unresolvedItemCoverage.filter((r) => relatedItems.has(r.itemReference)),
        ),
      };
    }),
    pricing: perConfiguration((c) => {
      const p = c.pricing.matches;
      return {
        membership: c.pricing.membership,
        matches:
          p === null
            ? null
            : {
                priceEntries: referenceSet(
                  p.priceEntries.map((r) =>
                    referenceFields(r, [
                      "priceBookReference",
                      "brandReference",
                      "currentVersionReference",
                      "versionReference",
                      "versionNumber",
                      "snapshotDigest",
                      "lifecycle",
                      "entryReference",
                      "sellableReference",
                      "scopeKind",
                      "scopeReference",
                      "channelCode",
                      "orderType",
                      "timeZone",
                      "effectiveFrom",
                      "effectiveUntil",
                      "isCurrentVersion",
                    ]),
                  ),
                ),
                optionRoots: referenceSet(p.optionRoots.map(priceRoot)),
                optionVersions: referenceSet(
                  p.optionVersions.map((r) => ({
                    reference: priceVersion(r.reference),
                    matchedSkuReferences: referenceSet(r.matchedSkuReferences),
                    bindingChannelCodes: referenceSet(r.bindingChannelCodes),
                  })),
                ),
                unresolvedOptionRoots: referenceSet(
                  p.unresolvedOptionRoots.map((r) => ({
                    reference: priceRoot(r.reference),
                    versions: referenceSet(r.versions.map(priceVersion)),
                    reason: r.reason,
                  })),
                ),
                unresolvedOptionVersions: referenceSet(
                  p.unresolvedOptionVersions.map((r) => ({
                    reference: priceVersion(r.reference),
                    reason: r.reason,
                  })),
                ),
                promotions: referenceSet(
                  p.promotions.map((r) => ({
                    reference: {
                      ...referenceFields(r.reference, [
                        "promotionReference",
                        "versionReference",
                        "versionNumber",
                        "snapshotDigest",
                        "lifecycle",
                        "promotionType",
                        "benefitScope",
                        "timeZone",
                        "effectiveFrom",
                        "effectiveUntil",
                        "catalogReferenceMode",
                        "isCurrentVersion",
                      ]),
                      eligibility: referenceSet(r.reference.eligibility),
                    },
                    matchedBy: referenceSet(r.matchedBy),
                  })),
                ),
              },
      };
    }),
  };
  const referenceEvidence: MerchantProductPublicationReferenceEvidence = Object.freeze(
    (
      [
        ["history", "PRODUCT_RECORDED_REFERENCE_CONFIGURATIONS", null],
        ["menu", "MENU_PRODUCT_REFERENCES", matches.generations.menu],
        ["bundle", "BUNDLE_PRODUCT_REFERENCES", matches.generations.bundle],
        ["availability", "AVAILABILITY_PRODUCT_REFERENCES", matches.generations.availability],
        ["recipe", "RECIPE_PRODUCT_REFERENCES", matches.generations.recipe],
        ["recipeInventory", "RECIPE_INVENTORY_PRODUCT_REFERENCES", matches.generations.recipe],
        ["inventory", "INVENTORY_PRODUCT_REFERENCES", matches.generations.inventory],
        ["pricing", "PRICING_PRODUCT_REFERENCES", matches.generations.pricing],
      ] as const
    ).map(([key, sourceCode, generation]) =>
      Object.freeze({
        sourceCode,
        sourceDigest:
          key === "history"
            ? hash({
                history: matches.sourceDigests.history,
                provenance: referenceProvenance.digest,
                publicationCoverage: publicationCoverage.digest,
              })
            : matches.sourceDigests[key],
        generation,
        relevantReferenceDigest: hash(semantic[key]),
        observedAt: matches.observedAt,
        validUntil: matches.validUntil,
      }),
    ),
  );
  const body = {
    profile,
    request: matches.request,
    publicationCoverage: catalog.publicationCoverage,
    current,
    publications,
    recorded,
    referenceEvidence,
    unresolvedMenuReferences: catalog.unresolvedMenuReferences,
    sourceDigests: Object.freeze({
      ...matches.sourceDigests,
      storedMatches: matches.digest,
      referenceProvenance: referenceProvenance.digest,
      retirementCoverage: publicationCoverage.digest,
      publicationCoverage: catalog.publicationCoverage.digest,
      catalogReferences: catalog.digest,
    }),
    generations: matches.generations,
    observedAt: matches.observedAt,
    validUntil: matches.validUntil,
    sourceAuthority: "NotEvaluated" as const,
    applicability: "NotEvaluated" as const,
    changeImpact: "NotEvaluated" as const,
    eligibility: "NotEvaluated" as const,
  };
  return Object.freeze({ ...body, digest: hash(body) });
}
interface ParsedReferenceGraphs {
  readonly history: Pick<
    ReturnType<typeof parseProductPublicationReferenceHistorySnapshotV2>,
    "configurations" | "digest"
  >;
  readonly availability: Pick<
    ReturnType<typeof parseProductPublicationAvailabilityReferenceSourceSnapshotV2>,
    "digest" | "generation"
  >;
  readonly bundle: Pick<
    ReturnType<typeof parseProductPublicationBundleReferenceSourceSnapshotV2>,
    "digest" | "generation"
  >;
  readonly menu: Pick<
    ReturnType<typeof parseProductPublicationMenuReferenceSourceSnapshotV2>,
    "digest" | "generation"
  >;
  readonly recipe: ReturnType<typeof parseRecipeProductPublicationReferenceSnapshotV2>;
  readonly recipeInventory: ReturnType<
    typeof parseRecipeInventoryProductPublicationReferenceSnapshotV2
  >;
  readonly inventory: ReturnType<
    typeof parseInventoryProductPublicationSkuMappingReferenceSnapshotV2
  >;
  readonly pricing: ReturnType<
    typeof parseProductPublicationConfigurationReferenceSourceSnapshotV2
  >;
}
/** Already parsed graphs only. The two exported entries fix their own request,
 * context and Catalog parsers before reaching this command-neutral matcher. */
function matchReferenceGraphs<
  Request extends
    | CatalogProductPublicationReferenceRequestV2
    | CatalogProductWarningAcknowledgementReferenceRequest,
  Graphs extends ParsedReferenceGraphs,
  Profile extends
    | "MerchantProductPublicationStoredReferenceMatchesV2"
    | "MerchantProductWarningAcknowledgementStoredReferenceMatchesV1",
>(
  bound: ReturnType<typeof ownerRequests> & {
    readonly request: Request;
    readonly context: { readonly aggregate: ProductAggregate };
  },
  graphs: Graphs,
  now: string,
  profile: Profile,
) {
  const graph = <Key extends keyof Graphs>(key: Key): Graphs[Key] => graphs[key];
  const { request, context } = bound,
    { history, availability, bundle, menu, recipe, recipeInventory, inventory, pricing } = graphs,
    currentConfiguration = deriveCatalogProductPublicationContentIdentity(
      context.aggregate,
    ).referenceConfiguration;
  if (
    !history.configurations.some(
      (c) => canonicalizeRfc8785(c) === canonicalizeRfc8785(currentConfiguration),
    )
  )
    return fail();
  if (
    recipe.generation !== recipeInventory.generation ||
    hash(recipe.recipes) !== hash(recipeInventory.recipes) ||
    hash(recipe.versions) !== hash(recipeInventory.versions)
  )
    return fail();
  const bindingModifiers = recipe.modifiers.map(({ selectedQuantity, ...facts }) => {
      void selectedQuantity;
      return facts;
    }),
    ingredientModifiers = recipeInventory.modifiers.map(({ changeCount, ...facts }) => {
      void changeCount;
      return facts;
    });
  if (hash(bindingModifiers) !== hash(ingredientModifiers)) return fail();
  const configurations = [currentConfiguration, ...history.configurations],
    recipeMatches = matchRecipeProductPublicationReferenceGraphsV2({
      request: bound.recipe,
      source: recipe,
      now,
      targets: configurations.map((c) => ({
        mappingProfile: "KnownProductConfigurationV2",
        catalogConfigurationDigest: hash(c),
        productReference: context.aggregate.productReference,
        versionReference: c.versionReference,
        skuReference: null,
        skuReferences: c.skuReferences,
        bindings: c.bindings.map((b) => ({
          bindingReference: b.bindingReference,
          enabledOptionReferences: b.enabledOptionReferences,
          includedSkuReferences: b.includedSkuReferences,
          excludedSkuReferences: b.excludedSkuReferences,
        })),
      })),
    }),
    roots = recipeMatches.map((m) =>
      [
        ...new Set([...m.references, ...m.unresolved].map((c) => c.version.recipeVersionReference)),
      ].sort(),
    ),
    reachable = matchRecipeInventoryProductPublicationReferenceRootsV2({
      request: bound.recipeInventory,
      source: recipeInventory,
      rootGroups: roots,
      now,
    }),
    joined = joinMerchantRecipeInventoryReferenceGraphs({
      inventory,
      catalogMatches: recipeMatches,
      roots,
      reachable,
      initialBudget:
        recipe.recipes.length +
        recipe.versions.length +
        recipe.bindings.length +
        recipe.modifiers.length +
        recipeInventory.recipes.length +
        recipeInventory.versions.length +
        recipeInventory.ingredients.length +
        recipeInventory.modifiers.length +
        recipeInventory.changes.length +
        inventory.configuration.items.length +
        inventory.configuration.versions.length +
        inventory.configuration.operations.length +
        inventory.mappings.length,
    }),
    direct = matchInventoryProductPublicationSkuMappingReferenceGraphsV2({
      request: bound.inventory,
      source: inventory,
      now,
      targets: configurations.map((c) => ({
        productReference: context.aggregate.productReference,
        productVersionReference: c.versionReference,
        skuReference: null,
        skuReferences: c.skuReferences,
        catalogConfigurationDigest: hash(c),
      })),
    }),
    priceBindings = (c: RecordedProductReferenceConfiguration) =>
      c.bindings.map((b) => ({
        bindingReference: b.bindingReference,
        enabledOptionReferences: b.enabledOptionReferences,
        includedSkuReferences: b.includedSkuReferences,
        excludedSkuReferences: b.excludedSkuReferences,
        channelCodes: b.channelCodes,
      })),
    pricingCommon = {
      request: bound.pricing,
      priceBooks: pricing.priceBooks,
      optionPrices: pricing.optionPrices,
      promotions: pricing.promotions,
      now,
    },
    currentPricing = matchProductPublicationPricingConfigurationReferencesV2({
      ...pricingCommon,
      target: {
        mappingProfile: "CurrentDraftBindings",
        catalogSourceDigest: hash(currentConfiguration),
        productReference: context.aggregate.productReference,
        skuReference: null,
        skuReferences: currentConfiguration.skuReferences,
        categoryReferences: currentConfiguration.categoryReferences,
        bindings: priceBindings(currentConfiguration),
      },
    }),
    recordedPricing = matchProductPublicationRecordedPricingConfigurationReferencesV2({
      ...pricingCommon,
      target: {
        mappingProfile: "RecordedDraftConfigurations",
        catalogSourceDigest: history.digest,
        productReference: context.aggregate.productReference,
        skuReference: null,
        configurations: history.configurations.map((c) => ({
          catalogConfigurationDigest: hash(c),
          versionReference: c.versionReference,
          skuReferences: c.skuReferences,
          categoryReferences: c.categoryReferences,
          bindings: priceBindings(c),
        })),
      },
    });
  if (
    joined.length !== configurations.length ||
    direct.length !== configurations.length ||
    !joined[0] ||
    !direct[0]
  )
    return fail();
  const body = {
    profile,
    request,
    coverage: "CurrentAndRecordedDraftStoredReferences" as const,
    publicationCoverage: "Unavailable" as const,
    futureScheduleCoverage: "Unavailable" as const,
    applicability: "Unavailable" as const,
    saleEligibility: "NotEvaluated" as const,
    publishValidation: "Incomplete" as const,
    sourceDigests: Object.freeze({
      history: history.digest,
      availability: availability.digest,
      bundle: bundle.digest,
      menu: menu.digest,
      recipe: recipe.digest,
      recipeInventory: recipeInventory.digest,
      inventory: inventory.digest,
      pricing: pricing.digest,
    }),
    generations: Object.freeze({
      availability: availability.generation,
      bundle: bundle.generation,
      menu: menu.generation,
      recipe: recipe.generation,
      inventory: inventory.generation,
      pricing: pricing.generation,
    }),
    catalog: Object.freeze({
      availability: graph("availability"),
      bundle: graph("bundle"),
      menu: graph("menu"),
    }),
    current: Object.freeze({
      configuration: currentConfiguration,
      recipe: recipeMatches[0],
      recipeInventory: joined[0],
      inventory: direct[0],
      pricing: currentPricing,
    }),
    recorded: Object.freeze(
      history.configurations.map((configuration, i) =>
        Object.freeze({
          configuration,
          recipe: recipeMatches[i + 1],
          recipeInventory: joined[i + 1],
          inventory: direct[i + 1],
        }),
      ),
    ),
    recordedPricing,
    observedAt: request.observedAt,
    validUntil: request.validUntil,
  };
  return Object.freeze({ ...body, digest: hash(body) });
}

type HistoryOptions = Parameters<
  typeof createPostgresProductPublicationReferenceHistorySourceV2
>[0];
type RecipeOptions = Parameters<typeof createPostgresRecipeProductPublicationReferenceSourceV2>[0];
type RecipeInventoryOptions = Parameters<
  typeof createPostgresRecipeInventoryProductPublicationReferenceSourceV2
>[0];
type InventoryOptions = Parameters<
  typeof createPostgresInventoryProductPublicationSkuMappingReferenceSourceV2
>[0];
type PricingOptions = Parameters<
  typeof createPostgresProductPublicationConfigurationReferenceSourceV2
>[0];
type Transaction = Parameters<HistoryOptions["registerBeforeCommit"]>[0];
export interface MerchantProductPublicationReferenceSourceOptionsV2 extends BoundInput {
  readonly transaction: Transaction;
  readonly clock: HistoryOptions["clock"];
  readonly registerBeforeCommit: HistoryOptions["registerBeforeCommit"];
  readonly historyAuthority: HistoryOptions["authority"];
  readonly availabilityAuthority: Parameters<
    typeof createPostgresProductPublicationAvailabilityReferenceSourceV2
  >[0]["authority"];
  readonly bundleAuthority: Parameters<
    typeof createPostgresProductPublicationBundleReferenceSourceV2
  >[0]["authority"];
  readonly menuAuthority: Parameters<
    typeof createPostgresProductPublicationMenuReferenceSourceV2
  >[0]["authority"];
  readonly recipeAuthority: RecipeOptions["authority"];
  readonly recipeInventoryAuthority: RecipeInventoryOptions["authority"];
  readonly inventoryAuthority: InventoryOptions["authority"];
  readonly pricingAuthority: PricingOptions["authority"];
  readonly priceBookAuthority: PricingOptions["priceBookAuthority"];
  readonly optionPriceAuthority: PricingOptions["optionPriceAuthority"];
  readonly promotionAuthority: PricingOptions["promotionAuthority"];
}
const permissionDenied = (error: unknown) =>
  (error instanceof CatalogError && error.code === "CATALOG_PERMISSION_DENIED") ||
  (error instanceof RecipeWorkflowError && error.code === "RECIPE_PERMISSION_DENIED") ||
  (error instanceof InventoryItemError && error.code === "INVENTORY_ITEM_PERMISSION_DENIED");
/** One caller-owned transaction holds Catalog → Recipe → Inventory → Pricing.
 * Sources register on the actual enclosing UoW; this factory cannot commit it. */
export function createMerchantProductPublicationReferenceSourceV2(
  options: MerchantProductPublicationReferenceSourceOptionsV2,
) {
  const bound = bindMerchantProductPublicationReferenceRequestsV2(options),
    transaction = options.transaction,
    clock = options.clock,
    readClock = clock.now.bind(clock),
    register = options.registerBeforeCommit.bind(options),
    c = bound.request.command,
    common = {
      tenantReference: c.tenantReference,
      brandReference: c.brandReference,
      actorReference: c.actorReference,
      actorKind: c.actorKind,
      clock: { now: readClock },
      registerBeforeCommit: (
        actual: unknown,
        guard: () => Promise<void>,
        finalAssert: () => void,
      ) => {
        ensureTx(actual);
        return register(transaction, guard, finalAssert);
      },
      transactions: { run: <T>(work: (tx: Transaction) => Promise<T>) => work(transaction) },
    },
    history = createPostgresProductPublicationReferenceHistorySourceV2({
      ...common,
      authority: options.historyAuthority,
    }),
    availability = createPostgresProductPublicationAvailabilityReferenceSourceV2({
      ...common,
      authority: options.availabilityAuthority,
    }),
    bundle = createPostgresProductPublicationBundleReferenceSourceV2({
      ...common,
      authority: options.bundleAuthority,
    }),
    menu = createPostgresProductPublicationMenuReferenceSourceV2({
      ...common,
      authority: options.menuAuthority,
    }),
    recipe = createPostgresRecipeProductPublicationReferenceSourceV2({
      ...common,
      authority: options.recipeAuthority,
    }),
    recipeInventory = createPostgresRecipeInventoryProductPublicationReferenceSourceV2({
      ...common,
      authority: options.recipeInventoryAuthority,
    }),
    inventory = createPostgresInventoryProductPublicationSkuMappingReferenceSourceV2({
      ...common,
      authority: options.inventoryAuthority,
    }),
    pricing = createPostgresProductPublicationConfigurationReferenceSourceV2({
      ...common,
      authority: options.pricingAuthority,
      priceBookAuthority: options.priceBookAuthority,
      optionPriceAuthority: options.optionPriceAuthority,
      promotionAuthority: options.promotionAuthority,
    });
  function ensureTx(actual: unknown): asserts actual is Transaction {
    if (actual !== transaction) return fail();
  }
  const source = Object.freeze({
    async withCurrentMatches<T>(
      work: (
        matches: ReturnType<typeof composeMerchantProductPublicationReferenceMatchesV2>,
        tx: Transaction,
      ) => Promise<T>,
    ): Promise<T> {
      try {
        return await history.withCurrentSnapshot(bound.request, (h, tx) => {
          ensureTx(tx);
          return availability.withCurrentSnapshot(bound.request, (a, tx) => {
            ensureTx(tx);
            return bundle.withCurrentSnapshot(bound.request, (b, tx) => {
              ensureTx(tx);
              return menu.withCurrentSnapshot(bound.request, (m, tx) => {
                ensureTx(tx);
                return recipe
                  .withCurrentSnapshot(bound.recipe, (r, tx) => {
                    ensureTx(tx);
                    return recipeInventory.withCurrentSnapshot(bound.recipeInventory, (ri, tx) => {
                      ensureTx(tx);
                      return inventory
                        .withCurrentSnapshot(bound.inventory, (i, tx) => {
                          ensureTx(tx);
                          return pricing
                            .withCurrentSnapshot(bound.pricing, (p, tx) => {
                              ensureTx(tx);
                              return work(
                                composeMerchantProductPublicationReferenceMatchesV2({
                                  request: bound.request,
                                  context: bound.context,
                                  history: h,
                                  availability: a,
                                  bundle: b,
                                  menu: m,
                                  recipe: r,
                                  recipeInventory: ri,
                                  inventory: i,
                                  pricing: p,
                                  now: readClock(),
                                }),
                                tx,
                              );
                            })
                            .catch((error: unknown) => {
                              if (permissionDenied(error))
                                throw new InventoryItemError("INVENTORY_ITEM_PERMISSION_DENIED");
                              throw error;
                            });
                        })
                        .catch((error: unknown) => {
                          if (permissionDenied(error))
                            throw new RecipeWorkflowError("RECIPE_PERMISSION_DENIED");
                          throw error;
                        });
                    });
                  })
                  .catch((error: unknown) => {
                    if (permissionDenied(error))
                      throw new CatalogError("CATALOG_PERMISSION_DENIED");
                    throw error;
                  });
              });
            });
          });
        });
      } catch (error) {
        if (permissionDenied(error)) throw new CatalogError("CATALOG_PERMISSION_DENIED");
        return fail();
      }
    },
  });
  return Object.freeze({
    ...source,
    async withCurrentImpactReferences<T>(
      referenceProvenance: unknown,
      publicationCoverage: unknown,
      work: (
        references: ReturnType<typeof composeMerchantProductPublicationImpactReferencesV2>,
        tx: Transaction,
      ) => Promise<T>,
    ): Promise<T> {
      let captured: ReturnType<typeof captureImpactInputs> | undefined, captureError: unknown;
      try {
        captured = captureImpactInputs(referenceProvenance, publicationCoverage);
      } catch (error) {
        captureError = error;
      }
      // Preserve input bytes before the first holder while retaining the actual
      // source guards on a caught malformed-input/consumer failure as well.
      return source.withCurrentMatches(async (matches, tx) => {
        if (!captured) throw captureError;
        if (typeof work !== "function") return fail();
        const references = joinImpactReferences(
          matches,
          captured,
          readClock(),
          "MerchantProductPublicationImpactReferencesV2",
        );
        return work(references, tx);
      });
    },
  });
}

export interface MerchantProductWarningAcknowledgementReferenceSourceOptions
  extends
    Omit<
      MerchantProductPublicationReferenceSourceOptionsV2,
      | "request"
      | "context"
      | "historyAuthority"
      | "availabilityAuthority"
      | "bundleAuthority"
      | "menuAuthority"
    >,
    AcknowledgementBoundInput {
  readonly historyAuthority: Parameters<
    typeof createPostgresProductWarningAcknowledgementReferenceHistorySource
  >[0]["authority"];
  readonly availabilityAuthority: Parameters<
    typeof createPostgresProductWarningAcknowledgementAvailabilityReferenceSource
  >[0]["authority"];
  readonly bundleAuthority: Parameters<
    typeof createPostgresProductWarningAcknowledgementBundleReferenceSource
  >[0]["authority"];
  readonly menuAuthority: Parameters<
    typeof createPostgresProductWarningAcknowledgementMenuReferenceSource
  >[0]["authority"];
}
/** Same actual transaction and owning source holds for the independent Ack. */
export function createMerchantProductWarningAcknowledgementReferenceSource(
  options: MerchantProductWarningAcknowledgementReferenceSourceOptions,
) {
  const bound = bindMerchantProductWarningAcknowledgementReferenceRequests(options),
    acknowledgementInput = Object.freeze({
      command: bound.context.command,
      aggregate: bound.context.aggregate,
      current: bound.context.current,
      report: bound.context.report,
      observedAt: bound.context.observedAt,
      validUntil: bound.context.validUntil,
    }),
    transaction = options.transaction,
    clock = options.clock,
    readClock = clock.now.bind(clock),
    register = options.registerBeforeCommit.bind(options),
    c = bound.request.command,
    common = {
      tenantReference: c.tenantReference,
      brandReference: c.brandReference,
      actorReference: c.actorReference,
      actorKind: c.actorKind,
      clock: { now: readClock },
      registerBeforeCommit: (
        actual: unknown,
        guard: () => Promise<void>,
        finalAssert: () => void,
      ) => {
        ensureTx(actual);
        return register(transaction, guard, finalAssert);
      },
      transactions: { run: <T>(work: (tx: Transaction) => Promise<T>) => work(transaction) },
    },
    history = createPostgresProductWarningAcknowledgementReferenceHistorySource({
      ...common,
      authority: options.historyAuthority,
    }),
    availability = createPostgresProductWarningAcknowledgementAvailabilityReferenceSource({
      ...common,
      authority: options.availabilityAuthority,
    }),
    bundle = createPostgresProductWarningAcknowledgementBundleReferenceSource({
      ...common,
      authority: options.bundleAuthority,
    }),
    menu = createPostgresProductWarningAcknowledgementMenuReferenceSource({
      ...common,
      authority: options.menuAuthority,
    }),
    recipe = createPostgresRecipeProductPublicationReferenceSourceV2({
      ...common,
      authority: options.recipeAuthority,
    }),
    recipeInventory = createPostgresRecipeInventoryProductPublicationReferenceSourceV2({
      ...common,
      authority: options.recipeInventoryAuthority,
    }),
    inventory = createPostgresInventoryProductPublicationSkuMappingReferenceSourceV2({
      ...common,
      authority: options.inventoryAuthority,
    }),
    pricing = createPostgresProductPublicationConfigurationReferenceSourceV2({
      ...common,
      authority: options.pricingAuthority,
      priceBookAuthority: options.priceBookAuthority,
      optionPriceAuthority: options.optionPriceAuthority,
      promotionAuthority: options.promotionAuthority,
    });
  function ensureTx(actual: unknown): asserts actual is Transaction {
    if (actual !== transaction) return fail();
  }
  const source = Object.freeze({
    async withCurrentMatches<T>(
      work: (
        matches: ReturnType<typeof composeMerchantProductWarningAcknowledgementReferenceMatches>,
        tx: Transaction,
      ) => Promise<T>,
    ): Promise<T> {
      try {
        return await history.withCurrentSnapshot(bound.request, (h, tx) => {
          ensureTx(tx);
          return availability.withCurrentSnapshot(bound.request, (a, tx) => {
            ensureTx(tx);
            return bundle.withCurrentSnapshot(bound.request, (b, tx) => {
              ensureTx(tx);
              return menu.withCurrentSnapshot(bound.request, (m, tx) => {
                ensureTx(tx);
                return recipe
                  .withCurrentSnapshot(bound.recipe, (r, tx) => {
                    ensureTx(tx);
                    return recipeInventory.withCurrentSnapshot(bound.recipeInventory, (ri, tx) => {
                      ensureTx(tx);
                      return inventory
                        .withCurrentSnapshot(bound.inventory, (i, tx) => {
                          ensureTx(tx);
                          return pricing
                            .withCurrentSnapshot(bound.pricing, (p, tx) => {
                              ensureTx(tx);
                              return work(
                                composeMerchantProductWarningAcknowledgementReferenceMatches({
                                  request: bound.request,
                                  context: acknowledgementInput,
                                  history: h,
                                  availability: a,
                                  bundle: b,
                                  menu: m,
                                  recipe: r,
                                  recipeInventory: ri,
                                  inventory: i,
                                  pricing: p,
                                  now: readClock(),
                                }),
                                tx,
                              );
                            })
                            .catch((error: unknown) => {
                              if (permissionDenied(error))
                                throw new InventoryItemError("INVENTORY_ITEM_PERMISSION_DENIED");
                              throw error;
                            });
                        })
                        .catch((error: unknown) => {
                          if (permissionDenied(error))
                            throw new RecipeWorkflowError("RECIPE_PERMISSION_DENIED");
                          throw error;
                        });
                    });
                  })
                  .catch((error: unknown) => {
                    if (permissionDenied(error))
                      throw new CatalogError("CATALOG_PERMISSION_DENIED");
                    throw error;
                  });
              });
            });
          });
        });
      } catch (error) {
        if (permissionDenied(error)) throw new CatalogError("CATALOG_PERMISSION_DENIED");
        return fail();
      }
    },
  });
  return Object.freeze({
    ...source,
    async withCurrentImpactReferences<T>(
      referenceProvenance: unknown,
      publicationCoverage: unknown,
      work: (
        references: ReturnType<typeof composeMerchantProductWarningAcknowledgementImpactReferences>,
        tx: Transaction,
      ) => Promise<T>,
    ): Promise<T> {
      let captured: ReturnType<typeof captureImpactInputs> | undefined, captureError: unknown;
      try {
        captured = captureImpactInputs(referenceProvenance, publicationCoverage);
      } catch (error) {
        captureError = error;
      }
      // Preserve input bytes before the first holder while retaining the actual
      // source guards on a caught malformed-input/consumer failure as well.
      return source.withCurrentMatches(async (matches, tx) => {
        if (!captured) throw captureError;
        if (typeof work !== "function") return fail();
        const references = joinImpactReferences(
          matches,
          captured,
          readClock(),
          "MerchantProductWarningAcknowledgementImpactReferencesV1",
        );
        return work(references, tx);
      });
    },
  });
}
