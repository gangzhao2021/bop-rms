import { expect, it } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  buildCatalogProductPublicationReferenceProvenance,
  buildCatalogProductRetirementCoverage,
  buildCatalogProductScopeRetirementHeader,
  catalogProductRetirementSourceHeadDigest,
  createCatalogProductPublicationMaterializationV2,
  type CatalogProductRetirementHistoryEntry,
  type CatalogProductScopeRetirementHeader,
  type ProductAggregate,
  type ProductPublicationVersionV2,
  buildCatalogProductWarningAcknowledgementReferenceRequest,
  buildProductWarningAcknowledgementReferenceHistorySnapshot,
  buildProductWarningAcknowledgementMenuReferenceSourceSnapshot,
  buildProductWarningAcknowledgementBundleReferenceSourceSnapshot,
  buildProductWarningAcknowledgementAvailabilityReferenceSourceSnapshot,
  buildCatalogProductPublicationValidationReport,
  parseCatalogProductPublicationValidationDetails,
  parseCatalogProductPublicationWarningAcknowledgementCommand,
  planCatalogProductPublicationV2,
  productPublicationCheckCodes,
  type ProductPublicationFactsV2,
  parseProductAggregate,
  parseProductPublicationCommandV2,
  deriveCatalogProductPublicationContentIdentity,
  bindCatalogProductPublicationValidationContextV2,
  buildCatalogProductPublicationReferenceRequestV2,
  buildProductPublicationReferenceHistorySnapshotV2,
  buildProductPublicationMenuReferenceSourceSnapshotV2,
  buildProductPublicationBundleReferenceSourceSnapshotV2,
  buildProductPublicationAvailabilityReferenceSourceSnapshotV2,
} from "@rms/catalog";
import {
  buildRecipeProductPublicationReferenceSnapshotV2,
  buildRecipeInventoryProductPublicationReferenceSnapshotV2,
} from "@rms/recipe";
import {
  buildInventoryProductPublicationConfigurationReferenceSnapshotV2,
  buildInventoryProductPublicationSkuMappingReferenceSnapshotV2,
} from "@rms/inventory";
import {
  buildProductPublicationPriceBookReferenceSourceSnapshotV2,
  buildProductPublicationOptionPriceReferenceSourceSnapshotV2,
  buildProductPublicationPromotionReferenceSourceSnapshotV2,
  buildProductPublicationConfigurationReferenceSourceSnapshotV2,
} from "@rms/pricing";
import {
  recipeMatchId as id,
  recipeMatchAt as at,
  recipeMatchRaw,
} from "../../../packages/rms/recipe/src/tests/recipe-catalog-reference-matches.fixture.js";
import {
  recipeInventoryMatchRaw,
  recipeInventoryItemId as item,
} from "../../../packages/rms/recipe/src/tests/recipe-inventory-reference-matches.fixture.js";
import {
  composeMerchantProductPublicationImpactReferencesV2 as composeImpact,
  composeMerchantProductWarningAcknowledgementImpactReferences as composeAckImpact,
  bindMerchantProductWarningAcknowledgementReferenceRequests as bindAck,
  composeMerchantProductWarningAcknowledgementReferenceMatches as composeAck,
  bindMerchantProductPublicationReferenceRequestsV2 as bind,
  composeMerchantProductPublicationReferenceMatchesV2 as compose,
} from "./merchant-product-publication-reference-source-v2.js";
const hash = (v: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(v)),
  until = new Date(Date.parse(at) + 5000).toISOString(),
  unavailable = expect.objectContaining({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
function inputs(ingredients = recipeInventoryMatchRaw(), bindings = recipeMatchRaw()) {
  const aggregate = parseProductAggregate({
      productReference: id(3),
      brandReference: id(1),
      internalCode: "SYNTHETIC_REFERENCES",
      productType: "PreparedFood",
      lifecycle: "Draft",
      aggregateVersion: 1,
      createdAt: at,
      createdByActorReference: id(2),
      updatedAt: at,
      draft: {
        versionReference: id(5),
        baseVersionReference: null,
        status: "Draft",
        defaultLocale: "en-CA",
        localizedNames: { "en-CA": "Synthetic references" },
        taxClassificationReference: null,
        skus: [
          {
            skuReference: id(6),
            productReference: id(3),
            brandReference: id(1),
            skuCode: "SYNTHETIC",
            lifecycle: "Active",
            localizedNames: { "en-CA": "Synthetic" },
            variantSelections: [],
            unitOfSale: "EA",
            unitQuantity: "1",
            createdAt: at,
            createdByActorReference: id(2),
          },
        ],
        optionBindings: [
          {
            bindingReference: id(20),
            optionSetReference: id(70),
            optionSetVersionReference: id(71),
            purpose: "SELECT",
            sortOrder: 0,
            defaultSelections: [],
            minimumSelectionOverride: null,
            maximumSelectionOverride: null,
            storeOverrideAllowed: false,
            enabledOptionReferences: [id(80)],
            includedSkuReferences: [id(6)],
            excludedSkuReferences: [],
            channelCodes: [],
          },
        ],
        createdAt: at,
        updatedAt: at,
      },
    }),
    identity = deriveCatalogProductPublicationContentIdentity(aggregate),
    body = { profile: "CatalogProductNoReplacementIntentV1", mode: "None" },
    command = parseProductPublicationCommandV2({
      profile: "CatalogProductPublicationCommandV2",
      purposeCode: "CATALOG_PRODUCT_VERSION_PUBLICATION",
      tenantReference: item(1),
      brandReference: id(1),
      actorReference: id(2),
      actorKind: "User",
      operationReference: id(4),
      productReference: id(3),
      versionReference: id(5),
      expectedProductAggregateVersion: 1,
      expectedPublicationVersion: 0,
      action: "Validate",
      contentDigest: identity.contentDigest,
      configurationDigest: identity.configurationDigest,
      scopeSet: [{ level: "Store", reference: id(90), channelCodes: [], orderTypeCodes: [] }],
      effectivePeriod: {
        timeZone: "UTC",
        effectiveFrom: { instant: at, localDateTime: at.slice(0, -1), utcOffsetMinutes: 0 },
        effectiveUntil: null,
      },
      scheduleReference: null,
      replacementVersionReference: null,
      successorDraftVersionReference: null,
      occurredAt: at,
      reasonCode: "SYNTHETIC",
      replacementIntent: { ...body, digest: hash(body) },
      replacementIntentDigest: hash(body),
    }),
    context = bindCatalogProductPublicationValidationContextV2({
      command,
      aggregate,
      current: null,
      content: null,
      observedAt: at,
    }),
    request = buildCatalogProductPublicationReferenceRequestV2(context, until),
    bound = bind({ request, context }),
    graph = identity.referenceConfiguration,
    rawGraph = ({ categoryCoverage, ...c }: typeof graph) => ({
      ...c,
      categoryClassificationKnown: categoryCoverage === "Known",
    }),
    history = buildProductPublicationReferenceHistorySnapshotV2(
      {
        observedAt: at,
        targetExists: true,
        recordCoverage: true,
        recordedAggregateVersion: 1,
        configurations: [
          rawGraph(graph),
          { ...rawGraph(graph), skuReferences: [id(7)], bindings: [] },
        ],
      },
      request,
      at,
    ),
    emptyCatalog = (families: string[]) => ({
      generation: null,
      observedAt: at,
      counts: Object.fromEntries(families.map((k) => [k, "0"])),
      ...Object.fromEntries(families.map((k) => [k, []])),
    }),
    crossDomain = crossDomainInputs(bound, graph, at, ingredients, bindings);
  return {
    request,
    context,
    now: at,
    history,
    ...crossDomain,
    menu: buildProductPublicationMenuReferenceSourceSnapshotV2(
      emptyCatalog(["reviews", "placements", "revisions", "releases", "periods"]),
      request,
      at,
    ),
    bundle: buildProductPublicationBundleReferenceSourceSnapshotV2(
      emptyCatalog(["bundles", "versions", "groups", "members"]),
      request,
      at,
    ),
    availability: buildProductPublicationAvailabilityReferenceSourceSnapshotV2(
      { generation: null, observedAt: at, rootCount: "0", rules: [] },
      request,
      at,
    ),
  };
}
function crossDomainInputs(
  bound: Pick<ReturnType<typeof bind>, "recipe" | "recipeInventory" | "inventory" | "pricing">,
  graph: ReturnType<
    typeof deriveCatalogProductPublicationContentIdentity
  >["referenceConfiguration"],
  observedAt: string,
  ingredients = recipeInventoryMatchRaw(),
  bindings = recipeMatchRaw(),
) {
  const recipe = buildRecipeProductPublicationReferenceSnapshotV2(
      { ...bindings, observedAt },
      bound.recipe,
      observedAt,
    ),
    recipeInventory = buildRecipeInventoryProductPublicationReferenceSnapshotV2(
      { ...ingredients, observedAt },
      bound.recipeInventory,
      observedAt,
    ),
    scope = { tenantReference: item(1), brandReference: id(1) },
    rows = [
      [6, 1, 7],
      [6, 2, 17],
      [20, 1, 27],
      [30, 1, 37],
    ],
    configuration = buildInventoryProductPublicationConfigurationReferenceSnapshotV2(
      {
        generation: "14",
        observedAt,
        counts: { items: "3", versions: "4", operations: "4" },
        items: [6, 20, 30].map((n) => ({
          ...scope,
          itemReference: item(n),
          itemType: n === 30 ? "RawMaterial" : "FinishedGood",
          createdAt: at,
          precise: true,
        })),
        versions: rows.map(([n = 0, v = 0]) => ({
          ...scope,
          itemReference: item(n),
          itemVersion: String(v),
          itemType: n === 30 ? "RawMaterial" : "FinishedGood",
          lifecycle: "Inactive",
          recordedAt: at,
          precise: true,
        })),
        operations: rows.map(([n = 0, v = 0, o = 0]) => ({
          ...scope,
          itemReference: item(n),
          itemVersion: String(v),
          operationReference: item(o),
          action: v === 1 ? "Create" : "Update",
        })),
      },
      bound.inventory,
      observedAt,
    ),
    inventory = buildInventoryProductPublicationSkuMappingReferenceSnapshotV2(
      {
        generation: "14",
        observedAt,
        count: "1",
        mappings: [
          {
            ...scope,
            mappingReference: item(5),
            itemReference: item(6),
            mappingVersion: "1",
            sourceItemVersion: "1",
            sourceConfigurationOperationReference: item(7),
            action: "Set",
            target: {
              productReference: id(3),
              productVersionReference: id(5),
              skuReference: id(6),
              catalogConfigurationDigest: hash(graph),
            },
            operationReference: item(41),
            mappingIntentDigest: hash("mapping"),
            occurredAt: at,
            precise: true,
          },
        ],
      },
      configuration,
      bound.inventory,
      observedAt,
    ),
    leaf = { observedAt, references: [] },
    pricing = buildProductPublicationConfigurationReferenceSourceSnapshotV2(
      {
        generation: "0",
        priceBooks: buildProductPublicationPriceBookReferenceSourceSnapshotV2(
          leaf,
          bound.pricing,
          observedAt,
        ),
        optionPrices: buildProductPublicationOptionPriceReferenceSourceSnapshotV2(
          leaf,
          bound.pricing,
          observedAt,
        ),
        promotions: buildProductPublicationPromotionReferenceSourceSnapshotV2(
          leaf,
          bound.pricing,
          observedAt,
        ),
      },
      bound.pricing,
      observedAt,
    );
  return { recipe, recipeInventory, inventory, pricing };
}

it("derives all opaque owner tuples from the complete actual context", () => {
  const f = inputs(),
    result = bind(f);
  for (const r of [result.recipe, result.recipeInventory, result.inventory, result.pricing]) {
    expect(r).toMatchObject({
      tenantReference: f.request.command.tenantReference,
      actorKind: "User",
      originalIntentDigest: hash(f.context.command),
      replacementIntentDigest: f.context.replacementIntentDigest,
      aggregateSnapshotDigest: hash(f.context.aggregate),
      currentPublicationDigest: null,
      observedAt: at,
      validUntil: until,
      productReference: id(3),
      versionReference: id(5),
    });
  }
  expect(result.request.command.action).toBe("Validate");
});
it.each(["intent", "aggregate", "replacement", "head", "context"])(
  "rejects changed actual %s before source composition",
  (kind) => {
    const f = inputs();
    if (kind === "intent") f.request = { ...f.request, originalIntentDigest: hash("other") };
    if (kind === "aggregate") f.request = { ...f.request, aggregateSnapshotDigest: hash("other") };
    if (kind === "replacement")
      f.request = { ...f.request, replacementIntentDigest: hash("other") };
    if (kind === "head") f.request = { ...f.request, currentPublicationDigest: hash("other") };
    if (kind === "context") f.context = { ...f.context, scopeDigest: hash("other") };
    expect(() => compose(f)).toThrow(unavailable);
  },
);
it("retains current, historical and indirect stored reference facts without a publish verdict", () => {
  const result = compose(inputs()),
    base = result.current.recipeInventory.inventoryReferences.find(
      (r) => r.requirement.kind === "BaseIngredient" && !r.requirement.conditional,
    );
  expect(base?.resolution).toMatchObject({
    state: "ResolvedStoredConfiguration",
    operation: { operationReference: item(7), itemVersion: 1 },
    version: { itemVersion: 1 },
    isCurrentItemConfiguration: false,
  });
  expect(result.current.inventory.references[0]?.configurationMatch).toBe("Matched");
  expect(
    result.recorded.some((r) =>
      r.inventory?.references.some((x) => x.configurationMatch === "Unresolved"),
    ),
  ).toBe(true);
  expect(
    result.current.recipeInventory.recipeReachability.requirements.some(
      (r) => r.kind === "ModifierRemove",
    ),
  ).toBe(true);
  expect(result.current.inventory.unresolvedItemCoverage).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ itemReference: item(20), currentLink: "Unknown" }),
    ]),
  );
  expect(result.current.pricing.priceEntries).toEqual([]);
  expect(result).toMatchObject({
    publicationCoverage: "Unavailable",
    futureScheduleCoverage: "Unavailable",
    saleEligibility: "NotEvaluated",
    publishValidation: "Incomplete",
    validUntil: until,
  });
});
it.each(["item", "operation", "wrongItem"])(
  "retains unresolved indirect %s instead of empty references",
  (kind) => {
    const raw = recipeInventoryMatchRaw(),
      row = raw.ingredients[1];
    if (!row) throw new Error("fixture");
    if (kind === "item") row.sourceReference = item(99);
    if (kind === "operation") row.sourceVersionReference = item(99);
    if (kind === "wrongItem") row.sourceVersionReference = item(27);
    const result = compose(inputs(raw)),
      base = result.current.recipeInventory.inventoryReferences.find(
        (r) => r.requirement.kind === "BaseIngredient" && !r.requirement.conditional,
      );
    expect(base?.resolution).toMatchObject({
      state: "Unresolved",
      reason:
        kind === "item"
          ? "InventoryItemNotRecorded"
          : kind === "operation"
            ? "InventoryOperationNotRecorded"
            : "InventoryOperationItemMismatch",
    });
  },
);
it.each(["generation", "root", "version", "modifier"])(
  "rejects incoherent independently valid Recipe %s",
  (kind) => {
    const raw = recipeInventoryMatchRaw();
    if (kind === "generation") raw.generation = "8";
    const root = raw.recipes[0],
      version = raw.versions[0],
      modifier = raw.modifiers[0];
    if (!root || !version || !modifier) throw new Error("fixture absent");
    if (kind === "root") root.aggregateVersion = 4;
    if (kind === "version") version.snapshotDigest = hash("other");
    if (kind === "modifier") modifier.ruleDigest = hash("other");
    expect(() => compose(inputs(raw))).toThrow(unavailable);
  },
);
it.each([
  "history",
  "availability",
  "bundle",
  "menu",
  "recipe",
  "recipeInventory",
  "inventory",
  "pricing",
] as const)("rejects missing or foreign-bound %s source", (key) => {
  const f = inputs();
  expect(() => compose({ ...f, [key]: null })).toThrow(unavailable);
  const source = f[key];
  expect(() =>
    compose({
      ...f,
      [key]: { ...source, request: { ...source.request, operationReference: id(999) } },
    }),
  ).toThrow(unavailable);
});
it("refuses exact original expiry and history missing the actual current configuration", () => {
  const f = inputs();
  expect(() => compose({ ...f, now: until })).toThrow(unavailable);
  const entry = f.history.configurations.find((c) => c.skuReferences.includes(id(7)));
  if (!entry) throw new Error("fixture absent");
  const { categoryCoverage, ...wrong } = entry;
  const history = buildProductPublicationReferenceHistorySnapshotV2(
    {
      observedAt: at,
      targetExists: true,
      recordCoverage: true,
      recordedAggregateVersion: 1,
      configurations: [{ ...wrong, categoryClassificationKnown: categoryCoverage === "Known" }],
    },
    f.request,
    at,
  );
  expect(() => compose({ ...f, history })).toThrow(unavailable);
});

// Synthetic immutable report and controlled source rows. These exercise closed
// reference composition, not actual IAM, source SQL, severity policy or an Ack write.
function acknowledgementInputs(ingredients = recipeInventoryMatchRaw()) {
  const prior = inputs(),
    original = prior.context.aggregate,
    fullAggregate = parseProductAggregate({
      ...original,
      draft: {
        ...original.draft,
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
          optionRules: original.draft.optionBindings.map((binding) => ({
            bindingReference: binding.bindingReference,
            versionResolution: "Pinned",
            pricingRule: null,
            conditionalRule: null,
            conflictRule: null,
            variantCondition: [],
          })),
          allergenReferences: [],
          nutritionProfile: null,
        },
      },
    }),
    identity = deriveCatalogProductPublicationContentIdentity(fullAggregate),
    validationCommand = parseProductPublicationCommandV2({
      ...prior.context.command,
      contentDigest: identity.contentDigest,
      configurationDigest: identity.configurationDigest,
    }),
    facts: ProductPublicationFactsV2 = {
      now: at,
      productAggregateVersion: fullAggregate.aggregateVersion,
      contentDigest: identity.contentDigest,
      configurationDigest: identity.configurationDigest,
      scopeDigest: hash(validationCommand.scopeSet),
      periodDigest: hash(validationCommand.effectivePeriod),
      approval: null,
      reviewReference: null,
      replacement: null,
      validation: {
        profile: "CatalogProductPublicationValidationV2",
        replacementIntentDigest: validationCommand.replacementIntentDigest,
        evidenceReference: id(920),
        productAggregateVersion: fullAggregate.aggregateVersion,
        contentDigest: identity.contentDigest,
        configurationDigest: identity.configurationDigest,
        scopeDigest: hash(validationCommand.scopeSet),
        periodDigest: hash(validationCommand.effectivePeriod),
        policyReference: id(921),
        policyVersion: 1,
        approvalPolicy: "Required",
        checks: productPublicationCheckCodes.map((code) => ({
          code,
          outcome:
            code === "ApprovalPolicy" ? "Pending" : code === "ChangeImpact" ? "Warning" : "Pass",
        })),
        warningAcknowledgement: null,
        checkedAt: at,
        validUntil: until,
      },
    },
    current = planCatalogProductPublicationV2(validationCommand, null, facts),
    report = buildCatalogProductPublicationValidationReport({
      command: validationCommand,
      publication: current,
      validation: facts.validation,
      recordedAt: at,
      details: parseCatalogProductPublicationValidationDetails({
        coverage: "Complete",
        impact: "Recorded",
        findings: [
          {
            checkCode: "ChangeImpact",
            outcome: "Warning",
            ruleCode: "SYNTHETIC_REFERENCE_GAP",
            subjectReference: id(3),
            reasonCode: "SYNTHETIC",
            references: [],
          },
        ],
        sources: [
          {
            sourceCode: "SYNTHETIC_REFERENCE",
            sourceDigest: hash("source"),
            generation: "1",
            relevantReferenceDigest: hash("related facts"),
            observedAt: at,
            validUntil: until,
          },
        ],
      }),
    }),
    observedAt = new Date(Date.parse(at) + 60_000).toISOString(),
    validUntil = new Date(Date.parse(observedAt) + 3000).toISOString(),
    aggregate = parseProductAggregate({ ...fullAggregate, aggregateVersion: 2 }),
    command = parseCatalogProductPublicationWarningAcknowledgementCommand({
      profile: "CatalogProductPublicationWarningAcknowledgementCommandV1",
      purposeCode: "CATALOG_PRODUCT_PUBLICATION_WARNING_ACKNOWLEDGEMENT",
      action: "AcknowledgeProductPublicationWarnings",
      tenantReference: validationCommand.tenantReference,
      brandReference: validationCommand.brandReference,
      actorReference: validationCommand.actorReference,
      actorKind: "User",
      operationReference: id(922),
      productReference: validationCommand.productReference,
      versionReference: validationCommand.versionReference,
      expectedProductAggregateVersion: aggregate.aggregateVersion,
      reportOperationReference: report.operationReference,
      reportDigest: report.digest,
      warningBindingDigest: report.warningBindingDigest,
      warningCodes: ["ChangeImpact"],
      reasonCode: "EXPLICIT_REVIEW",
      occurredAt: observedAt,
    }),
    context = { command, aggregate, current, report, observedAt, validUntil },
    request = buildCatalogProductWarningAcknowledgementReferenceRequest(context),
    bound = bindAck({ request, context }),
    crossDomain = crossDomainInputs(
      bound,
      identity.referenceConfiguration,
      observedAt,
      ingredients,
    ),
    emptyCatalog = (families: string[]) => ({
      generation: null,
      observedAt,
      counts: Object.fromEntries(families.map((key) => [key, "0"])),
      ...Object.fromEntries(families.map((key) => [key, []])),
    });
  return {
    request,
    context,
    now: observedAt,
    ...crossDomain,
    history: buildProductWarningAcknowledgementReferenceHistorySnapshot(
      {
        observedAt,
        targetExists: true,
        recordCoverage: true,
        recordedAggregateVersion: aggregate.aggregateVersion,
        configurations: prior.history.configurations.map(
          ({ categoryCoverage, ...configuration }) => ({
            ...configuration,
            categoryClassificationKnown: categoryCoverage === "Known",
          }),
        ),
      },
      request,
      observedAt,
    ),
    menu: buildProductWarningAcknowledgementMenuReferenceSourceSnapshot(
      emptyCatalog(["reviews", "placements", "revisions", "releases", "periods"]),
      request,
      observedAt,
    ),
    bundle: buildProductWarningAcknowledgementBundleReferenceSourceSnapshot(
      emptyCatalog(["bundles", "versions", "groups", "members"]),
      request,
      observedAt,
    ),
    availability: buildProductWarningAcknowledgementAvailabilityReferenceSourceSnapshot(
      { generation: null, observedAt, rootCount: "0", rules: [] },
      request,
      observedAt,
    ),
  };
}

it("binds independent Ack identity through every owner without reusing the publication intent", () => {
  const f = acknowledgementInputs(),
    bound = bindAck(f),
    result = composeAck(f);
  expect(bound.context.command.action).toBe("AcknowledgeProductPublicationWarnings");
  for (const request of [bound.recipe, bound.recipeInventory, bound.inventory, bound.pricing]) {
    expect(request).toMatchObject({
      actorKind: "User",
      actorReference: f.context.command.actorReference,
      operationReference: f.context.command.operationReference,
      originalIntentDigest: hash(f.context.command),
      aggregateSnapshotDigest: hash(f.context.aggregate),
      currentPublicationDigest: hash(f.context.current),
      replacementIntentDigest: f.context.current.replacementIntentDigest,
      observedAt: f.context.observedAt,
      validUntil: f.context.validUntil,
    });
    expect(request.originalIntentDigest).not.toBe(f.context.current.intentDigest);
  }
  expect(f.context.report.validation.validUntil < f.context.observedAt).toBe(true);
  expect(result).toMatchObject({
    profile: "MerchantProductWarningAcknowledgementStoredReferenceMatchesV1",
    publicationCoverage: "Unavailable",
    futureScheduleCoverage: "Unavailable",
    applicability: "Unavailable",
    publishValidation: "Incomplete",
    saleEligibility: "NotEvaluated",
    observedAt: f.context.observedAt,
    validUntil: f.context.validUntil,
  });
  expect(result.catalog.menu.request.command).toEqual(f.context.command);
  expect(result.current.inventory.references[0]?.configurationMatch).toBe("Matched");
  expect(
    result.current.recipeInventory.inventoryReferences.some(
      (row) => row.resolution.state === "ResolvedStoredConfiguration",
    ),
  ).toBe(true);
  expect(
    result.recorded.some((row) =>
      row.inventory?.references.some((reference) => reference.configurationMatch === "Unresolved"),
    ),
  ).toBe(true);
  expect(result.current.inventory.unresolvedItemCoverage.length).toBeGreaterThan(0);
  expect(result.current.pricing.priceEntries).toEqual([]);
});
it.each(["actor", "operation", "reason", "report", "aggregate", "head", "target", "policy"])(
  "rejects transplanted independent Ack %s metadata",
  (kind) => {
    const f = acknowledgementInputs();
    const command = f.context.command;
    if (kind === "actor")
      f.request = { ...f.request, command: { ...command, actorReference: id(930) } };
    if (kind === "operation")
      f.request = { ...f.request, command: { ...command, operationReference: id(930) } };
    if (kind === "reason")
      f.request = { ...f.request, command: { ...command, reasonCode: "DIFFERENT_REASON" } };
    if (kind === "report")
      f.context = { ...f.context, report: { ...f.context.report, digest: hash("other") } };
    if (kind === "aggregate") f.request = { ...f.request, aggregateSnapshotDigest: hash("other") };
    if (kind === "head") f.request = { ...f.request, currentPublicationDigest: hash("other") };
    if (kind === "target") f.request = { ...f.request, replacementIntentDigest: hash("other") };
    if (kind === "policy") f.request = { ...f.request, policyVersion: 2 };
    expect(() => composeAck(f)).toThrow(unavailable);
  },
);
it.each([
  "history",
  "availability",
  "bundle",
  "menu",
  "recipe",
  "recipeInventory",
  "inventory",
  "pricing",
] as const)("rejects missing Ack %s or a snapshot held for the publication operation", (key) => {
  const f = acknowledgementInputs(),
    publication = inputs();
  expect(() => composeAck({ ...f, [key]: null })).toThrow(unavailable);
  expect(() => composeAck({ ...f, [key]: publication[key] })).toThrow(unavailable);
  expect(() => compose({ ...publication, [key]: f[key] })).toThrow(unavailable);
});
it("enforces the fresh Ack transaction deadline without applying the old report lease", () => {
  const f = acknowledgementInputs();
  expect(() => composeAck(f)).not.toThrow();
  expect(() => composeAck({ ...f, now: f.context.validUntil })).toThrow(unavailable);
  expect(() => composeAck({ ...f, now: at })).toThrow(unavailable);
});
it.each(["generation", "version", "modifier"])(
  "retains the shared Recipe coherence fence for Ack %s",
  (kind) => {
    const raw = recipeInventoryMatchRaw(),
      version = raw.versions[0],
      modifier = raw.modifiers[0];
    if (!version || !modifier) throw Error("Missing controlled recipe fixture");
    if (kind === "generation") raw.generation = "8";
    if (kind === "version") version.snapshotDigest = hash("different recipe version");
    if (kind === "modifier") modifier.ruleDigest = hash("different modifier");
    expect(() => composeAck(acknowledgementInputs(raw))).toThrow(unavailable);
  },
);
it("rejects Ack history that contains the right version but omits the actual current graph", () => {
  const f = acknowledgementInputs(),
    old = f.history.configurations.find((c) => c.skuReferences.includes(id(7)));
  if (!old) throw Error("Missing historical reference fixture");
  const { categoryCoverage, ...configuration } = old;
  const history = buildProductWarningAcknowledgementReferenceHistorySnapshot(
    {
      observedAt: f.context.observedAt,
      targetExists: true,
      recordCoverage: true,
      recordedAggregateVersion: f.context.aggregate.aggregateVersion,
      configurations: [
        { ...configuration, categoryClassificationKnown: categoryCoverage === "Known" },
      ],
    },
    f.request,
    f.now,
  );
  expect(() => composeAck({ ...f, history })).toThrow(unavailable);
});

const requiredFixture = <T>(value: T | null | undefined): T => {
  if (value === null || value === undefined) throw Error("Missing controlled reference value");
  return value;
};
const rawConfiguration = ({
  categoryCoverage,
  ...configuration
}: ReturnType<
  typeof deriveCatalogProductPublicationContentIdentity
>["referenceConfiguration"]) => ({
  ...configuration,
  categoryClassificationKnown: categoryCoverage === "Known",
});
function rawEmptyCatalog(observedAt: string, families: readonly string[]) {
  return {
    generation: null,
    observedAt,
    counts: Object.fromEntries(families.map((family) => [family, "0"])),
    ...Object.fromEntries(families.map((family) => [family, []])),
  };
}
function retirementHeader(
  publicationAction: CatalogProductRetirementHistoryEntry["publicationAction"],
  publication: ProductPublicationVersionV2,
  before: ReturnType<typeof buildCatalogProductRetirementCoverage>,
) {
  return buildCatalogProductScopeRetirementHeader({
    publicationAction,
    publication,
    previousPublication: null,
    observedSourceRevision: before.sourceRevision,
    observedSourceHeadDigest: catalogProductRetirementSourceHeadDigest({
      tenantReference: before.tenantReference,
      brandReference: before.brandReference,
      productReference: before.productReference,
      aggregateVersion: before.aggregateVersion,
      sourceRevision: before.sourceRevision,
      latest: before.latest,
    }),
  });
}

// These complete synthetic root histories use actual publication planners and
// materialization. Qualification is deliberately controlled; no SQL or IAM is
// inferred from coherent rows or from the resulting reference graph.
function impactInputs(scheduled = false, beforeSchedule = false) {
  const base = inputs(),
    full = acknowledgementInputs().context.aggregate;
  let aggregate = parseProductAggregate({ ...full, aggregateVersion: 1 });
  const operations: {
      aggregate: ProductAggregate;
      operationReference: string;
      snapshotDigest: string;
      coherent: boolean;
    }[] = [],
    history: {
      publicationAction: "Validate" | "SubmitReview" | "Publish" | "SchedulePublish";
      publication: ProductPublicationVersionV2;
    }[] = [],
    headers: CatalogProductScopeRetirementHeader[] = [];
  const commit = (operationReference: string) =>
    operations.push({
      aggregate,
      operationReference,
      snapshotDigest: hash(aggregate),
      coherent: true,
    });
  commit(id(1200));
  const coverage = () =>
    buildCatalogProductRetirementCoverage({
      tenantReference: base.request.command.tenantReference,
      brandReference: aggregate.brandReference,
      productReference: aggregate.productReference,
      aggregateVersion: aggregate.aggregateVersion,
      sourceRevision: String(aggregate.aggregateVersion),
      observedAt: at,
      history,
      headers,
    });
  const current = () =>
    [...history]
      .reverse()
      .find((entry) => entry.publication.versionReference === aggregate.draft.versionReference)
      ?.publication ?? null;
  const save = (tax: number) => {
    aggregate = parseProductAggregate({
      ...aggregate,
      aggregateVersion: aggregate.aggregateVersion + 1,
      draft: { ...aggregate.draft, taxClassificationReference: id(tax) },
    });
    commit(id(1200 + aggregate.aggregateVersion));
  };
  const transition = (action: (typeof history)[number]["publicationAction"], future = false) => {
    const previous = current(),
      identity = deriveCatalogProductPublicationContentIdentity(aggregate),
      start = future ? new Date(Date.parse(at) + 3600_000).toISOString() : at,
      command = parseProductPublicationCommandV2({
        ...base.context.command,
        action,
        operationReference: id(1300 + aggregate.aggregateVersion),
        versionReference: aggregate.draft.versionReference,
        expectedProductAggregateVersion: aggregate.aggregateVersion,
        expectedPublicationVersion: previous?.publicationVersion ?? 0,
        contentDigest: identity.contentDigest,
        configurationDigest: identity.configurationDigest,
        scopeSet: previous?.scopeSet ?? [
          { level: "Store", reference: id(future ? 91 : 90), channelCodes: [], orderTypeCodes: [] },
        ],
        effectivePeriod: previous?.effectivePeriod ?? {
          timeZone: "UTC",
          effectiveFrom: { instant: start, localDateTime: start.slice(0, -1), utcOffsetMinutes: 0 },
          effectiveUntil: null,
        },
        scheduleReference: action === "SchedulePublish" ? id(1400) : null,
        successorDraftVersionReference: action === "Publish" ? id(40) : null,
      }),
      facts: ProductPublicationFactsV2 = {
        now: at,
        productAggregateVersion: aggregate.aggregateVersion,
        contentDigest: command.contentDigest,
        configurationDigest: command.configurationDigest,
        scopeDigest: hash(command.scopeSet),
        periodDigest: hash(command.effectivePeriod),
        approval: null,
        reviewReference: action === "SubmitReview" ? id(1450 + aggregate.aggregateVersion) : null,
        replacement: null,
        validation: {
          profile: "CatalogProductPublicationValidationV2",
          replacementIntentDigest: command.replacementIntentDigest,
          evidenceReference: id(1500 + aggregate.aggregateVersion),
          productAggregateVersion: aggregate.aggregateVersion,
          contentDigest: command.contentDigest,
          configurationDigest: command.configurationDigest,
          scopeDigest: hash(command.scopeSet),
          periodDigest: hash(command.effectivePeriod),
          policyReference: id(921),
          policyVersion: 1,
          approvalPolicy: "NotRequired",
          checks: productPublicationCheckCodes.map((code) => ({ code, outcome: "Pass" })),
          warningAcknowledgement: null,
          checkedAt: at,
          validUntil: until,
        },
      },
      publication = planCatalogProductPublicationV2(command, previous, facts);
    headers.push(retirementHeader(action, publication, coverage()));
    aggregate =
      publication.state === "Published"
        ? createCatalogProductPublicationMaterializationV2(aggregate, publication).successor
        : parseProductAggregate({ ...aggregate, aggregateVersion: aggregate.aggregateVersion + 1 });
    history.push({ publicationAction: action, publication });
    commit(publication.operationReference);
    return publication;
  };
  save(98);
  const publishedGraph =
    deriveCatalogProductPublicationContentIdentity(aggregate).referenceConfiguration;
  transition("Validate");
  transition("SubmitReview");
  const published = transition("Publish");
  save(99);
  if (scheduled) {
    transition("Validate", true);
    transition("SubmitReview", true);
    if (!beforeSchedule) transition("SchedulePublish", true);
  }
  const head = current(),
    identity = deriveCatalogProductPublicationContentIdentity(aggregate),
    command = parseProductPublicationCommandV2({
      ...base.context.command,
      operationReference: id(1600),
      action:
        head?.state === "Scheduled"
          ? "CancelScheduledPublish"
          : beforeSchedule
            ? "SchedulePublish"
            : "Validate",
      versionReference: aggregate.draft.versionReference,
      expectedProductAggregateVersion: aggregate.aggregateVersion,
      expectedPublicationVersion: head?.publicationVersion ?? 0,
      contentDigest: identity.contentDigest,
      configurationDigest: identity.configurationDigest,
      scopeSet: head?.scopeSet ?? base.context.command.scopeSet,
      effectivePeriod: head?.effectivePeriod ?? base.context.command.effectivePeriod,
      scheduleReference: beforeSchedule ? id(1400) : (head?.scheduleReference ?? null),
    }),
    context = bindCatalogProductPublicationValidationContextV2({
      command,
      aggregate,
      current: head,
      content: null,
      observedAt: at,
    }),
    request = buildCatalogProductPublicationReferenceRequestV2(context, until),
    referenceProvenance = buildCatalogProductPublicationReferenceProvenance(
      { aggregateVersion: aggregate.aggregateVersion, observedAt: at, history: operations },
      request,
      at,
    ),
    configurations = [
      ...new Map(
        referenceProvenance.operationProvenance.map((entry) => [
          hash(entry.referenceConfiguration),
          entry.referenceConfiguration,
        ]),
      ).values(),
    ],
    input = {
      request,
      context,
      now: at,
      referenceProvenance,
      publicationCoverage: coverage(),
      history: buildProductPublicationReferenceHistorySnapshotV2(
        {
          observedAt: at,
          targetExists: true,
          recordCoverage: true,
          recordedAggregateVersion: aggregate.aggregateVersion,
          configurations: configurations.map(rawConfiguration),
        },
        request,
        at,
      ),
      ...crossDomainInputs(bind({ request, context }), publishedGraph, at),
      menu: buildProductPublicationMenuReferenceSourceSnapshotV2(
        rawEmptyCatalog(at, ["reviews", "placements", "revisions", "releases", "periods"]),
        request,
        at,
      ),
      bundle: buildProductPublicationBundleReferenceSourceSnapshotV2(
        rawEmptyCatalog(at, ["bundles", "versions", "groups", "members"]),
        request,
        at,
      ),
      availability: buildProductPublicationAvailabilityReferenceSourceSnapshotV2(
        {
          generation: "1",
          observedAt: at,
          rootCount: "1",
          rules: [
            {
              ruleReference: id(1700),
              brandReference: aggregate.brandReference,
              sellableType: "Sku",
              sellableReference: id(6),
              storeReference: null,
              aggregateVersion: 1,
              lifecycle: "Inactive",
              effectiveFrom: at,
              effectiveUntil: null,
              updatedAt: at,
              precise: true,
            },
          ],
        },
        request,
        at,
      ),
    };
  return { input, published, publishedGraph, operations };
}

function acknowledgementImpactInputs() {
  const f = acknowledgementInputs(),
    initial = parseProductAggregate({ ...f.context.aggregate, aggregateVersion: 1 }),
    empty = buildCatalogProductRetirementCoverage({
      tenantReference: f.context.command.tenantReference,
      brandReference: initial.brandReference,
      productReference: initial.productReference,
      aggregateVersion: 1,
      sourceRevision: "1",
      observedAt: at,
      history: [],
      headers: [],
    }),
    referenceProvenance = buildCatalogProductPublicationReferenceProvenance(
      {
        aggregateVersion: 2,
        observedAt: f.now,
        history: [
          {
            aggregate: initial,
            operationReference: id(1800),
            snapshotDigest: hash(initial),
            coherent: true,
          },
          {
            aggregate: f.context.aggregate,
            operationReference: f.context.current.operationReference,
            snapshotDigest: hash(f.context.aggregate),
            coherent: true,
          },
        ],
      },
      f.request,
      f.now,
    ),
    graph = deriveCatalogProductPublicationContentIdentity(
      f.context.aggregate,
    ).referenceConfiguration;
  return {
    ...f,
    referenceProvenance,
    publicationCoverage: buildCatalogProductRetirementCoverage({
      tenantReference: empty.tenantReference,
      brandReference: empty.brandReference,
      productReference: empty.productReference,
      aggregateVersion: 2,
      sourceRevision: "2",
      observedAt: f.now,
      history: [{ publicationAction: "Validate", publication: f.context.current }],
      headers: [retirementHeader("Validate", f.context.current, empty)],
    }),
    history: buildProductWarningAcknowledgementReferenceHistorySnapshot(
      {
        observedAt: f.now,
        targetExists: true,
        recordCoverage: true,
        recordedAggregateVersion: 2,
        configurations: [rawConfiguration(graph)],
      },
      f.request,
      f.now,
    ),
  };
}

it("joins the exact Published source root instead of the same-version earlier config or successor Draft", () => {
  const f = impactInputs(),
    result = composeImpact(f.input),
    old = compose(f.input),
    published = requiredFixture(
      result.publications.find((entry) => entry.publication.state === "Published"),
    );
  expect(
    result.recorded.filter((entry) => entry.referenceConfiguration.versionReference === id(5)),
  ).toHaveLength(2);
  expect(published.referenceConfiguration).toEqual(f.publishedGraph);
  expect(published.sourceOperation.resultAggregateVersion).toBe(
    f.published.productAggregateVersion,
  );
  expect(published.resultOperation.resultAggregateVersion).toBe(
    f.published.productAggregateVersion + 1,
  );
  expect(published.resultOperation.versionReference).toBe(id(40));
  expect(published.references.referenceConfigurationDigest).toBe(hash(f.publishedGraph));
  expect(published.references.referenceConfigurationDigest).not.toBe(
    f.published.configurationDigest,
  );
  expect(published.references.inventory.references[0]?.configurationMatch).toBe("Matched");
  expect(result.current.referenceConfiguration.versionReference).toBe(id(40));
  expect(result.current.referenceConfiguration.taxClassificationReference).toBe(id(99));
  expect(result.current.inventory.references[0]?.configurationMatch).toBe("Unresolved");
  expect(published.references.availabilityReferences[0]?.lifecycle).toBe("Inactive");
  const recordedPrice = old.recordedPricing.configurations.find(
    (entry) => entry.catalogConfigurationDigest === hash(f.publishedGraph),
  );
  expect(published.references.pricing).toEqual(requiredFixture(recordedPrice));
  expect(result.current.pricing).toEqual(old.current.pricing);
  expect(result).toMatchObject({
    sourceAuthority: "NotEvaluated",
    applicability: "NotEvaluated",
    changeImpact: "NotEvaluated",
    eligibility: "NotEvaluated",
    validUntil: until,
  });
  expect(result.sourceDigests.storedMatches).toBe(old.digest);
  expect(compose(f.input)).toEqual(old);
  expect(old).toMatchObject({
    publicationCoverage: "Unavailable",
    futureScheduleCoverage: "Unavailable",
    publishValidation: "Incomplete",
  });
});
it("retains the actual Scheduled configuration separately from an already Published version", () => {
  const f = impactInputs(true),
    result = composeImpact(f.input),
    scheduled = requiredFixture(
      result.publications.find((entry) => entry.publication.state === "Scheduled"),
    );
  expect(result.publications.map((entry) => entry.publication.state).sort()).toEqual([
    "Published",
    "Scheduled",
  ]);
  expect(scheduled.referenceConfiguration).toEqual(result.current.referenceConfiguration);
  expect(scheduled.references.referenceConfigurationDigest).toBe(
    hash(result.current.referenceConfiguration),
  );
  expect(scheduled.publication.scheduleReference).toBe(id(1400));
  expect(scheduled.references.inventory.references[0]?.configurationMatch).toBe("Unresolved");
});
it("does not upgrade a SKU mapping pinned to the full content configuration hash", () => {
  const f = impactInputs(),
    mapping = requiredFixture(f.input.inventory.mappings[0]),
    { current, sourceConfigurationState, ...storedMapping } = mapping,
    inventory = buildInventoryProductPublicationSkuMappingReferenceSnapshotV2(
      {
        generation: f.input.inventory.generation,
        observedAt: at,
        count: "1",
        mappings: [
          {
            ...storedMapping,
            mappingVersion: String(mapping.mappingVersion),
            sourceItemVersion: String(mapping.sourceItemVersion),
            target: {
              ...requiredFixture(mapping.target),
              catalogConfigurationDigest: f.published.configurationDigest,
            },
            precise: true,
          },
        ],
      },
      f.input.inventory.configuration,
      bind(f.input).inventory,
      at,
    ),
    result = composeImpact({ ...f.input, inventory }),
    published = requiredFixture(
      result.publications.find((entry) => entry.publication.state === "Published"),
    );
  void current;
  void sourceConfigurationState;
  expect(published.references.inventory.references[0]?.configurationMatch).toBe("Unresolved");
  expect(published.references.referenceConfigurationDigest).toBe(hash(f.publishedGraph));
});
it.each(["missing", "extra"])(
  "rejects %s recorded minimal configuration despite individually valid owner snapshots",
  (kind) => {
    const f = impactInputs().input,
      current = deriveCatalogProductPublicationContentIdentity(
        f.context.aggregate,
      ).referenceConfiguration,
      configurations =
        kind === "missing"
          ? f.history.configurations.filter((entry) => hash(entry) === hash(current))
          : [...f.history.configurations, { ...current, taxClassificationReference: id(1999) }],
      history = buildProductPublicationReferenceHistorySnapshotV2(
        {
          observedAt: at,
          targetExists: true,
          recordCoverage: true,
          recordedAggregateVersion: f.context.aggregate.aggregateVersion,
          configurations: configurations.map(rawConfiguration),
        },
        f.request,
        at,
      );
    expect(() => compose({ ...f, history })).not.toThrow();
    expect(() => composeImpact({ ...f, history })).toThrow(unavailable);
  },
);
it.each(["provenance", "coverage", "request", "snapshot", "expiry"])(
  "rejects tampered or expired impact %s",
  (kind) => {
    const f = impactInputs().input;
    const changed = {
      ...f,
      ...(kind === "provenance"
        ? { referenceProvenance: { ...f.referenceProvenance, digest: hash("wrong") } }
        : {}),
      ...(kind === "coverage"
        ? {
            publicationCoverage: {
              ...f.publicationCoverage,
              aggregateVersion: f.publicationCoverage.aggregateVersion - 1,
            },
          }
        : {}),
      ...(kind === "request"
        ? { request: { ...f.request, originalIntentDigest: hash("wrong") } }
        : {}),
      ...(kind === "snapshot" ? { pricing: null } : {}),
      ...(kind === "expiry" ? { now: until } : {}),
    };
    expect(() => composeImpact(changed)).toThrow(unavailable);
  },
);
it("uses the fresh independent Ack request while retaining an expired historical warning report", () => {
  const f = acknowledgementImpactInputs(),
    result = composeAckImpact(f),
    old = composeAck(f);
  expect(f.context.report.validation.validUntil < f.now).toBe(true);
  expect(result.request).toEqual(f.request);
  expect(result.request.originalIntentDigest).toBe(hash(f.context.command));
  expect(result.request.originalIntentDigest).not.toBe(f.context.current.intentDigest);
  expect(result.publications).toEqual([]);
  expect(result.current.operationProvenance.resultAggregateVersion).toBe(2);
  expect(result.current.inventory.references[0]?.configurationMatch).toBe("Matched");
  expect(result.sourceDigests.storedMatches).toBe(old.digest);
  expect(composeAck(f)).toEqual(old);
  expect(() => composeAckImpact({ ...f, now: f.context.validUntil })).toThrow(unavailable);
});
it.each(["actor", "operation", "reason", "report"])(
  "refuses transplanting exact Ack impact %s",
  (kind) => {
    const f = acknowledgementImpactInputs(),
      c = f.request.command,
      command = {
        ...c,
        ...(kind === "actor" ? { actorReference: id(1990) } : {}),
        ...(kind === "operation" ? { operationReference: id(1990) } : {}),
        ...(kind === "reason" ? { reasonCode: "UNCONFIRMED_CHANGE" } : {}),
        ...(kind === "report" ? { reportDigest: hash("other report") } : {}),
      };
    expect(() => composeAckImpact({ ...f, request: { ...f.request, command } })).toThrow(
      unavailable,
    );
  },
);
it("keeps publication and Ack provenance profiles closed even when source graph contents coincide", () => {
  const publication = impactInputs().input,
    acknowledgement = acknowledgementImpactInputs();
  expect(() =>
    composeAckImpact({ ...acknowledgement, referenceProvenance: publication.referenceProvenance }),
  ).toThrow(unavailable);
  expect(() =>
    composeImpact({ ...publication, referenceProvenance: acknowledgement.referenceProvenance }),
  ).toThrow(unavailable);
});

function relevantEvidence(
  result: ReturnType<typeof composeImpact> | ReturnType<typeof composeAckImpact>,
) {
  return result.referenceEvidence.map(({ sourceCode, relevantReferenceDigest }) => ({
    sourceCode,
    relevantReferenceDigest,
  }));
}
function observeImpact(
  fixture: ReturnType<typeof impactInputs>,
  command: ReturnType<typeof parseProductPublicationCommandV2>,
  observedAt: string,
) {
  const f = fixture.input,
    context = bindCatalogProductPublicationValidationContextV2({
      command,
      aggregate: f.context.aggregate,
      current: f.context.current,
      content: null,
      observedAt,
    }),
    validUntil = new Date(Date.parse(observedAt) + 5000).toISOString(),
    request = buildCatalogProductPublicationReferenceRequestV2(context, validUntil),
    bound = bind({ request, context });
  return {
    ...f,
    request,
    context,
    now: observedAt,
    referenceProvenance: buildCatalogProductPublicationReferenceProvenance(
      {
        aggregateVersion: context.aggregate.aggregateVersion,
        observedAt,
        history: fixture.operations,
      },
      request,
      observedAt,
    ),
    publicationCoverage: buildCatalogProductRetirementCoverage({
      tenantReference: f.publicationCoverage.tenantReference,
      brandReference: f.publicationCoverage.brandReference,
      productReference: f.publicationCoverage.productReference,
      aggregateVersion: f.publicationCoverage.aggregateVersion,
      sourceRevision: f.publicationCoverage.sourceRevision,
      observedAt,
      history: f.publicationCoverage.history,
      headers: f.publicationCoverage.headers,
    }),
    history: buildProductPublicationReferenceHistorySnapshotV2(
      {
        observedAt,
        targetExists: true,
        recordCoverage: true,
        recordedAggregateVersion: context.aggregate.aggregateVersion,
        configurations: f.history.configurations.map(rawConfiguration),
      },
      request,
      observedAt,
    ),
    ...crossDomainInputs(bound, fixture.publishedGraph, observedAt),
    menu: buildProductPublicationMenuReferenceSourceSnapshotV2(
      rawEmptyCatalog(observedAt, ["reviews", "placements", "revisions", "releases", "periods"]),
      request,
      observedAt,
    ),
    bundle: buildProductPublicationBundleReferenceSourceSnapshotV2(
      rawEmptyCatalog(observedAt, ["bundles", "versions", "groups", "members"]),
      request,
      observedAt,
    ),
    availability: buildProductPublicationAvailabilityReferenceSourceSnapshotV2(
      {
        generation: f.availability.generation,
        observedAt,
        rootCount: String(f.availability.rules.length),
        rules: f.availability.rules.map((r) => ({ ...r, precise: true })),
      },
      request,
      observedAt,
    ),
  };
}
it("emits bounded actual source evidence without upgrading recorded references to qualification", () => {
  const f = impactInputs(),
    result = composeImpact(f.input),
    ack = composeAckImpact(acknowledgementImpactInputs());
  expect(result.referenceEvidence).toHaveLength(8);
  expect(result.referenceEvidence.map((s) => s.sourceCode)).toEqual(
    ack.referenceEvidence.map((s) => s.sourceCode),
  );
  for (const source of result.referenceEvidence) {
    expect(source.observedAt).toBe(f.input.request.observedAt);
    expect(source.validUntil).toBe(f.input.request.validUntil);
    expect(source.sourceDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(source.relevantReferenceDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  }
  expect(
    result.referenceEvidence.find((s) => s.sourceCode === "RECIPE_PRODUCT_REFERENCES")
      ?.sourceDigest,
  ).toBe(f.input.recipe.digest);
  expect(
    result.referenceEvidence.find((s) => s.sourceCode === "RECIPE_INVENTORY_PRODUCT_REFERENCES")
      ?.generation,
  ).toBe(f.input.recipeInventory.generation);
  expect(result.current.recipe.unresolved.length).toBeGreaterThan(0);
  expect(result).toMatchObject({
    applicability: "NotEvaluated",
    changeImpact: "NotEvaluated",
    eligibility: "NotEvaluated",
  });
  expect(Object.isFrozen(result.referenceEvidence)).toBe(true);
});
it("keeps reference semantics stable across actual Schedule and the System activation request", () => {
  const before = impactInputs(true, true),
    after = impactInputs(true),
    current = requiredFixture(after.input.context.current),
    activationAt = current.effectivePeriod.effectiveFrom.instant,
    command = parseProductPublicationCommandV2({
      ...after.input.context.command,
      action: "ActivateScheduled",
      actorKind: "System",
      actorReference: id(2000),
      operationReference: id(2001),
      successorDraftVersionReference: id(2002),
      occurredAt: activationAt,
    }),
    scheduled = composeImpact(before.input),
    activating = composeImpact(observeImpact(after, command, activationAt));
  expect(before.input.context.current?.state).toBe("InReview");
  expect(before.input.context.command.action).toBe("SchedulePublish");
  expect(activating.request.command.action).toBe("ActivateScheduled");
  expect(activating.publications.some((e) => e.publication.state === "Scheduled")).toBe(true);
  expect(scheduled.publications.some((e) => e.publication.state === "Scheduled")).toBe(false);
  expect(relevantEvidence(activating)).toEqual(relevantEvidence(scheduled));
  expect(activating.sourceDigests).not.toEqual(scheduled.sourceDigests);
});
it("ignores new request identity and observation time while retaining the original source lease", () => {
  const f = impactInputs(),
    baseline = composeImpact(f.input),
    observedAt = new Date(Date.parse(at) + 1000).toISOString(),
    command = parseProductPublicationCommandV2({
      ...f.input.context.command,
      operationReference: id(2010),
      actorReference: id(2011),
      occurredAt: observedAt,
    }),
    changed = observeImpact(f, command, observedAt),
    result = composeImpact(changed);
  expect(relevantEvidence(result)).toEqual(relevantEvidence(baseline));
  expect(result.digest).not.toBe(baseline.digest);
  expect(result.referenceEvidence.every((s) => s.validUntil === changed.request.validUntil)).toBe(
    true,
  );
  expect(() => composeImpact({ ...changed, now: changed.request.validUntil })).toThrow(unavailable);
});
it("ignores unrelated owner rows, generations and root metadata while retaining actual source digests", () => {
  const f = impactInputs().input,
    baseline = composeImpact(f),
    raw = recipeMatchRaw(),
    ingredients = recipeInventoryMatchRaw(),
    changedRoots = raw.recipes.map((r) => ({ ...r, aggregateVersion: r.aggregateVersion + 1 })),
    bound = bind(f),
    recipe = buildRecipeProductPublicationReferenceSnapshotV2(
      { ...raw, generation: "8", recipes: changedRoots },
      bound.recipe,
      at,
    ),
    recipeInventory = buildRecipeInventoryProductPublicationReferenceSnapshotV2(
      { ...ingredients, generation: "8", recipes: changedRoots },
      bound.recipeInventory,
      at,
    ),
    first = requiredFixture(f.availability.rules[0]),
    availability = buildProductPublicationAvailabilityReferenceSourceSnapshotV2(
      {
        generation: "2",
        observedAt: at,
        rootCount: "2",
        rules: [
          { ...first, aggregateVersion: first.aggregateVersion + 1, precise: true },
          { ...first, ruleReference: id(2020), sellableReference: id(2021), precise: true },
        ],
      },
      f.request,
      at,
    ),
    result = composeImpact({ ...f, recipe, recipeInventory, availability });
  expect(relevantEvidence(result)).toEqual(relevantEvidence(baseline));
  expect(result.referenceEvidence.map((s) => s.sourceDigest)).not.toEqual(
    baseline.referenceEvidence.map((s) => s.sourceDigest),
  );
  expect(result.generations).not.toEqual(baseline.generations);
});
it.each(["changed", "deleted"])(
  "detects a %s matched Availability relation without assigning policy severity",
  (mode) => {
    const f = impactInputs().input,
      baseline = composeImpact(f),
      first = requiredFixture(f.availability.rules[0]),
      rules = mode === "deleted" ? [] : [{ ...first, lifecycle: "Active", precise: true }],
      availability = buildProductPublicationAvailabilityReferenceSourceSnapshotV2(
        { generation: "2", observedAt: at, rootCount: String(rules.length), rules },
        f.request,
        at,
      ),
      result = composeImpact({ ...f, availability }),
      before = requiredFixture(
        baseline.referenceEvidence.find((s) => s.sourceCode === "AVAILABILITY_PRODUCT_REFERENCES"),
      ),
      after = requiredFixture(
        result.referenceEvidence.find((s) => s.sourceCode === "AVAILABILITY_PRODUCT_REFERENCES"),
      );
    expect(after.relevantReferenceDigest).not.toBe(before.relevantReferenceDigest);
    expect(result.changeImpact).toBe("NotEvaluated");
  },
);
it("keeps a changed foreign Inventory configuration pin visible in indirect reference semantics", () => {
  const f = impactInputs().input,
    baseline = composeImpact(f),
    raw = recipeInventoryMatchRaw(),
    bound = bind(f),
    ingredients = raw.ingredients.map((r) =>
      r.sourceKind === "InventoryItem" ? { ...r, sourceVersionReference: item(17) } : r,
    ),
    recipeInventory = buildRecipeInventoryProductPublicationReferenceSnapshotV2(
      { ...raw, generation: "8", ingredients },
      bound.recipeInventory,
      at,
    ),
    recipe = buildRecipeProductPublicationReferenceSnapshotV2(
      { ...recipeMatchRaw(), generation: "8" },
      bound.recipe,
      at,
    ),
    result = composeImpact({ ...f, recipe, recipeInventory });
  expect(
    result.referenceEvidence.find((s) => s.sourceCode === "RECIPE_INVENTORY_PRODUCT_REFERENCES")
      ?.relevantReferenceDigest,
  ).not.toBe(
    baseline.referenceEvidence.find((s) => s.sourceCode === "RECIPE_INVENTORY_PRODUCT_REFERENCES")
      ?.relevantReferenceDigest,
  );
});
it("preserves unrelated Inventory unknown coverage without turning it into a Product reference change", () => {
  const f = impactInputs().input,
    baseline = composeImpact(f),
    bound = bind(f),
    c = f.inventory.configuration,
    configuration = buildInventoryProductPublicationConfigurationReferenceSnapshotV2(
      {
        generation: "15",
        observedAt: at,
        counts: {
          items: String(c.items.length),
          versions: String(c.versions.length),
          operations: String(c.operations.length),
        },
        items: c.items.map(({ currentItemVersion, currentOperationReference, ...r }) => {
          void currentItemVersion;
          void currentOperationReference;
          return {
            ...r,
            itemType: r.itemReference === item(30) ? "FinishedGood" : r.itemType,
            precise: true,
          };
        }),
        versions: c.versions.map((r) => ({
          ...r,
          itemType: r.itemReference === item(30) ? "FinishedGood" : r.itemType,
          itemVersion: String(r.itemVersion),
          precise: true,
        })),
        operations: c.operations.map((r) => ({ ...r, itemVersion: String(r.itemVersion) })),
      },
      bound.inventory,
      at,
    ),
    inventory = buildInventoryProductPublicationSkuMappingReferenceSnapshotV2(
      {
        generation: "15",
        observedAt: at,
        count: String(f.inventory.mappings.length),
        mappings: f.inventory.mappings.map(({ current, sourceConfigurationState, ...r }) => {
          void current;
          void sourceConfigurationState;
          return {
            ...r,
            mappingVersion: String(r.mappingVersion),
            sourceItemVersion: String(r.sourceItemVersion),
            precise: true,
          };
        }),
      },
      configuration,
      bound.inventory,
      at,
    ),
    result = composeImpact({ ...f, inventory });
  expect(
    baseline.current.inventory.unresolvedItemCoverage.some((r) => r.itemReference === item(30)),
  ).toBe(false);
  expect(
    result.current.inventory.unresolvedItemCoverage.some((r) => r.itemReference === item(30)),
  ).toBe(true);
  expect(relevantEvidence(result)).toEqual(relevantEvidence(baseline));
  expect(result.changeImpact).toBe("NotEvaluated");
});
it("normalizes the actual owning relation sets without hashing transport order", () => {
  const f = impactInputs().input,
    bound = bind(f),
    raw = recipeMatchRaw(),
    ingredients = recipeInventoryMatchRaw(),
    recipe = buildRecipeProductPublicationReferenceSnapshotV2(
      {
        ...raw,
        recipes: [...raw.recipes].reverse(),
        versions: [...raw.versions].reverse(),
        bindings: [...raw.bindings].reverse(),
        modifiers: [...raw.modifiers].reverse(),
      },
      bound.recipe,
      at,
    ),
    recipeInventory = buildRecipeInventoryProductPublicationReferenceSnapshotV2(
      {
        ...ingredients,
        recipes: [...ingredients.recipes].reverse(),
        versions: [...ingredients.versions].reverse(),
        ingredients: [...ingredients.ingredients].reverse(),
        modifiers: [...ingredients.modifiers].reverse(),
        changes: [...ingredients.changes].reverse(),
      },
      bound.recipeInventory,
      at,
    );
  expect(relevantEvidence(composeImpact({ ...f, recipe, recipeInventory }))).toEqual(
    relevantEvidence(composeImpact(f)),
  );
});
