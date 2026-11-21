import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  CatalogError,
  copyCategoryPersistenceValue,
  parseCatalogInstant,
  parseCatalogReference,
  parseCatalogOptionSetContentPolicyBinding,
  parseCatalogOptionSetEditorContent,
  evaluateCatalogOptionSetRuleSatisfiability,
} from "@rms/catalog";
import {
  createPostgresRecipeReferenceSourceStore,
  createPostgresRecipeOptionConsumptionYieldSource,
  createPostgresRecipeInventoryReferenceSourceStore,
  matchOptionDraftRecipeConsumptionMetadata,
  matchRecipeInventoryReferenceRoots,
  parseRecipeReferenceSourceRequest,
  parseRecipeInventoryReferenceRequest,
  parseRecipeOptionConsumptionPins,
  recipeReferenceSourceFields,
  recipeOptionConsumptionYieldFields,
  recipeInventoryReferenceFields,
  createCurrentPublishedRecipeMeasurementGraphSource,
  currentPublishedRecipeDependencyGraphFields,
  currentPublishedRecipeMeasurementGraphFields,
  calculateRecipeMeasurementDemand,
  type CurrentPublishedRecipeMeasurementGraphOptions,
  type RecipeReferenceSourceOptions,
  type RecipeInventoryReferenceOptions,
} from "@rms/recipe";
import { readClosedRecord } from "@bop/identity";
import {
  createPostgresInventoryConfigurationReferenceSourceStore,
  createPostgresInventoryRecipeIngredientUnitSource,
  assessCurrentRecipeIngredientInventoryReferences,
  assessRecipeIngredientUnits,
  assessRecipeBaseDemands,
  parseInventoryConfigurationReferenceRequest,
  inventoryConfigurationReferenceFields,
  inventoryConfigurationReferencePermissions,
  inventoryRecipeIngredientUnitFields,
  type InventoryConfigurationReferenceOptions,
} from "@rms/inventory";
import {
  parseBusinessAction,
  parsePolicyReference,
  parsePolicyVersion,
  type PermissionDecision,
} from "@bop/permission";
import type { createCurrentOptionSetPublicationDraftGraphSource } from "./current-option-set-publication-draft-graph.js";
import type { CurrentPublishedOptionSetGraphOptions } from "./current-published-option-set-graph.js";
import { MerchantProductWriteFeatureDisabled } from "./merchant-product-write-authority.js";

type Binding = ReturnType<typeof parseCatalogOptionSetContentPolicyBinding>;
type GraphSource = Parameters<
  Parameters<
    ReturnType<typeof createCurrentOptionSetPublicationDraftGraphSource>["withCurrentGraph"]
  >[1]
>[0];
type Metadata = ReturnType<typeof matchOptionDraftRecipeConsumptionMetadata>;
type YieldSource = Parameters<
  Parameters<
    ReturnType<typeof createPostgresRecipeOptionConsumptionYieldSource>["withCurrentYields"]
  >[3]
>[0];
type Reachable = ReturnType<typeof matchRecipeInventoryReferenceRoots>;
interface StandaloneCheck {
  readonly code: string;
  readonly outcome: "Pass" | "HardError" | "Indeterminate" | "NotApplicableForIndependentSet";
  readonly optionSetReference: string | null;
  readonly optionReference: string | null;
  readonly reference: string | null;
  readonly reasonCode: string | null;
}
interface StandaloneReferenceAssessment {
  readonly phase: "OptionSetPublication";
  readonly decision: "Pass" | "HardError" | "Indeterminate";
  readonly checks: readonly StandaloneCheck[];
}
interface Node {
  readonly optionSetReference: string;
  readonly versionReference: string;
  readonly metadata: Metadata;
  readonly yields: YieldSource | null;
  readonly reachable: Reachable[number] | null;
}
export interface CurrentOptionSetPublicationRecipeOptions extends CurrentPublishedOptionSetGraphOptions {
  readonly operationReference: string;
}
const equal = (a: unknown, b: unknown) => canonicalizeRfc8785(a) === canonicalizeRfc8785(b);
function immutable<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value;
}
function prepared(value: unknown) {
  const r = readClosedRecord(copyCategoryPersistenceValue(value), [
    "profile",
    "sourceAggregate",
    "optionDetails",
    "conditionalRules",
    "conflictRules",
    "scopeSet",
    "effectivePeriod",
  ]);
  const { sourceAggregate, ...additional } = r;
  return parseCatalogOptionSetEditorContent(sourceAggregate, additional);
}

/** Supplied server-held full graph bound to the original tuple, with actual held
 * Recipe metadata/yields/reachable references. Graph consistency is not fresh
 * Catalog authority: the ordinary assembler acquires the genuine producer once. All
 * graph Options are examined, including unselected and conditional choices.
 * Existing owners deliberately leave ingredient eligibility, conditional
 * applicability, removals/cycles, quantity policy and scope qualification open. */
export function createCurrentOptionSetPublicationRecipeSource(
  options: CurrentOptionSetPublicationRecipeOptions,
) {
  const tx = options.transaction,
    query = tx?.query,
    tenant = parseCatalogReference(options.tenantReference),
    brand = parseCatalogReference(options.brandReference),
    store = parseCatalogReference(options.storeReference),
    actor = parseCatalogReference(options.actorReference),
    session = parseCatalogReference(options.sessionReference),
    operation = parseCatalogReference(options.operationReference);
  if (
    typeof query !== "function" ||
    typeof options.clock?.now !== "function" ||
    typeof options.currentAuthorization?.authorizeActions !== "function" ||
    typeof options.currentAuthorization?.authorizeActionsWithDecisions !== "function" ||
    typeof options.currentAuthorization?.assertCurrent !== "function" ||
    typeof options.currentAuthorization?.leaseDeadline !== "function" ||
    typeof options.capability?.holdUntilCommit !== "function" ||
    (options.capability.holdUntilCommitWithDecisions !== undefined &&
      typeof options.capability.holdUntilCommitWithDecisions !== "function") ||
    typeof options.capability?.leaseDeadline !== "function" ||
    typeof options.registerBeforeCommit !== "function" ||
    typeof options.events?.generateReference !== "function"
  )
    throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
  const clockPort = options.clock.now,
    clock = clockPort.bind(options.clock),
    authorizePort = options.currentAuthorization.authorizeActions,
    decisionPort = options.currentAuthorization.authorizeActionsWithDecisions,
    authorizeDecisions = decisionPort.bind(options.currentAuthorization),
    assertPort = options.currentAuthorization.assertCurrent,
    assertCurrent = assertPort.bind(options.currentAuthorization),
    leasePort = options.currentAuthorization.leaseDeadline,
    lease = leasePort.bind(options.currentAuthorization),
    combinedPort = options.capability.holdUntilCommitWithDecisions,
    combined =
      typeof combinedPort === "function" ? combinedPort.bind(options.capability) : undefined,
    capabilityPort = options.capability.holdUntilCommit,
    capability = capabilityPort.bind(options.capability),
    capabilityLeasePort = options.capability.leaseDeadline,
    capabilityLease = capabilityLeasePort.bind(options.capability),
    registerPort = options.registerBeforeCommit,
    register = registerPort.bind(options),
    eventPort = options.events.generateReference;
  const startedAt = parseCatalogInstant(clock()),
    originalDeadline = parseCatalogInstant(options.originalValidUntil);
  if (originalDeadline <= startedAt || Date.parse(originalDeadline) - Date.parse(startedAt) > 5000)
    throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
  let latest = startedAt,
    deadline = originalDeadline,
    failed = false,
    active = false,
    entered = false,
    ready = false,
    guardCalls = 0,
    guardComplete = false,
    finalCalls = 0;
  let binding: Binding | undefined,
    permissionDecisions: readonly PermissionDecision[] = [];
  const poison = (): never => {
    failed = true;
    throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
  };
  const reject = (error: unknown): never => {
    failed = true;
    if (error instanceof CatalogError || error instanceof MerchantProductWriteFeatureDisabled)
      throw error;
    return poison();
  };
  const check = () => {
    try {
      const at = parseCatalogInstant(clock());
      if (
        failed ||
        tx.query !== query ||
        options.transaction !== tx ||
        at < latest ||
        at >= deadline ||
        options.clock.now !== clockPort ||
        options.currentAuthorization.authorizeActions !== authorizePort ||
        options.currentAuthorization.authorizeActionsWithDecisions !== decisionPort ||
        options.currentAuthorization.assertCurrent !== assertPort ||
        options.currentAuthorization.leaseDeadline !== leasePort ||
        options.capability.holdUntilCommit !== capabilityPort ||
        options.capability.holdUntilCommitWithDecisions !== combinedPort ||
        options.capability.leaseDeadline !== capabilityLeasePort ||
        options.registerBeforeCommit !== registerPort ||
        options.events.generateReference !== eventPort ||
        options.originalValidUntil !== originalDeadline ||
        options.operationReference !== operation ||
        options.tenantReference !== tenant ||
        options.brandReference !== brand ||
        options.storeReference !== store ||
        options.actorReference !== actor ||
        options.sessionReference !== session
      )
        return poison();
      assertCurrent();
      latest = at;
      return at;
    } catch (error) {
      return reject(error);
    }
  };
  const tighten = (until?: string) => {
    for (const value of [lease(), capabilityLease(), ...(until === undefined ? [] : [until])]) {
      const parsed = parseCatalogInstant(value);
      if (parsed < deadline) deadline = parsed;
    }
    return check();
  };
  let hasInventoryReferences = false;
  const hold = async (recipe: boolean) => {
    check();
    const actions = Object.freeze(
      recipe
        ? [
            "catalog.manage",
            "catalog.option_set.read",
            "recipe.manage",
            ...(hasInventoryReferences
              ? ["inventory.item.read", "inventory.item.history.read"]
              : []),
          ]
        : ["catalog.manage", "catalog.option_set.read"],
    );
    let decisions;
    if (combined) decisions = await combined(actions);
    else {
      if ((await capability()) !== undefined) return poison();
      check();
      decisions = await authorizeDecisions(actions);
    }
    check();
    if (
      !Array.isArray(decisions) ||
      Object.getPrototypeOf(decisions) !== Array.prototype ||
      decisions.length !== actions.length
    )
      return poison();
    const descriptors = Object.getOwnPropertyDescriptors(decisions);
    if (
      Reflect.ownKeys(decisions).length !== actions.length + 1 ||
      actions.some((_, i) => {
        const d = descriptors[String(i)];
        return !d || !d.enumerable || !("value" in d);
      })
    )
      return poison();
    permissionDecisions = Object.freeze(
      decisions.map((decision, index) => {
        const row = readClosedRecord(decision, [
            "effect",
            "reason",
            "source",
            "action",
            "scopeKind",
            "policySnapshotReference",
            "policyVersion",
            "audit",
          ]),
          audit = readClosedRecord(row.audit, ["effect", "reason", "source"]);
        if (row.effect !== "Allow" || row.scopeKind !== "Brand")
          throw new CatalogError("CATALOG_PERMISSION_DENIED");
        if (
          row.action !== actions[index] ||
          (row.reason !== "EXPLICIT_ALLOW" && row.reason !== "ROLE_PERMISSION") ||
          (row.source !== "ExplicitAllow" && row.source !== "RolePermission") ||
          (row.reason === "EXPLICIT_ALLOW") !== (row.source === "ExplicitAllow") ||
          audit.effect !== row.effect ||
          audit.reason !== row.reason ||
          audit.source !== row.source
        )
          return poison();
        return Object.freeze({
          effect: "Allow" as const,
          reason: row.reason,
          source: row.source,
          action: parseBusinessAction(row.action),
          scopeKind: "Brand" as const,
          policySnapshotReference: parsePolicyReference(row.policySnapshotReference),
          policyVersion: parsePolicyVersion(row.policyVersion),
          audit: Object.freeze({
            effect: "Allow" as const,
            reason: row.reason,
            source: row.source,
          }),
        });
      }),
    );
    return tighten();
  };
  const validateGraph = (source: GraphSource, original: Binding) => {
    const root = source.graph.contents
        .map(prepared)
        .find((n) => n.content.sourceAggregate.optionSetReference === original.optionSetReference),
      rules = evaluateCatalogOptionSetRuleSatisfiability(source.graph);
    if (
      source.profile !== "CurrentOptionSetPublicationDraftGraphV1" ||
      source.sourceAuthority !== "CurrentDraftRootAndCurrentPublishedChildren" ||
      source.referenceEligibility !== "NotEvaluated" ||
      source.eligibility !== "NotEvaluated" ||
      source.publishValidation !== "Incomplete" ||
      source.graph.contents.length < 1 ||
      source.graph.contents.length > 32 ||
      !root ||
      source.graph.brandReference !== brand ||
      source.graph.rootOptionSetReference !== original.optionSetReference ||
      source.graph.rootVersionReference !== original.versionReference ||
      source.aggregateVersion !== original.expectedAggregateVersion ||
      source.sourceDigest !== original.sourceDigest ||
      source.contentDigest !== original.contentDigest ||
      source.configurationDigest !== original.configurationDigest ||
      source.graphDigest !== original.graphDigest ||
      rules.graphDigest !== original.graphDigest ||
      root.content.sourceAggregate.draft.versionReference !== original.versionReference ||
      root.content.sourceAggregate.aggregateVersion !== original.expectedAggregateVersion ||
      root.sourceDigest !== original.sourceDigest ||
      root.contentDigest !== original.contentDigest ||
      root.configurationDigest !== original.configurationDigest ||
      source.sourceSnapshotTuple.tenantReference !== tenant ||
      source.sourceSnapshotTuple.brandReference !== brand ||
      source.sourceSnapshotTuple.optionSetReference !== original.optionSetReference ||
      source.sourceSnapshotTuple.versionReference !== original.versionReference ||
      source.sourceSnapshotTuple.aggregateVersion !== original.expectedAggregateVersion ||
      source.sourceSnapshotTuple.sourceDigest !== original.sourceDigest ||
      source.sourceSnapshotTuple.contentDigest !== original.contentDigest ||
      source.sourceSnapshotTuple.configurationDigest !== original.configurationDigest ||
      Date.parse(source.originalObservedAt) < Date.parse(originalDeadline) - 5000 ||
      parseCatalogInstant(source.observedAt) > check() ||
      parseCatalogInstant(source.observedAt) < parseCatalogInstant(source.originalObservedAt) ||
      parseCatalogInstant(source.validUntil) > originalDeadline ||
      parseCatalogInstant(source.validUntil) <= parseCatalogInstant(source.observedAt)
    )
      return poison();
    parseCatalogReference(source.sourceOperationReference);
    tighten(source.validUntil);
  };
  return Object.freeze({
    async withCurrentAssessment<T>(
      input: { readonly graph: GraphSource; readonly binding: unknown },
      work: (source: {
        readonly profile: "CurrentOptionSetPublicationRecipeV1";
        readonly context: {
          readonly tenantReference: string;
          readonly brandReference: string;
          readonly storeReference: string;
          readonly actorReference: string;
          readonly sessionReference: string;
        };
        readonly operationReference: string;
        readonly binding: Binding;
        readonly graph: GraphSource;
        readonly coverage: "AllGraphRecipePins";
        readonly status: "NoReferences" | "AssessedReferences";
        readonly nodes: readonly Node[];
        readonly standaloneReferenceAssessment: StandaloneReferenceAssessment;
        readonly permissionDecisions: readonly PermissionDecision[];
        readonly observedAt: string;
        readonly validUntil: string;
        readonly ingredientEligibility: "NotEvaluated";
        readonly referenceEligibility: "NotEvaluated";
        readonly eligibility: "NotEvaluated";
        readonly publishValidation: "Incomplete";
      }) => Promise<T>,
    ): Promise<T> {
      if (entered || active) return poison();
      entered = true;
      active = true;
      let hasReferences = false;
      try {
        if (
          (await register(
            tx,
            async () => {
              if (!ready || active || ++guardCalls !== 1) return poison();
              active = true;
              try {
                await hold(hasReferences);
                check();
                guardComplete = true;
              } catch (error) {
                return reject(error);
              } finally {
                active = false;
              }
            },
            () => {
              if (!ready || active || !guardComplete || guardCalls !== 1 || ++finalCalls !== 1)
                return poison();
              tighten();
            },
          )) !== undefined
        )
          return poison();
        readClosedRecord(input, ["graph", "binding"]);
        binding = parseCatalogOptionSetContentPolicyBinding(input.binding);
        const original = binding;
        const originalPublicationClock = Object.freeze({
          profile: "OptionPublicationOriginalClockV1" as const,
          operationReference: operation,
          catalogIntentDigest: original.originalIntentDigest,
          observedAt: original.observedAt,
          validUntil: original.validUntil,
        });
        if (
          original.tenantReference !== tenant ||
          original.brandReference !== brand ||
          Date.parse(original.observedAt) < Date.parse(originalDeadline) - 5000 ||
          original.observedAt > check() ||
          original.validUntil > originalDeadline ||
          typeof work !== "function"
        )
          return poison();
        tighten(original.validUntil);
        const graph = input.graph;
        const result = await (async () => {
          validateGraph(graph, original);
          const candidates = graph.graph.contents
            .map(prepared)
            .map((node) => {
              if (node.content.sourceAggregate.brandReference !== brand) return poison();
              const pins = parseRecipeOptionConsumptionPins(
                node.content.optionDetails.flatMap((detail) =>
                  detail.consumption?.kind === "Recipe"
                    ? [
                        {
                          optionReference: detail.optionReference,
                          reference: detail.consumption.reference,
                          versionReference: detail.consumption.versionReference,
                          quantity: detail.consumption.quantity,
                          unitCode: detail.consumption.unitCode,
                        },
                      ]
                    : [],
                ),
              );
              return { node, pins };
            })
            .filter((node) => node.pins.length !== 0);
          hasReferences = candidates.length !== 0;
          await hold(hasReferences);
          const nodes: Node[] = [];
          if (hasReferences) {
            const request = parseRecipeReferenceSourceRequest({
                purposeCode: "CATALOG_LIFECYCLE_RECIPE_SOURCE_READ",
                brandReference: brand,
                actorReference: actor,
                operationReference: operation,
                catalogIntentDigest: original.originalIntentDigest,
              }),
              inventoryRequest = parseRecipeInventoryReferenceRequest({
                purposeCode: "CATALOG_LIFECYCLE_INVENTORY_RECIPE_SOURCE_READ",
                brandReference: brand,
                actorReference: actor,
                operationReference: operation,
                catalogIntentDigest: original.originalIntentDigest,
              });
            const transactions: RecipeReferenceSourceOptions["transactions"] = {
              async run(action) {
                check();
                const answer = await action(tx);
                check();
                return answer;
              },
            };
            const common = {
              tenantReference: tenant,
              brandReference: brand,
              actorReference: actor,
              transactions,
              clock: { now: check },
            };
            const authority: RecipeReferenceSourceOptions["authority"] = {
              async holdUntilTransactionCompletes(actual, input) {
                if (
                  actual !== tx ||
                  !equal(input.request, request) ||
                  input.tenantReference !== tenant ||
                  input.permission !== "recipe.manage" ||
                  input.requiredScope !== "FullBrandScope" ||
                  !equal(input.requiredFields, recipeReferenceSourceFields) ||
                  parseCatalogInstant(input.observedAt) < startedAt ||
                  parseCatalogInstant(input.observedAt) > check()
                )
                  return poison();
                await hold(true);
              },
            };
            const ingredientAuthority: RecipeInventoryReferenceOptions["authority"] = {
              async holdUntilTransactionCompletes(actual, input) {
                if (
                  actual !== tx ||
                  !equal(input.request, inventoryRequest) ||
                  input.tenantReference !== tenant ||
                  input.permission !== "recipe.manage" ||
                  input.requiredScope !== "FullBrandScope" ||
                  !equal(input.requiredFields, recipeInventoryReferenceFields) ||
                  parseCatalogInstant(input.observedAt) < startedAt ||
                  parseCatalogInstant(input.observedAt) > check()
                )
                  return poison();
                await hold(true);
              },
            };
            await createPostgresRecipeReferenceSourceStore({
              ...common,
              authority,
            }).withCurrentSnapshot(request, async (metadata) => {
              if (
                !equal(metadata.request, request) ||
                parseCatalogInstant(metadata.observedAt) < startedAt ||
                parseCatalogInstant(metadata.observedAt) > check()
              )
                return poison();
              const inventoryOwner = createPostgresRecipeInventoryReferenceSourceStore({
                ...common,
                authority: ingredientAuthority,
              });
              await inventoryOwner.withCurrentSnapshot(inventoryRequest, async (inventory) => {
                if (
                  !equal(inventory.request, inventoryRequest) ||
                  inventory.generation !== metadata.generation ||
                  !equal(inventory.recipes, metadata.recipes) ||
                  !equal(inventory.versions, metadata.versions) ||
                  parseCatalogInstant(inventory.observedAt) < startedAt ||
                  parseCatalogInstant(inventory.observedAt) > check()
                )
                  return poison();
                for (const { node, pins } of candidates) {
                  const { sourceAggregate } = node.content;
                  const assessed = matchOptionDraftRecipeConsumptionMetadata(
                    {
                      profile: "CurrentFullOptionDraftConsumptionPinsV1",
                      brandReference: brand,
                      optionSetReference: sourceAggregate.optionSetReference,
                      versionReference: sourceAggregate.draft.versionReference,
                      sourceDigest: node.sourceDigest,
                      contentDigest: node.contentDigest,
                      configurationDigest: node.configurationDigest,
                      pins: pins.map(({ optionReference, reference, versionReference }) => ({
                        optionReference,
                        reference,
                        versionReference,
                      })),
                    },
                    metadata,
                    request,
                    check(),
                    original.activationAt,
                    originalPublicationClock,
                  );
                  if (assessed.decision === "HardError") {
                    // Owning negative metadata is a business assessment, not a
                    // fabricated yield/reachability packet or a source outage.
                    nodes.push(
                      immutable({
                        optionSetReference: String(sourceAggregate.optionSetReference),
                        versionReference: String(sourceAggregate.draft.versionReference),
                        metadata: assessed,
                        yields: null,
                        reachable: null,
                      }),
                    );
                    continue;
                  }
                  const versions = Object.freeze(
                    [...new Set(pins.map((p) => p.versionReference))].sort(),
                  );
                  const reachable = matchRecipeInventoryReferenceRoots({
                    request: inventoryRequest,
                    rootGroups: [versions],
                    source: inventory,
                    now: check(),
                  });
                  const reach = reachable[0];
                  if (!reach || reachable.length !== 1) return poison();
                  const owner = createPostgresRecipeOptionConsumptionYieldSource({
                    originalPublicationClock,
                    ...common,
                    authority,
                    yieldAuthority: {
                      async holdUntilTransactionCompletes(actual, input) {
                        if (
                          actual !== tx ||
                          !equal(input.request, request) ||
                          input.tenantReference !== tenant ||
                          input.permission !== "recipe.manage" ||
                          input.requiredScope !== "FullBrandScope" ||
                          !equal(input.requiredFields, recipeOptionConsumptionYieldFields) ||
                          !equal(input.versionReferences, versions) ||
                          parseCatalogInstant(input.observedAt) < startedAt ||
                          parseCatalogInstant(input.observedAt) > check()
                        )
                          return poison();
                        await hold(true);
                      },
                    },
                  });
                  await owner.withCurrentYields(
                    request,
                    pins,
                    original.activationAt,
                    async (yields) => {
                      if (
                        yields.brandReference !== brand ||
                        yields.operationReference !== operation ||
                        yields.catalogIntentDigest !== original.originalIntentDigest ||
                        yields.ownerSourceDigest !== metadata.digest ||
                        yields.ownerGeneration !== metadata.generation ||
                        yields.activationAt !== original.activationAt ||
                        yields.matches.length !== pins.length ||
                        !equal(
                          yields.matches.map((p) => p.optionReference),
                          pins.map((p) => p.optionReference),
                        )
                      )
                        return poison();
                      tighten(yields.validUntil);
                      nodes.push(
                        immutable({
                          optionSetReference: String(sourceAggregate.optionSetReference),
                          versionReference: String(sourceAggregate.draft.versionReference),
                          metadata: assessed,
                          yields,
                          reachable: reach,
                        }),
                      );
                    },
                  );
                }
              });
            });
          }
          const checks: StandaloneCheck[] = [];
          const add = (
            code: string,
            outcome: StandaloneCheck["outcome"],
            set: string | null,
            option: string | null,
            reference: string | null,
            reasonCode: string | null,
          ) => {
            checks.push(
              Object.freeze({
                code,
                outcome,
                optionSetReference: set,
                optionReference: option,
                reference,
                reasonCode,
              }),
            );
          };
          for (const { node, pins } of candidates) {
            const set = String(node.content.sourceAggregate.optionSetReference),
              held = nodes.find((n) => n.optionSetReference === set);
            if (!held) return poison();
            for (const pin of pins) {
              const match = held.metadata.matches.find(
                (m) => m.optionReference === pin.optionReference,
              );
              if (!match) return poison();
              add(
                "RecipeCurrentPublishedPin",
                match.status === "CurrentPublishedMetadata" ? "Pass" : "HardError",
                set,
                pin.optionReference,
                pin.reference,
                match.status === "CurrentPublishedMetadata" ? null : match.status,
              );
              if (match.status !== "CurrentPublishedMetadata") continue;
              const yieldMatch = held.yields?.matches.find(
                (m) => m.optionReference === pin.optionReference,
              );
              if (!yieldMatch) return poison();
              add(
                "RecipeRequestedYield",
                yieldMatch.status === "ExactYieldQuantity" ? "Pass" : "HardError",
                set,
                pin.optionReference,
                pin.reference,
                yieldMatch.status === "ExactYieldQuantity" ? null : yieldMatch.status,
              );
              if (
                yieldMatch.status !== "ExactYieldQuantity" ||
                !yieldMatch.requestedYieldMicrounits
              )
                continue;
              const requestedYield = yieldMatch.requestedYieldMicrounits;
              const request = parseRecipeReferenceSourceRequest({
                purposeCode: "CATALOG_LIFECYCLE_RECIPE_SOURCE_READ",
                brandReference: brand,
                actorReference: actor,
                operationReference: operation,
                catalogIntentDigest: original.originalIntentDigest,
              });
              const common = {
                tenantReference: tenant,
                brandReference: brand,
                actorReference: actor,
                clock: { now: check },
                transactions: {
                  async run<T>(action: (actual: typeof tx) => Promise<T>) {
                    check();
                    const result = await action(tx);
                    check();
                    return result;
                  },
                },
              };
              const authority: CurrentPublishedRecipeMeasurementGraphOptions["authority"] = {
                async holdUntilTransactionCompletes(actual, input) {
                  if (
                    actual !== tx ||
                    input.tenantReference !== tenant ||
                    !equal(input.request, request) ||
                    input.permission !== "recipe.manage" ||
                    input.requiredScope !== "FullBrandScope" ||
                    !equal(input.requiredFields, currentPublishedRecipeDependencyGraphFields) ||
                    parseCatalogInstant(input.observedAt) < startedAt ||
                    parseCatalogInstant(input.observedAt) > check()
                  )
                    return poison();
                  await hold(true);
                },
              };
              await createCurrentPublishedRecipeMeasurementGraphSource({
                ...common,
                authority,
                measurementAuthority: {
                  async holdUntilTransactionCompletes(actual, input) {
                    if (
                      actual !== tx ||
                      input.tenantReference !== tenant ||
                      !equal(input.request, request) ||
                      input.permission !== "recipe.manage" ||
                      input.requiredScope !== "FullBrandScope" ||
                      !equal(input.requiredFields, currentPublishedRecipeMeasurementGraphFields) ||
                      parseCatalogInstant(input.observedAt) < startedAt ||
                      parseCatalogInstant(input.observedAt) > check()
                    )
                      return poison();
                    await hold(true);
                  },
                },
              }).withCurrentGraph(
                {
                  request,
                  observedAt: original.observedAt,
                  validUntil: deadline,
                  activationAt: original.activationAt,
                  recipeVersions: [
                    { recipeReference: pin.reference, versionReference: pin.versionReference },
                  ],
                },
                async (full) => {
                  if (
                    full.profile !== "CurrentPublishedRecipeMeasurementGraphV2" ||
                    full.tenantReference !== tenant ||
                    !equal(full.request, request) ||
                    full.activationAt !== original.activationAt ||
                    !equal(full.rootVersionReferences, [pin.versionReference]) ||
                    full.measurementRepresentation !== "CompleteV2"
                  )
                    return poison();
                  tighten(full.validUntil);
                  const root = full.contents.find(
                    (c) => c.snapshot.versionReference === pin.versionReference,
                  );
                  if (!root || root.snapshot.recipeReference !== pin.reference) return poison();
                  const demand = calculateRecipeMeasurementDemand(
                    root.content,
                    full.contents
                      .filter((c) => c.snapshot.versionReference !== pin.versionReference)
                      .map((c) => c.content),
                    requestedYield,
                    check(),
                    original.activationAt,
                    { request, originalPublicationClock },
                  );
                  add(
                    "PinnedRecipeGraphAndAmounts",
                    "Pass",
                    set,
                    pin.optionReference,
                    pin.reference,
                    null,
                  );
                  const measurements = full.contents.flatMap(({ content }) =>
                    content.snapshot.ingredients.flatMap((i) => {
                      if (i.sourceKind !== "InventoryItem") return [];
                      const measurement = content.measurements.find(
                        (m) => m.requirementReference === i.requirementReference,
                      );
                      if (!measurement) return poison();
                      return [
                        {
                          recipeReference: content.snapshot.recipeReference,
                          recipeVersionReference: content.snapshot.versionReference,
                          requirementReference: i.requirementReference,
                          itemReference: i.sourceReference,
                          operationReference: i.sourceVersionReference,
                          usageUnitCode: measurement.usageUnitCode,
                          usageDimension: measurement.usageDimension,
                          targetUnitCode: measurement.targetUnitCode,
                          targetDimension: measurement.targetDimension,
                          conversionKind: measurement.conversionKind,
                          conversionReference: measurement.conversionReference,
                          quantityMicrounits: i.quantityMicrounits,
                          conversionNumerator: i.conversionNumerator,
                          conversionDenominator: i.conversionDenominator,
                        },
                      ];
                    }),
                  );
                  if (!measurements.length) {
                    if (demand.demands.length) return poison();
                    add(
                      "RecipeInventoryIngredients",
                      "Pass",
                      set,
                      pin.optionReference,
                      pin.reference,
                      "NoDirectInventoryIngredients",
                    );
                    return;
                  }
                  hasInventoryReferences = true;
                  await hold(true);
                  const inventoryRequest = parseInventoryConfigurationReferenceRequest({
                    purposeCode: "CATALOG_LIFECYCLE_INVENTORY_CONFIGURATION_SOURCE_READ",
                    tenantReference: tenant,
                    brandReference: brand,
                    actorReference: actor,
                    operationReference: operation,
                    catalogIntentDigest: original.originalIntentDigest,
                  });
                  const inventoryAuthority: InventoryConfigurationReferenceOptions["authority"] = {
                    async holdUntilTransactionCompletes(actual, input) {
                      if (
                        actual !== tx ||
                        input.tenantReference !== tenant ||
                        !equal(input.request, inventoryRequest) ||
                        input.requiredScope !== "FullBrandScope" ||
                        !equal(
                          input.requiredPermissions,
                          inventoryConfigurationReferencePermissions,
                        ) ||
                        !equal(input.requiredFields, inventoryConfigurationReferenceFields) ||
                        parseCatalogInstant(input.observedAt) < startedAt ||
                        parseCatalogInstant(input.observedAt) > check()
                      )
                        return poison();
                      await hold(true);
                    },
                  };
                  const pins = measurements.map(
                    ({
                      recipeReference,
                      recipeVersionReference,
                      requirementReference,
                      itemReference,
                      operationReference,
                    }) => ({
                      recipeReference,
                      recipeVersionReference,
                      requirementReference,
                      itemReference,
                      operationReference,
                    }),
                  );
                  await createPostgresInventoryConfigurationReferenceSourceStore({
                    ...common,
                    authority: inventoryAuthority,
                  }).withCurrentSnapshot(inventoryRequest, async (metadata) => {
                    const resolved = assessCurrentRecipeIngredientInventoryReferences(
                      pins,
                      metadata,
                      inventoryRequest,
                      check(),
                      original.activationAt,
                    );
                    for (const r of resolved.resolutions)
                      add(
                        "RecipeInventoryIngredientCurrent",
                        r.status === "ResolvedCurrentActiveItemConfiguration"
                          ? "Pass"
                          : "HardError",
                        set,
                        pin.optionReference,
                        r.itemReference,
                        r.status === "ResolvedCurrentActiveItemConfiguration" ? null : r.status,
                      );
                    if (resolved.decision === "HardError") return;
                    await createPostgresInventoryRecipeIngredientUnitSource({
                      ...common,
                      authority: inventoryAuthority,
                      unitAuthority: {
                        async holdUntilTransactionCompletes(actual, input) {
                          if (
                            actual !== tx ||
                            !equal(input.request, inventoryRequest) ||
                            input.requiredScope !== "FullBrandScope" ||
                            !equal(
                              input.requiredPermissions,
                              inventoryConfigurationReferencePermissions,
                            ) ||
                            !equal(input.requiredFields, inventoryRecipeIngredientUnitFields) ||
                            !equal(
                              input.itemReferences,
                              [...new Set(pins.map((p) => p.itemReference))].sort(),
                            ) ||
                            parseCatalogInstant(input.observedAt) < startedAt ||
                            parseCatalogInstant(input.observedAt) > check()
                          )
                            return poison();
                          await hold(true);
                        },
                      },
                    }).withCurrentUnits(inventoryRequest, pins, async (facts) => {
                      tighten(facts.validUntil);
                      if (
                        facts.ownerGeneration !== metadata.generation ||
                        !equal(facts.request, inventoryRequest)
                      )
                        return poison();
                      const conversions = assessRecipeIngredientUnits(
                        measurements,
                        facts,
                        check(),
                        original.activationAt,
                        originalPublicationClock,
                      );
                      for (const r of conversions.matches)
                        add(
                          "RecipeIngredientConversion",
                          r.status === "ExactBaseQuantity" ? "Pass" : "HardError",
                          set,
                          pin.optionReference,
                          r.itemReference,
                          r.status === "ExactBaseQuantity" ? null : r.status,
                        );
                      const final = assessRecipeBaseDemands(
                        demand.demands.map((d) => ({
                          recipeReference: d.recipeReference,
                          recipeVersionReference: d.recipeVersionReference,
                          requirementReference: d.requirementReference,
                          itemReference: d.itemReference,
                          operationReference: d.operationReference,
                          pathDigest: "sha256:" + sha256Hex(canonicalizeRfc8785(d.sourcePath)),
                          targetUnitCode: d.targetUnitCode,
                          targetDimension: d.targetDimension,
                          quantityNumerator: d.quantityNumerator,
                          quantityDenominator: d.quantityDenominator,
                        })),
                        facts,
                        check(),
                        original.activationAt,
                        originalPublicationClock,
                      );
                      for (const r of final.matches)
                        add(
                          "RecipeScaledDemandPrecision",
                          r.status === "ExactBaseDemand" ? "Pass" : "HardError",
                          set,
                          pin.optionReference,
                          r.itemReference,
                          r.status === "ExactBaseDemand" ? null : r.status,
                        );
                      if (final.aggregateStatus === "QuantityOutOfRange")
                        add(
                          "RecipeScaledDemandTotal",
                          "HardError",
                          set,
                          pin.optionReference,
                          pin.reference,
                          "QuantityOutOfRange",
                        );
                    });
                  });
                },
              );
              add(
                "ProductBindingAndSaleApplicability",
                "NotApplicableForIndependentSet",
                set,
                pin.optionReference,
                pin.reference,
                "AssessedWhenBoundAndSelected",
              );
            }
          }
          if (!hasReferences)
            add("RecipeReferences", "Pass", null, null, null, "NoRecipeReferences");
          const standaloneReferenceAssessment: StandaloneReferenceAssessment = immutable({
            phase: "OptionSetPublication",
            decision: checks.some((c) => c.outcome === "HardError")
              ? "HardError"
              : checks.some((c) => c.outcome === "Indeterminate")
                ? "Indeterminate"
                : "Pass",
            checks,
          });
          const packet = immutable({
            profile: "CurrentOptionSetPublicationRecipeV1" as const,
            context: {
              tenantReference: String(tenant),
              brandReference: String(brand),
              storeReference: String(store),
              actorReference: String(actor),
              sessionReference: String(session),
            },
            operationReference: String(operation),
            binding: original,
            graph,
            coverage: "AllGraphRecipePins" as const,
            status: hasReferences ? ("AssessedReferences" as const) : ("NoReferences" as const),
            nodes: Object.freeze(nodes),
            standaloneReferenceAssessment,
            permissionDecisions,
            observedAt: check(),
            validUntil: deadline,
            ingredientEligibility: "NotEvaluated" as const,
            referenceEligibility: "NotEvaluated" as const,
            eligibility: "NotEvaluated" as const,
            publishValidation: "Incomplete" as const,
          });
          const answer = await work(packet);
          check();
          return answer;
        })();
        await hold(hasReferences);
        ready = true;
        return result;
      } catch (error) {
        return reject(error);
      } finally {
        active = false;
      }
    },
  });
}
