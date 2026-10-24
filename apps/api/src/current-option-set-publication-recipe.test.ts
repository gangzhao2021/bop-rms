import { beforeEach, expect, it, vi } from "vitest";
import {
  CatalogError,
  evaluateCatalogOptionSetRuleSatisfiability,
  materializeFullOptionSetCreation,
  parseCatalogInstant,
  parseCatalogReference,
  parseCatalogOptionSetEditorContent,
} from "@rms/catalog";
import {
  buildRecipeReferenceSourceSnapshot,
  buildRecipeInventoryReferenceSnapshot,
  assessRecipeOptionConsumptionYields,
  recipeReferenceSourceFields,
  recipeInventoryReferenceFields,
  recipeOptionConsumptionYieldFields,
  type RecipeReferenceSourceOptions,
  type RecipeInventoryReferenceOptions,
  type createPostgresRecipeOptionConsumptionYieldSource,
  type createPostgresRecipeReferenceSourceStore,
  type createPostgresRecipeInventoryReferenceSourceStore,
  parseRecipeOptionConsumptionPins,
  createRecipeSnapshot,
  createRecipeMeasurementContentV2,
  parseRecipeCode,
  parseRecipeReference,
  parseRecipeDigest,
  digestRecipeMeasurementContentV2,
  parseRecipeReferenceSourceRequest,
  currentPublishedRecipeDependencyGraphFields,
  currentPublishedRecipeMeasurementGraphFields,
  type CurrentPublishedRecipeMeasurementGraphOptions,
  type createCurrentPublishedRecipeMeasurementGraphSource,
} from "@rms/recipe";
import {
  parseBusinessAction,
  parsePolicyReference,
  parsePolicyVersion,
  type PermissionDecision,
} from "@bop/permission";
import { parseCanonicalInstant } from "@bop/tenant";
import { readClosedRecord } from "@bop/identity";
import {
  buildInventoryConfigurationReferenceSnapshot,
  buildCurrentRecipeIngredientUnitFacts,
  inventoryConfigurationReferenceFields,
  inventoryConfigurationReferencePermissions,
  inventoryRecipeIngredientUnitFields,
  type InventoryConfigurationReferenceOptions,
  type InventoryRecipeIngredientUnitOptions,
  type createPostgresInventoryConfigurationReferenceSourceStore,
  type createPostgresInventoryRecipeIngredientUnitSource,
} from "@rms/inventory";
import { createMerchantCategoryTransactions } from "./merchant-category-transactions.js";
import { createCurrentOptionSetPublicationRecipeSource } from "./current-option-set-publication-recipe.js";
const owners = vi.hoisted(() => ({
  metadata: vi.fn(),
  inventory: vi.fn(),
  yield: vi.fn(),
  full: vi.fn(),
  item: vi.fn(),
  units: vi.fn(),
}));
vi.mock("@rms/recipe", async (original) => ({
  ...(await original<object>()),
  createPostgresRecipeReferenceSourceStore: owners.metadata,
  createPostgresRecipeInventoryReferenceSourceStore: owners.inventory,
  createPostgresRecipeOptionConsumptionYieldSource: owners.yield,
  createCurrentPublishedRecipeMeasurementGraphSource: owners.full,
}));
vi.mock("@rms/inventory", async (original) => ({
  ...(await original<object>()),
  createPostgresInventoryConfigurationReferenceSourceStore: owners.item,
  createPostgresInventoryRecipeIngredientUnitSource: owners.units,
}));
const id = (n: number) => "01902421-8319-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-10-05T12:00:00.000Z",
  until = "2026-10-05T12:00:05.000Z",
  digest = "sha256:" + "a".repeat(64);
type Options = Parameters<typeof createCurrentOptionSetPublicationRecipeSource>[0];
type Graph = Parameters<
  ReturnType<typeof createCurrentOptionSetPublicationRecipeSource>["withCurrentAssessment"]
>[0]["graph"];
type Packet = Parameters<
  Parameters<
    ReturnType<typeof createCurrentOptionSetPublicationRecipeSource>["withCurrentAssessment"]
  >[1]
>[0];
function required<T>(value: T | undefined): T {
  if (value === undefined) throw Error("fixture missing");
  return value;
}
type YieldOptions = Parameters<typeof createPostgresRecipeOptionConsumptionYieldSource>[0];
function full(n: number, recipe: boolean, child: number | null = null) {
  return materializeFullOptionSetCreation(
    {
      internalCode: "SYNTH_" + n,
      draft: {
        defaultLocale: "en-CA",
        localizedNames: { "en-CA": "Synthetic options" },
        localizedDescriptions: {},
        displayStyle: "MultiChoice",
        minimumSelection: 0,
        maximumSelection: 1,
        allowRepeatedOption: false,
        perOptionMaximumQuantity: 1,
        maximumTotalQuantity: 1,
        options: [
          {
            stableCode: "CHOICE",
            lifecycle: "Draft",
            localizedNames: { "en-CA": "Synthetic choice" },
            localizedDescriptions: {},
            sortOrder: 0,
            defaultEligible: false,
            triggeredOptionSetReference: child === null ? null : id(child),
            conflictOptionCodes: [],
          },
        ],
      },
      additionalContent: {
        profile: "CatalogOptionSetEditorContentV1",
        optionDetails: [
          {
            stableCode: "CHOICE",
            quantityRule: { minimumQuantity: 0, maximumQuantity: 1 },
            media: null,
            pricingRule: null,
            consumption: recipe
              ? {
                  kind: "Recipe",
                  reference: id(50),
                  versionReference: id(51),
                  quantity: "2",
                  unitCode: "PORTION",
                }
              : null,
            triggeredOptionSetVersionReference: child === null ? null : id(child + 100),
          },
        ],
        conditionalRules: [],
        conflictRules: [],
        scopeSet: [{ level: "Brand", reference: null, channelCodes: [], orderTypeCodes: [] }],
        effectivePeriod: {
          timeZone: "UTC",
          effectiveFrom: { instant: at, localDateTime: at.slice(0, 23), utcOffsetMinutes: 0 },
          effectiveUntil: null,
        },
      },
      operationReference: id(n + 5000),
      occurredAt: at,
      reasonCode: "AUTHORIZED_OPERATION",
    },
    {
      brandReference: id(2),
      actorReference: id(4),
      allocations: {
        optionSetReference: id(n),
        versionReference: id(n + 100),
        options: [{ stableCode: "CHOICE", optionReference: id(n + 1000) }],
      },
    },
  ).content;
}
function graph(recipe = true, child = false): Graph {
  const content = full(10, recipe, child ? 20 : null),
    { sourceAggregate, ...additional } = content,
    prepared = parseCatalogOptionSetEditorContent(sourceAggregate, additional),
    graph = {
      brandReference: id(2),
      rootOptionSetReference: id(10),
      rootVersionReference: id(110),
      contents: child ? [content, full(20, true)] : [content],
    },
    assessment = evaluateCatalogOptionSetRuleSatisfiability(graph);
  return {
    profile: "CurrentOptionSetPublicationDraftGraphV1",
    graph,
    sourceRecords: [],
    sourceOperationReference: parseCatalogReference(id(5010)),
    sourceSnapshotTuple: {
      tenantReference: parseCatalogReference(id(1)),
      brandReference: parseCatalogReference(id(2)),
      optionSetReference: sourceAggregate.optionSetReference,
      versionReference: sourceAggregate.draft.versionReference,
      aggregateVersion: sourceAggregate.aggregateVersion,
      sourceDigest: prepared.sourceDigest,
      contentDigest: prepared.contentDigest,
      configurationDigest: prepared.configurationDigest,
    },
    aggregateVersion: sourceAggregate.aggregateVersion,
    sourceDigest: prepared.sourceDigest,
    contentDigest: prepared.contentDigest,
    configurationDigest: prepared.configurationDigest,
    graphDigest: assessment.graphDigest,
    rules: {
      status: assessment.status,
      reason: "reason" in assessment ? assessment.reason : null,
      searchNodes: assessment.searchNodes,
    },
    originalObservedAt: parseCatalogInstant(at),
    observedAt: parseCatalogInstant(at),
    validUntil: parseCatalogInstant(until),
    sourceAuthority: "CurrentDraftRootAndCurrentPublishedChildren",
    referenceEligibility: "NotEvaluated",
    eligibility: "NotEvaluated",
    publishValidation: "Incomplete",
  };
}
function rawMetadata() {
  return {
    generation: "2",
    bindingCount: "0",
    observedAt: at,
    counts: { recipes: "1", versions: "1", bindings: "0", modifiers: "0" },
    recipes: [
      {
        recipeReference: id(50),
        brandReference: id(2),
        aggregateVersion: 2,
        currentVersionReference: id(51),
        updatedAt: at,
        precise: true,
      },
    ],
    versions: [
      {
        recipeVersionReference: id(51),
        recipeReference: id(50),
        brandReference: id(2),
        versionNumber: 1,
        lifecycle: "Published",
        snapshotDigest: digest,
        effectiveFrom: at,
        effectiveUntil: null,
        timeZone: "UTC",
        createdAt: at,
        precise: true,
      },
    ],
    bindings: [],
    modifiers: [],
  };
}
function rawInventory() {
  const metadata = rawMetadata();
  return {
    generation: "2",
    observedAt: at,
    counts: { recipes: "1", versions: "1", ingredients: "1", modifiers: "0", changes: "0" },
    recipes: metadata.recipes,
    versions: metadata.versions,
    ingredients: [
      {
        requirementReference: id(70),
        recipeVersionReference: id(51),
        recipeReference: id(50),
        brandReference: id(2),
        sourceKind: "InventoryItem",
        sourceReference: id(80),
        sourceVersionReference: id(81),
      },
    ],
    modifiers: [],
    changes: [],
  };
}
function measurementContent(quantity = "3000000") {
  const snapshot = createRecipeSnapshot({
    recipeReference: parseRecipeReference(id(50)),
    versionReference: parseRecipeReference(id(51)),
    brandReference: parseRecipeReference(id(2)),
    stableCode: parseRecipeCode("SYNTH_RECIPE"),
    aggregateVersion: 1,
    versionNumber: 1,
    snapshotDigest: parseRecipeDigest(digest),
    lifecycle: "Published",
    displayNameCode: parseRecipeCode("SYNTH_NAME"),
    yieldQuantityMicrounits: "3000000",
    yieldUnitCode: parseRecipeCode("PORTION"),
    yieldDimension: "Count",
    ingredients: [
      {
        requirementReference: parseRecipeReference(id(70)),
        sourceKind: "InventoryItem",
        sourceReference: parseRecipeReference(id(80)),
        sourceVersionReference: parseRecipeReference(id(81)),
        quantityMicrounits: quantity,
        unitDimension: "Mass",
        conversionNumerator: "1",
        conversionDenominator: "1",
        lossBasisPoints: 0,
        unitCostMinorNumerator: "1",
        unitCostDenominator: "1",
        allergens: [],
      },
    ],
    preparationVersionReference: parseRecipeReference(id(90)),
    steps: [
      {
        stepReference: parseRecipeReference(id(91)),
        sequenceGroup: 0,
        instructionCode: parseRecipeCode("MIX"),
        durationSeconds: 1,
        capabilityCode: parseRecipeCode("PREP"),
      },
    ],
    substitutionPolicyReference: null,
    invalidationReasonCode: null,
    createdAt: at,
    effectivePeriod: {
      timeZone: "UTC",
      effectiveFrom: {
        instant: parseCanonicalInstant(at),
        localDateTime: at.slice(0, 23),
        utcOffsetMinutes: 0,
      },
      effectiveUntil: null,
    },
  });
  const value = {
    profile: "RecipeMeasurementContentV2" as const,
    snapshot,
    measurements: [
      {
        requirementReference: snapshot.ingredients[0]?.requirementReference,
        usageUnitCode: "G",
        usageDimension: "Mass",
        targetUnitCode: "G",
        targetDimension: "Mass",
        conversionKind: "InventoryBaseUnitIdentity",
        conversionReference: null,
      },
    ],
  };
  const first = snapshot.ingredients[0];
  if (!first) throw Error("fixture");
  value.measurements[0] = {
    ...required(value.measurements[0]),
    requirementReference: first.requirementReference,
  };
  return createRecipeMeasurementContentV2({
    ...value,
    snapshot: {
      ...snapshot,
      snapshotDigest: parseRecipeDigest(digestRecipeMeasurementContentV2(value)),
    },
  });
}
function harness(configure: (options: Options) => void = () => undefined) {
  // Controlled owner ports plus real public parsers/assessments. This does not
  // establish native Recipe storage/IAM or current Catalog graph acquisition.
  const state = {
    now: at,
    activationAt: "2026-10-05T12:01:00.000Z",
    lease: until,
    allowed: true,
    raw: rawMetadata(),
    ingredientRaw: rawInventory(),
    denyFine: false,
    wrongFields: false,
    wrongTx: false,
    storeOnly: false,
    unit: "PORTION",
    ingredientActive: true,
    ledgerPrecision: 6,
    ingredientQuantity: "3000000",
    fullUnavailable: false,
    fullExpiry: until,
    ingredientPermissionDenied: false,
  };
  const permissions: string[][] = [];
  const txCalls = vi.fn(async () => ({ rows: [], rowCount: 0 }));
  const host = createMerchantCategoryTransactions({
    async run(work) {
      return work({
        async query() {
          await txCalls();
          return { rows: [], rowCount: 0 };
        },
      });
    },
  });
  let actual: Options["transaction"] | undefined;
  const current = {
    authorizeActions: vi.fn(async (actions: readonly string[]) => {
      permissions.push([...actions]);
      if (
        (state.denyFine && actions.includes("recipe.manage")) ||
        (state.ingredientPermissionDenied && actions.includes("inventory.item.read"))
      )
        throw new CatalogError("CATALOG_PERMISSION_DENIED");
      return undefined;
    }),
    assertCurrent() {
      if (!state.allowed) throw new CatalogError("CATALOG_PERMISSION_DENIED");
      return parseCatalogInstant(state.now);
    },
    async authorizeActionsWithDecisions(
      actions: readonly string[],
    ): Promise<readonly PermissionDecision[]> {
      permissions.push([...actions]);
      if (
        (state.denyFine && actions.includes("recipe.manage")) ||
        (state.ingredientPermissionDenied && actions.includes("inventory.item.read"))
      )
        throw new CatalogError("CATALOG_PERMISSION_DENIED");
      return actions.map((action) => ({
        effect: "Allow",
        reason: "EXPLICIT_ALLOW",
        source: "ExplicitAllow",
        action: parseBusinessAction(action),
        scopeKind: state.storeOnly ? "Store" : "Brand",
        policySnapshotReference: parsePolicyReference(id(700)),
        policyVersion: parsePolicyVersion(1),
        audit: { effect: "Allow", reason: "EXPLICIT_ALLOW", source: "ExplicitAllow" },
      }));
    },
    async withCurrentStoreScope() {
      throw Error("controlled Feature fixture");
    },
    leaseDeadline() {
      return state.lease;
    },
  };
  const capability = {
    async holdUntilCommit() {
      return undefined;
    },
    leaseDeadline() {
      return state.lease;
    },
  };
  owners.metadata.mockImplementation(
    (
      options: RecipeReferenceSourceOptions,
    ): ReturnType<typeof createPostgresRecipeReferenceSourceStore> => ({
      async withCurrentSnapshot(request, work) {
        return options.transactions.run(async (tx) => {
          expect(tx).toBe(actual);
          const input = {
            tenantReference: options.tenantReference,
            request,
            permission: "recipe.manage" as const,
            requiredScope: "FullBrandScope" as const,
            requiredFields: recipeReferenceSourceFields,
            observedAt: state.now,
          };
          if (state.wrongFields)
            Object.defineProperty(input, "requiredFields", { value: [], enumerable: true });
          await options.authority.holdUntilTransactionCompletes(tx, input);
          const source = buildRecipeReferenceSourceSnapshot(state.raw, request, state.now);
          return work(source);
        });
      },
    }),
  );
  owners.inventory.mockImplementation(
    (
      options: RecipeInventoryReferenceOptions,
    ): ReturnType<typeof createPostgresRecipeInventoryReferenceSourceStore> => ({
      async withCurrentSnapshot(request, work) {
        return options.transactions.run(async (tx) => {
          expect(tx).toBe(actual);
          await options.authority.holdUntilTransactionCompletes(
            state.wrongTx ? { query: tx.query } : tx,
            {
              tenantReference: options.tenantReference,
              request,
              permission: "recipe.manage",
              requiredScope: "FullBrandScope",
              requiredFields: recipeInventoryReferenceFields,
              observedAt: state.now,
            },
          );
          return work(
            buildRecipeInventoryReferenceSnapshot(state.ingredientRaw, request, state.now),
          );
        });
      },
    }),
  );
  owners.yield.mockImplementation(
    (
      options: YieldOptions,
    ): ReturnType<typeof createPostgresRecipeOptionConsumptionYieldSource> => ({
      async withCurrentYields(request, value, activationAt, work) {
        const pins = parseRecipeOptionConsumptionPins(value);
        return options.transactions.run(async (tx) => {
          expect(tx).toBe(actual);
          const references = [...new Set(pins.map((p) => p.versionReference))].sort();
          await options.yieldAuthority.holdUntilTransactionCompletes(tx, {
            tenantReference: options.tenantReference,
            request,
            permission: "recipe.manage",
            requiredScope: "FullBrandScope",
            requiredFields: recipeOptionConsumptionYieldFields,
            versionReferences: references,
            observedAt: state.now,
          });
          const source = buildRecipeReferenceSourceSnapshot(state.raw, request, state.now);
          const yields = assessRecipeOptionConsumptionYields(
            pins,
            [
              {
                recipeReference: id(50),
                versionReference: id(51),
                versionNumber: "1",
                snapshotDigest: digest,
                yieldQuantityMicrounits: "3000000",
                yieldUnitCode: state.unit,
                yieldDimension: "Count",
                precise: true,
              },
            ],
            source,
            request,
            state.now,
            activationAt,
            options.originalPublicationClock,
          );
          return work({ ...yields, validUntil: until });
        });
      },
    }),
  );
  owners.full.mockImplementation(
    (
      options: CurrentPublishedRecipeMeasurementGraphOptions,
    ): ReturnType<typeof createCurrentPublishedRecipeMeasurementGraphSource> => ({
      async withCurrentGraph(input, work) {
        const r = readClosedRecord(input, [
            "request",
            "observedAt",
            "validUntil",
            "activationAt",
            "recipeVersions",
          ]),
          request = parseRecipeReferenceSourceRequest(r.request);
        return options.transactions.run(async (tx) => {
          if (state.fullUnavailable) throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
          const fields = {
            tenantReference: options.tenantReference,
            request,
            permission: "recipe.manage" as const,
            requiredScope: "FullBrandScope" as const,
            observedAt: state.now,
          };
          await options.authority.holdUntilTransactionCompletes(tx, {
            ...fields,
            requiredFields: currentPublishedRecipeDependencyGraphFields,
          });
          await options.measurementAuthority.holdUntilTransactionCompletes(tx, {
            ...fields,
            requiredFields: currentPublishedRecipeMeasurementGraphFields,
          });
          const content = measurementContent(state.ingredientQuantity);
          const answer = await work({
            profile: "CurrentPublishedRecipeMeasurementGraphV2",
            tenantReference: options.tenantReference,
            request,
            observedAt: at,
            validUntil: state.fullExpiry,
            activationAt: parseCatalogInstant(r.activationAt),
            coreGraphDigest: digest,
            contents: [
              {
                snapshot: content.snapshot,
                content,
                currentRootVersionReference: id(51),
                currentRootAggregateVersion: 1,
                currentRootLifecycle: "Published",
                publicationOperationReference: id(92),
                publicationEvidenceDigest: digest,
              },
            ],
            rootVersionReferences: [id(51)],
            measurementRepresentation: "CompleteV2",
            inventoryReferences: "NotEvaluated",
            unitArithmetic: "NotEvaluated",
            publishValidation: "Incomplete",
            eligibility: "NotEvaluated",
            digest,
          });
          await options.authority.holdUntilTransactionCompletes(tx, {
            ...fields,
            requiredFields: currentPublishedRecipeDependencyGraphFields,
          });
          return answer;
        });
      },
    }),
  );
  const itemMetadata = (
    request: Parameters<typeof buildInventoryConfigurationReferenceSnapshot>[1],
  ) => {
    const scope = { tenantReference: id(1), brandReference: id(2) };
    return buildInventoryConfigurationReferenceSnapshot(
      {
        generation: "1",
        observedAt: state.now,
        counts: { items: "1", versions: "1", operations: "1" },
        items: [
          {
            ...scope,
            itemReference: id(80),
            itemType: "RawMaterial",
            createdAt: at,
            precise: true,
          },
        ],
        versions: [
          {
            ...scope,
            itemReference: id(80),
            itemVersion: "1",
            itemType: "RawMaterial",
            lifecycle: state.ingredientActive ? "Active" : "Inactive",
            recordedAt: at,
            precise: true,
          },
        ],
        operations: [
          {
            ...scope,
            itemReference: id(80),
            itemVersion: "1",
            operationReference: id(81),
            action: "Create",
          },
        ],
      },
      request,
      state.now,
    );
  };
  owners.item.mockImplementation(
    (
      options: InventoryConfigurationReferenceOptions,
    ): ReturnType<typeof createPostgresInventoryConfigurationReferenceSourceStore> => ({
      async withCurrentSnapshot(request, work) {
        return options.transactions.run(async (tx) => {
          await options.authority.holdUntilTransactionCompletes(tx, {
            tenantReference: options.tenantReference,
            request,
            requiredPermissions: inventoryConfigurationReferencePermissions,
            requiredScope: "FullBrandScope",
            requiredFields: inventoryConfigurationReferenceFields,
            observedAt: state.now,
          });
          return work(itemMetadata(request));
        });
      },
    }),
  );
  owners.units.mockImplementation(
    (
      options: InventoryRecipeIngredientUnitOptions,
    ): ReturnType<typeof createPostgresInventoryRecipeIngredientUnitSource> => ({
      async withCurrentUnits(request, pins, work) {
        return options.transactions.run(async (tx) => {
          await options.unitAuthority.holdUntilTransactionCompletes(tx, {
            request,
            requiredPermissions: inventoryConfigurationReferencePermissions,
            requiredScope: "FullBrandScope",
            requiredFields: inventoryRecipeIngredientUnitFields,
            itemReferences: [id(80)],
            observedAt: state.now,
          });
          const facts = buildCurrentRecipeIngredientUnitFacts(
            pins,
            [
              {
                itemReference: id(80),
                itemVersion: "1",
                operationReference: id(81),
                recordedAt: at,
                precise: true,
                baseUnit: {
                  unitCode: "G",
                  dimension: "Mass",
                  ledgerPrecision: state.ledgerPrecision,
                  displayPrecision: 6,
                  roundingMode: "HalfEven",
                },
                unitConversions: [],
              },
            ],
            itemMetadata(request),
            request,
            state.now,
          );
          return work({
            ...facts,
            validUntil: new Date(Date.parse(state.now) + 5000).toISOString(),
          });
        });
      },
    }),
  );
  async function run(
    sourceGraph = graph(),
    work: (
      packet: Packet,
      tx: Options["transaction"],
      options: Options,
    ) => Promise<Packet> = async (packet) => packet,
  ) {
    return host.transactions.run(async (tx) => {
      actual = tx;
      const options: Options = {
        transaction: tx,
        tenantReference: id(1),
        brandReference: id(2),
        storeReference: id(3),
        actorReference: id(4),
        sessionReference: id(5),
        operationReference: id(9),
        clock: { now: () => state.now },
        originalValidUntil: until,
        currentAuthorization: current,
        capability,
        registerBeforeCommit: host.registerBeforeCommit,
        events: { generateReference: () => id(900) },
      };
      const binding = {
        tenantReference: id(1),
        brandReference: id(2),
        optionSetReference: id(10),
        versionReference: id(110),
        expectedAggregateVersion: sourceGraph.aggregateVersion,
        sourceDigest: sourceGraph.sourceDigest,
        contentDigest: sourceGraph.contentDigest,
        configurationDigest: sourceGraph.configurationDigest,
        graphDigest: sourceGraph.graphDigest,
        originalIntentDigest: digest,
        observedAt: at,
        validUntil: until,
        activationAt: state.activationAt,
      };
      configure(options);
      const source = createCurrentOptionSetPublicationRecipeSource(options);
      return source.withCurrentAssessment({ graph: sourceGraph, binding }, async (packet) =>
        work(packet, tx, options),
      );
    });
  }
  return { state, permissions, host, run };
}
beforeEach(() => vi.clearAllMocks());
it("assesses every supplied graph Recipe pin, including unselected child options, under actual captured ports and original operation", async () => {
  const h = harness(),
    packet = await h.run(graph(true, true));
  expect(packet.status).toBe("AssessedReferences");
  expect(packet.nodes).toHaveLength(2);
  for (const node of packet.nodes) {
    expect(node.metadata.decision).toBe("PassForMetadata");
    expect(node.metadata.sourceOperationReference).toBe(id(9));
    expect(node.yields?.yieldArithmetic).toBe("Pass");
    expect(node.yields?.matches[0]).toMatchObject({
      status: "ExactYieldQuantity",
      batchNumerator: "2",
      batchDenominator: "3",
    });
    expect(node.reachable?.requirements[0]).toMatchObject({
      kind: "BaseIngredient",
      reference: { sourceReference: id(80), sourceVersionReference: id(81) },
    });
    expect(node.reachable?.conditionalApplicability).toBe("Unavailable");
    expect(node.reachable?.removalResolution).toBe("Unavailable");
    expect(node.reachable?.conditionalCycleResolution).toBe("Unavailable");
    expect(node.yields?.ingredientEligibility).toBe("NotEvaluated");
  }
  expect(packet.referenceEligibility).toBe("NotEvaluated");
  expect(packet.publishValidation).toBe("Incomplete");
  expect(h.permissions.some((a) => a.includes("recipe.manage"))).toBe(true);
  expect(Object.isFrozen(packet.nodes)).toBe(true);
});
it("returns truthful NoReferences without owner packets or Recipe permission requests", async () => {
  const h = harness(),
    packet = await h.run(graph(false));
  expect(packet.status).toBe("NoReferences");
  expect(packet.nodes).toEqual([]);
  expect(owners.metadata).not.toHaveBeenCalled();
  expect(owners.inventory).not.toHaveBeenCalled();
  expect(owners.yield).not.toHaveBeenCalled();
  expect(h.permissions.every((a) => !a.includes("recipe.manage"))).toBe(true);
});
it("preserves owning negative metadata without fabricating yield or reachability", async () => {
  const h = harness();
  required(h.state.raw.versions[0]).lifecycle = "Draft";
  required(h.state.ingredientRaw.versions[0]).lifecycle = "Draft";
  const packet = await h.run();
  expect(required(packet.nodes[0]).metadata.decision).toBe("HardError");
  expect(required(packet.nodes[0]).yields).toBeNull();
  expect(required(packet.nodes[0]).reachable).toBeNull();
  expect(owners.yield).not.toHaveBeenCalled();
});
it("retains owner unit arithmetic failure and all unfinished qualification fields", async () => {
  const h = harness();
  h.state.unit = "OTHER";
  const packet = await h.run();
  expect(required(packet.nodes[0]).yields?.yieldArithmetic).toBe("HardError");
  expect(required(packet.nodes[0]).yields?.matches[0]?.status).toBe("UnknownYieldUnit");
  expect(packet.ingredientEligibility).toBe("NotEvaluated");
});
it.each(["wrongFields", "wrongTx"] as const)(
  "poisons malformed owning %s rather than trusting source callbacks",
  async (field) => {
    const h = harness();
    h.state[field] = true;
    await expect(h.run()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  },
);
it("preserves actual fine denial without exposing owner errors", async () => {
  const h = harness();
  h.state.denyFine = true;
  await expect(h.run()).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
});
it("rejects substituted graph/source tuple before fetching Recipe facts", async () => {
  const h = harness(),
    original = graph(),
    source = {
      ...original,
      sourceSnapshotTuple: {
        ...original.sourceSnapshotTuple,
        tenantReference: parseCatalogReference(id(99)),
      },
    };
  await expect(h.run(source)).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(owners.metadata).not.toHaveBeenCalled();
});
it("refuses Store-only evidence for full Brand Recipe sources", async () => {
  const h = harness();
  h.state.storeOnly = true;
  await expect(h.run()).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
  expect(owners.metadata).not.toHaveBeenCalled();
});
it("retains an earlier held lease and checks withdrawal at the original host final phase", async () => {
  const h = harness();
  h.state.lease = "2026-10-05T12:00:02.000Z";
  const packet = await h.run();
  expect(packet.validUntil).toBe(h.state.lease);
  const withdrawn = harness();
  await expect(
    withdrawn.run(graph(), async (packet, tx) => {
      await withdrawn.host.registerBeforeCommit(
        tx,
        async () => {
          withdrawn.state.allowed = false;
        },
        () => undefined,
      );
      return packet;
    }),
  ).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
});
it("poisons expiry after async checks and mutated captured authorization ports", async () => {
  const expired = harness();
  await expect(
    expired.run(graph(), async (packet, tx) => {
      await expired.host.registerBeforeCommit(
        tx,
        async () => {
          expired.state.now = until;
        },
        () => undefined,
      );
      return packet;
    }),
  ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  const changed = harness();
  await expect(
    changed.run(graph(), async (packet, _tx, options) => {
      void _tx;
      options.currentAuthorization.authorizeActionsWithDecisions = async () => [];
      return packet;
    }),
  ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
});
it("sanitizes owning failures and never falls back to invented empty references", async () => {
  const h = harness();
  owners.inventory.mockImplementationOnce(() => {
    throw Error("private Recipe SQL details");
  });
  await expect(h.run()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
});
it("accepts an original graph held before source construction without renewing its deadline", async () => {
  const h = harness();
  h.state.now = "2026-10-05T12:00:01.000Z";
  h.state.raw.observedAt = h.state.now;
  h.state.ingredientRaw.observedAt = h.state.now;
  const packet = await h.run();
  expect(packet.validUntil).toBe(until);
  expect(packet.binding.observedAt).toBe(at);
});

it("retains immediate activation while real Recipe reads advance inside the original lease", async () => {
  const h = harness();
  h.state.now = "2026-10-05T12:00:01.000Z";
  h.state.activationAt = at;
  h.state.raw.observedAt = h.state.now;
  h.state.ingredientRaw.observedAt = h.state.now;
  const packet = await h.run();
  expect(packet.binding.activationAt).toBe(at);
  expect(packet.validUntil).toBe(until);
  expect(packet.nodes[0]?.yields?.activationAt).toBe(at);
  expect(packet.nodes[0]?.yields?.assessedAt).toBe(h.state.now);
  expect(packet.nodes[0]?.yields?.yieldArithmetic).toBe("Pass");
});

it("qualifies actual standalone Recipe ingredients and scaled demand without promoting sale eligibility", async () => {
  const h = harness(),
    packet = await h.run();
  expect(packet.standaloneReferenceAssessment.decision).toBe("Pass");
  expect(packet.standaloneReferenceAssessment.checks).toContainEqual(
    expect.objectContaining({ code: "RecipeScaledDemandPrecision", outcome: "Pass" }),
  );
  expect(packet.standaloneReferenceAssessment.checks).toContainEqual(
    expect.objectContaining({
      code: "ProductBindingAndSaleApplicability",
      outcome: "NotApplicableForIndependentSet",
    }),
  );
  expect(packet.eligibility).toBe("NotEvaluated");
});
it("refuses inactive actual ingredients before calling units", async () => {
  const h = harness();
  h.state.ingredientActive = false;
  const packet = await h.run();
  expect(packet.standaloneReferenceAssessment.decision).toBe("HardError");
  expect(packet.standaloneReferenceAssessment.checks).toContainEqual(
    expect.objectContaining({ reasonCode: "InventoryConfigurationInactive" }),
  );
  expect(owners.units).not.toHaveBeenCalled();
});
it("requires actual fine Inventory permission and refuses unavailable complete Recipe source", async () => {
  const h = harness();
  h.state.ingredientPermissionDenied = true;
  await expect(h.run()).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
  const missing = harness();
  missing.state.fullUnavailable = true;
  await expect(missing.run()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
});
it("caps the original host by actual referenced Recipe expiry through final guard", async () => {
  const h = harness();
  h.state.fullExpiry = "2026-10-05T12:00:00.500Z";
  await expect(
    h.run(graph(), async (packet) => {
      expect(packet.validUntil).toBe(h.state.fullExpiry);
      h.state.now = h.state.fullExpiry;
      return packet;
    }),
  ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
});

it("rejects the actual scaled Option demand when its base quantity needs rounding", async () => {
  const h = harness();
  h.state.ingredientQuantity = "1000000";
  h.state.ledgerPrecision = 0;
  const packet = await h.run();
  expect(packet.standaloneReferenceAssessment.decision).toBe("HardError");
  expect(packet.standaloneReferenceAssessment.checks).toContainEqual(
    expect.objectContaining({
      code: "RecipeScaledDemandPrecision",
      reasonCode: "RoundingRequired",
    }),
  );
});

// Controlled complete Permission owner packets exercise composition, not native IAM.
function combinedDecisionPacket(actions: readonly string[], sequence: number) {
  return Object.freeze(
    actions.map((action) =>
      Object.freeze({
        effect: "Allow" as const,
        reason: "ROLE_PERMISSION" as const,
        source: "RolePermission" as const,
        action: parseBusinessAction(action),
        scopeKind: "Brand" as const,
        policySnapshotReference: parsePolicyReference(id(2000 + sequence)),
        policyVersion: parsePolicyVersion(sequence),
        audit: Object.freeze({
          effect: "Allow" as const,
          reason: "ROLE_PERMISSION" as const,
          source: "RolePermission" as const,
        }),
      }),
    ),
  );
}

it("uses a fresh complete combined packet at every checkpoint without duplicate standalone admission", async () => {
  let sequence = 0;
  const standalone = vi.fn(async () => {
    throw Error("duplicate standalone admission");
  });
  const batches: string[][] = [];
  const snapshots: string[] = [];
  const f = harness((options: Options) => {
    options.capability.holdUntilCommit = standalone;
    options.currentAuthorization.authorizeActionsWithDecisions = standalone;
    options.capability.holdUntilCommitWithDecisions = async (actions) => {
      expect(actions).toContain("catalog.manage");
      const packet = combinedDecisionPacket(actions, ++sequence);
      snapshots.push(String(packet[0]?.policySnapshotReference));
      batches.push([...actions]);
      return packet;
    };
  });
  await f.run(graph(true, true));
  expect(standalone).not.toHaveBeenCalled();
  expect(sequence).toBeGreaterThan(1);
  expect(new Set(snapshots).size).toBe(sequence);
  expect(batches.flat()).toContain("catalog.option_set.read");
});
it("rechecks combined current permission at the original final checkpoint", async () => {
  let sequence = 0,
    withdraw = false;
  const f = harness((options) => {
    options.capability.holdUntilCommitWithDecisions = async (actions) => {
      if (withdraw) throw new CatalogError("CATALOG_PERMISSION_DENIED");
      return combinedDecisionPacket(actions, ++sequence);
    };
  });
  await expect(
    f.run(graph(), async (packet) => {
      withdraw = true;
      return packet;
    }),
  ).rejects.toThrow();
});
for (const malformed of [
  "missingAudit",
  "auditMismatch",
  "sparse",
  "accessor",
  "denied",
  "wrongAction",
  "badSnapshot",
  "extraField",
] as const)
  it("rejects malformed combined full evidence: " + malformed, async () => {
    const readAccessor = vi.fn();
    const f = harness((options) => {
      options.capability.holdUntilCommitWithDecisions = async (actions) => {
        const packet = combinedDecisionPacket(actions, 1).map((row) => ({ ...row }));
        const first = packet[0];
        if (!first) throw Error("controlled empty actions");
        if (malformed === "missingAudit") Reflect.deleteProperty(first, "audit");
        if (malformed === "auditMismatch")
          Object.defineProperty(first, "audit", {
            value: { effect: "Deny", reason: "ROLE_PERMISSION", source: "RolePermission" },
            enumerable: true,
          });
        if (malformed === "sparse") Reflect.deleteProperty(packet, "0");
        if (malformed === "accessor")
          Object.defineProperty(packet, "0", {
            get() {
              readAccessor();
              return first;
            },
            enumerable: true,
          });
        if (malformed === "denied")
          Object.defineProperty(first, "effect", { value: "Deny", enumerable: true });
        if (malformed === "wrongAction")
          Object.defineProperty(first, "action", { value: "media.asset.access", enumerable: true });
        if (malformed === "badSnapshot")
          Object.defineProperty(first, "policySnapshotReference", {
            value: "bad",
            enumerable: true,
          });
        if (malformed === "extraField")
          Object.defineProperty(first, "unowned", { value: true, enumerable: true });
        return packet;
      };
    });
    await expect(f.run(graph(true, true))).rejects.toThrow();
    expect(readAccessor).not.toHaveBeenCalled();
  });
it("rejects combined port drift rather than falling back during final admission", async () => {
  const f = harness((options) => {
    options.capability.holdUntilCommitWithDecisions = async (actions) =>
      combinedDecisionPacket(actions, 1);
  });
  await expect(
    f.run(graph(), async (packet, _tx, options) => {
      void _tx;
      options.capability.holdUntilCommitWithDecisions = async () => [];
      return packet;
    }),
  ).rejects.toThrow();
});
it("rejects a present non-function combined port before legacy fallback", async () => {
  const f = harness((options) => {
    Object.defineProperty(options.capability, "holdUntilCommitWithDecisions", {
      value: 42,
      enumerable: true,
    });
  });
  await expect(f.run(graph(true, true))).rejects.toThrow();
});

it("rejects an absent-to-present combined port change after legacy admission", async () => {
  const f = harness();
  await expect(
    f.run(graph(), async (packet, _tx, options) => {
      void _tx;
      options.capability.holdUntilCommitWithDecisions = async (actions) =>
        combinedDecisionPacket(actions, 1);
      return packet;
    }),
  ).rejects.toThrow();
});
it("tightens combined actual Feature lease without renewing the original window", async () => {
  const short = "2026-10-05T12:00:01.000Z";
  const f = harness((options) => {
    options.capability.leaseDeadline = () => short;
    options.capability.holdUntilCommitWithDecisions = async (actions) =>
      combinedDecisionPacket(actions, 1);
  });
  const packet = await f.run(graph());
  expect(packet.validUntil).toBe(short);
});
