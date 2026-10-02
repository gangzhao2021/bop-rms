import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { CatalogError, parseCatalogReference, parseCatalogInstant } from "@rms/catalog";
import {
  createPostgresInventoryRecipeIngredientUnitSource,
  assessRecipeIngredientUnits,
  assessRecipeBaseDemands,
  type InventoryRecipeIngredientUnitOptions,
} from "@rms/inventory";
import {
  createCurrentPublishedRecipeMeasurementGraphSource,
  calculateRecipeMeasurementBatchDemands,
  type CurrentPublishedRecipeMeasurementGraph,
  type CurrentPublishedRecipeMeasurementGraphOptions,
} from "@rms/recipe";
import {
  createCurrentProductCandidateStoreRecipePolicySource,
  type CurrentProductCandidateStoreRecipePolicy,
} from "./current-product-candidate-store-recipe-policy.js";
type ParentOptions = Parameters<typeof createCurrentProductCandidateStoreRecipePolicySource>[0];
type Tx = Parameters<
  ReturnType<typeof createCurrentProductCandidateStoreRecipePolicySource>["withCurrentResolution"]
>[0];
const fail = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};
export interface CurrentProductCandidateRecipeMeasurements {
  readonly profile: "CurrentProductCandidateRecipeMeasurementsV2";
  readonly selection: CurrentProductCandidateStoreRecipePolicy;
  readonly graph: CurrentPublishedRecipeMeasurementGraph;
  readonly units: ReturnType<typeof assessRecipeIngredientUnits>;
  readonly batches: ReturnType<typeof calculateRecipeMeasurementBatchDemands>;
  readonly precision: readonly ReturnType<typeof assessRecipeBaseDemands>[];
  readonly subrecipeReferenceCount: number;
  readonly subrecipes: "PassForPinnedPublishedSubrecipes";
  readonly unitsAndConversions: "Pass";
  readonly inventoryPrecision: "Pass";
  readonly productQuantity: "NotEvaluated";
  readonly childReferences: "Incomplete";
  readonly publishValidation: "Incomplete";
  readonly eligibility: "NotEvaluated";
  readonly validUntil: string;
  readonly digest: string;
}
/** Full current V2 graph, direct unit qualification and independent Recipe batch precision.
 * Original owning Validate candidate and current Store/Brand selection only; no client DTO or Product quantity.
 * Full V2 graph owns current root publication proof; all holders share original UoW. */
export function createCurrentProductCandidateRecipeMeasurementsSource(
  options: ParentOptions & {
    readonly graphAuthority: CurrentPublishedRecipeMeasurementGraphOptions["authority"];
    readonly measurementAuthority: CurrentPublishedRecipeMeasurementGraphOptions["measurementAuthority"];
    readonly inventoryAuthority: InventoryRecipeIngredientUnitOptions["authority"];
    readonly unitAuthority: InventoryRecipeIngredientUnitOptions["unitAuthority"];
  },
) {
  if (
    typeof options.clock?.now !== "function" ||
    typeof options.candidateAuthority?.holdUntilTransactionCompletes !== "function" ||
    typeof options.graphAuthority?.holdUntilTransactionCompletes !== "function" ||
    typeof options.measurementAuthority?.holdUntilTransactionCompletes !== "function" ||
    typeof options.inventoryAuthority?.holdUntilTransactionCompletes !== "function" ||
    typeof options.unitAuthority?.holdUntilTransactionCompletes !== "function"
  )
    return fail();
  const tenantReference = parseCatalogReference(options.tenantReference),
    brandReference = parseCatalogReference(options.brandReference),
    actorReference = parseCatalogReference(options.actorReference),
    candidateHold = options.candidateAuthority.holdUntilTransactionCompletes.bind(
      options.candidateAuthority,
    ),
    denials = new WeakMap<object, CatalogError>(),
    parent = createCurrentProductCandidateStoreRecipePolicySource({
      ...options,
      candidateAuthority: {
        async holdUntilTransactionCompletes(actual, input) {
          try {
            await candidateHold(actual, input);
          } catch (error) {
            if (error instanceof CatalogError && error.code === "CATALOG_PERMISSION_DENIED")
              denials.set(actual, error);
            throw error;
          }
        },
      },
    }),
    read = parent.withCurrentResolution.bind(parent),
    now = options.clock.now.bind(options.clock),
    hold = options.inventoryAuthority.holdUntilTransactionCompletes.bind(
      options.inventoryAuthority,
    ),
    graphHold = options.graphAuthority.holdUntilTransactionCompletes.bind(options.graphAuthority),
    measurementHold = options.measurementAuthority.holdUntilTransactionCompletes.bind(
      options.measurementAuthority,
    ),
    unitHold = options.unitAuthority.holdUntilTransactionCompletes.bind(options.unitAuthority),
    active = new WeakSet<object>(),
    failed = new WeakSet<object>();
  return Object.freeze({
    async withCurrentAssessment<T>(
      tx: Tx,
      value: unknown,
      work: (v: CurrentProductCandidateRecipeMeasurements) => Promise<T>,
    ): Promise<T> {
      let entered = false;
      try {
        if (
          !tx ||
          typeof tx !== "object" ||
          typeof tx.query !== "function" ||
          typeof work !== "function" ||
          active.has(tx) ||
          failed.has(tx)
        ) {
          if (tx && typeof tx === "object") failed.add(tx);
          return fail();
        }
        denials.delete(tx);
        active.add(tx);
        entered = true;
        const query = tx.query,
          bound = query.bind(tx);
        const entry = parseCatalogInstant(now());
        let latest: string = entry,
          deadline: string = parseCatalogInstant(
            new Date(Date.parse(entry) + 30_000).toISOString(),
          );
        const check = () => {
          const at = parseCatalogInstant(now());
          if (
            failed.has(tx) ||
            tx.query !== query ||
            (latest !== undefined && at < latest) ||
            (deadline !== undefined && at >= deadline)
          )
            return fail();
          latest = at;
          return at;
        };
        const facade: Tx = Object.freeze({
          async query<R>(sql: string, values: readonly unknown[]) {
            check();
            const result = await bound<R>(sql, values);
            check();
            return result;
          },
        });
        const source = createPostgresInventoryRecipeIngredientUnitSource({
          tenantReference,
          brandReference,
          actorReference,
          clock: { now: check },
          transactions: { run: (action) => action(facade) },
          authority: {
            async holdUntilTransactionCompletes(actual, input) {
              if (actual !== facade) return fail();
              check();
              await hold(tx, input);
              check();
            },
          },
          unitAuthority: {
            async holdUntilTransactionCompletes(actual, input) {
              if (actual !== facade) return fail();
              check();
              await unitHold(tx, input);
              check();
            },
          },
        });
        const graphSource = createCurrentPublishedRecipeMeasurementGraphSource({
          tenantReference,
          brandReference,
          actorReference,
          clock: { now: check },
          transactions: { run: (action) => action(facade) },
          authority: {
            async holdUntilTransactionCompletes(actual, input) {
              if (actual !== facade) return fail();
              check();
              await graphHold(tx, input);
              check();
            },
          },
          measurementAuthority: {
            async holdUntilTransactionCompletes(actual, input) {
              if (actual !== facade) return fail();
              check();
              await measurementHold(tx, input);
              check();
            },
          },
        });
        let parentCalls = 0,
          graphCalls = 0,
          sourceCalls = 0,
          complete = false,
          answer: T | undefined;
        const result = await read(tx, value, async (selection) => {
          if (++parentCalls !== 1) return fail();
          const parentUntil = parseCatalogInstant(selection.validUntil);
          if (parentUntil < deadline) deadline = parentUntil;
          check();
          const requestGraph = {
            purposeCode: "CATALOG_LIFECYCLE_RECIPE_SOURCE_READ" as const,
            brandReference,
            actorReference,
            operationReference: selection.recipe.operationReference,
            catalogIntentDigest: selection.recipe.originalIntentDigest,
          };
          if (
            selection.profile !== "CurrentProductCandidateStoreRecipePolicyV1" ||
            selection.tenantReference !== tenantReference ||
            selection.recipe.brandReference !== brandReference ||
            selection.recipe.productReference !== selection.productReference ||
            selection.recipe.productVersionReference !== selection.versionReference ||
            selection.recipe.originalIntentDigest !== selection.originalIntentDigest ||
            selection.recipe.catalogConfigurationDigest !== selection.configurationDigest ||
            selection.recipe.decision !== "PassForDirectBrandAndStoreBindings" ||
            selection.recipe.resolutions.length === 0 ||
            selection.originalObservedAt < entry
          )
            return fail();
          const byRecipe = new Map<string, string>();
          for (const resolution of selection.recipe.resolutions) {
            if (resolution.status !== "ResolvedStoredVersion") return fail();
            const recipe = parseCatalogReference(resolution.recipeReference),
              version = parseCatalogReference(resolution.recipeVersionReference),
              previous = byRecipe.get(recipe);
            if (previous !== undefined && previous !== version) return fail();
            byRecipe.set(recipe, version);
          }
          const roots = [...byRecipe].map(([recipeReference, versionReference]) => ({
            recipeReference,
            versionReference,
          }));
          return graphSource.withCurrentGraph(
            {
              request: requestGraph,
              observedAt: selection.originalObservedAt,
              validUntil: selection.validUntil,
              activationAt: selection.recipe.activationAt,
              recipeVersions: roots,
            },
            async (graph) => {
              if (
                ++graphCalls !== 1 ||
                graph.tenantReference !== tenantReference ||
                canonicalizeRfc8785(graph.request) !== canonicalizeRfc8785(requestGraph) ||
                graph.observedAt !== selection.originalObservedAt ||
                graph.activationAt !== selection.recipe.activationAt ||
                graph.profile !== "CurrentPublishedRecipeMeasurementGraphV2" ||
                graph.measurementRepresentation !== "CompleteV2" ||
                canonicalizeRfc8785([...graph.rootVersionReferences].sort()) !==
                  canonicalizeRfc8785(roots.map((r) => r.versionReference).sort())
              )
                return fail();
              if (
                graph.contents.some(
                  (row) =>
                    canonicalizeRfc8785(row.snapshot) !== canonicalizeRfc8785(row.content.snapshot),
                )
              )
                return fail();
              for (const root of roots) {
                const matches = graph.contents.filter(
                  (row) => row.snapshot.versionReference === root.versionReference,
                );
                const [matched] = matches;
                if (
                  matches.length !== 1 ||
                  !matched ||
                  matched.snapshot.recipeReference !== root.recipeReference
                )
                  return fail();
              }
              const graphUntil = parseCatalogInstant(graph.validUntil);
              if (deadline === undefined) return fail();
              if (graphUntil < deadline) deadline = graphUntil;
              check();
              const targets: {
                recipeReference: string;
                recipeVersionReference: string;
                requirementReference: string;
                itemReference: string;
                operationReference: string;
              }[] = [];
              let subrecipeReferenceCount = 0;
              for (const row of graph.contents)
                for (const ingredient of row.content.snapshot.ingredients) {
                  if (ingredient.sourceKind === "InventoryItem")
                    targets.push({
                      recipeReference: row.snapshot.recipeReference,
                      recipeVersionReference: row.snapshot.versionReference,
                      requirementReference: ingredient.requirementReference,
                      itemReference: ingredient.sourceReference,
                      operationReference: ingredient.sourceVersionReference,
                    });
                  else subrecipeReferenceCount++;
                  if (targets.length + subrecipeReferenceCount > 1000) return fail();
                }
              const request = {
                purposeCode: "CATALOG_LIFECYCLE_INVENTORY_CONFIGURATION_SOURCE_READ" as const,
                tenantReference,
                brandReference,
                actorReference,
                operationReference: selection.recipe.operationReference,
                catalogIntentDigest: selection.recipe.originalIntentDigest,
              };
              const measurements = graph.contents.flatMap(({ content: c }) =>
                c.snapshot.ingredients
                  .filter((i) => i.sourceKind === "InventoryItem")
                  .map((i) => {
                    const m = c.measurements.find(
                      (m) => m.requirementReference === i.requirementReference,
                    );
                    if (!m) return fail();
                    return {
                      recipeReference: c.snapshot.recipeReference,
                      recipeVersionReference: c.snapshot.versionReference,
                      requirementReference: i.requirementReference,
                      itemReference: i.sourceReference,
                      operationReference: i.sourceVersionReference,
                      usageUnitCode: m.usageUnitCode,
                      usageDimension: m.usageDimension,
                      targetUnitCode: m.targetUnitCode,
                      targetDimension: m.targetDimension,
                      conversionKind: m.conversionKind,
                      conversionReference: m.conversionReference,
                      quantityMicrounits: i.quantityMicrounits,
                      conversionNumerator: i.conversionNumerator,
                      conversionDenominator: i.conversionDenominator,
                    };
                  }),
              );
              return source.withCurrentUnits(request, targets, async (facts) => {
                if (
                  ++sourceCalls !== 1 ||
                  facts.ownerObservedAt < selection.originalObservedAt ||
                  canonicalizeRfc8785(facts.request) !== canonicalizeRfc8785(request)
                )
                  return fail();
                const until = parseCatalogInstant(facts.validUntil);
                if (deadline === undefined) return fail();
                if (until < deadline) deadline = until;
                const assessedAt = check(),
                  activationAt = selection.recipe.activationAt;
                const units = assessRecipeIngredientUnits(
                  measurements,
                  facts,
                  assessedAt,
                  activationAt,
                );
                if (units.unitArithmetic !== "Pass") return fail();
                const batches = calculateRecipeMeasurementBatchDemands(
                  graph.rootVersionReferences,
                  graph.contents.map((c) => c.content),
                  assessedAt,
                  activationAt,
                );
                const precision = Object.freeze(
                  batches.batches.map((batch) =>
                    assessRecipeBaseDemands(
                      batch.demands.map((d) => ({
                        recipeReference: d.recipeReference,
                        recipeVersionReference: d.recipeVersionReference,
                        requirementReference: d.requirementReference,
                        itemReference: d.itemReference,
                        operationReference: d.operationReference,
                        targetUnitCode: d.targetUnitCode,
                        targetDimension: d.targetDimension,
                        quantityNumerator: d.quantityNumerator,
                        quantityDenominator: d.quantityDenominator,
                        pathDigest: "sha256:" + sha256Hex(canonicalizeRfc8785(d.sourcePath)),
                      })),
                      facts,
                      assessedAt,
                      activationAt,
                    ),
                  ),
                );
                if (precision.some((p) => p.inventoryPrecision !== "Pass")) return fail();
                const body = {
                  profile: "CurrentProductCandidateRecipeMeasurementsV2" as const,
                  selection,
                  graph,
                  units,
                  batches,
                  precision,
                  subrecipeReferenceCount,
                  subrecipes: "PassForPinnedPublishedSubrecipes" as const,
                  unitsAndConversions: "Pass" as const,
                  inventoryPrecision: "Pass" as const,
                  productQuantity: "NotEvaluated" as const,
                  childReferences: "Incomplete" as const,
                  publishValidation: "Incomplete" as const,
                  eligibility: "NotEvaluated" as const,
                  validUntil: deadline,
                };
                answer = await work(
                  Object.freeze({
                    ...body,
                    digest: "sha256:" + sha256Hex(canonicalizeRfc8785(body)),
                  }),
                );
                complete = true;
                check();
                return answer;
              });
            },
          );
        });
        if (
          parentCalls !== 1 ||
          graphCalls !== 1 ||
          sourceCalls !== 1 ||
          !complete ||
          !Object.is(result, answer)
        )
          return fail();
        check();
        return result;
      } catch {
        if (tx && typeof tx === "object") {
          failed.add(tx);
          const denial = denials.get(tx);
          if (denial !== undefined) throw denial;
        }
        return fail();
      } finally {
        if (entered) {
          active.delete(tx);
          denials.delete(tx);
        }
      }
    },
  });
}
