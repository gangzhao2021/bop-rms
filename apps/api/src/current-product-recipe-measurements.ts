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
  createCurrentProductPublishedRecipeContentSource,
  type CurrentProductPublishedRecipeContent,
} from "./current-product-published-recipe-content.js";
type ParentOptions = Parameters<typeof createCurrentProductPublishedRecipeContentSource>[0];
type Tx = Parameters<
  ReturnType<typeof createCurrentProductPublishedRecipeContentSource>["withCurrentContent"]
>[0];
const fail = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};
export interface CurrentProductRecipeMeasurements {
  readonly profile: "CurrentProductRecipeMeasurementsV2";
  readonly content: CurrentProductPublishedRecipeContent;
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
 * No client measurement DTO, Product quantity or selling eligibility. All owning holders share original UoW. */
export function createCurrentProductRecipeMeasurementsSource(
  options: ParentOptions & {
    readonly graphAuthority: CurrentPublishedRecipeMeasurementGraphOptions["authority"];
    readonly measurementAuthority: CurrentPublishedRecipeMeasurementGraphOptions["measurementAuthority"];
    readonly inventoryAuthority: InventoryRecipeIngredientUnitOptions["authority"];
    readonly unitAuthority: InventoryRecipeIngredientUnitOptions["unitAuthority"];
  },
) {
  const tenantReference = parseCatalogReference(options.tenantReference),
    brandReference = parseCatalogReference(options.brandReference),
    actorReference = parseCatalogReference(options.actorReference),
    parent = createCurrentProductPublishedRecipeContentSource(options),
    read = parent.withCurrentContent.bind(parent),
    now = options.clock.now.bind(options.clock),
    hold = options.inventoryAuthority.holdUntilTransactionCompletes.bind(
      options.inventoryAuthority,
    ),
    graphHold = options.graphAuthority.holdUntilTransactionCompletes.bind(options.graphAuthority),
    active = new WeakSet<object>(),
    failed = new WeakSet<object>();
  return Object.freeze({
    async withCurrentAssessment<T>(
      tx: Tx,
      value: unknown,
      work: (v: CurrentProductRecipeMeasurements) => Promise<T>,
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
        active.add(tx);
        entered = true;
        const query = tx.query,
          bound = query.bind(tx);
        let latest: string | undefined, deadline: string | undefined;
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
              await options.unitAuthority.holdUntilTransactionCompletes(tx, input);
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
              await options.measurementAuthority.holdUntilTransactionCompletes(tx, input);
              check();
            },
          },
        });
        let parentCalls = 0,
          graphCalls = 0,
          sourceCalls = 0,
          complete = false,
          answer: T | undefined;
        const result = await read(tx, value, async (content) => {
          if (++parentCalls !== 1) return fail();
          deadline = parseCatalogInstant(content.validUntil);
          check();
          const requestGraph = {
            purposeCode: "CATALOG_LIFECYCLE_RECIPE_SOURCE_READ" as const,
            brandReference,
            actorReference,
            operationReference: content.recipeContents.request.operationReference,
            catalogIntentDigest: content.recipeContents.request.catalogIntentDigest,
          };
          const roots = content.recipeContents.contents.map((row) => ({
            recipeReference: row.snapshot.recipeReference,
            versionReference: row.snapshot.versionReference,
          }));
          return graphSource.withCurrentGraph(
            {
              request: requestGraph,
              observedAt: content.selection.originalObservedAt,
              validUntil: content.validUntil,
              activationAt: content.recipeContents.activationAt,
              recipeVersions: roots,
            },
            async (graph) => {
              if (
                ++graphCalls !== 1 ||
                graph.tenantReference !== tenantReference ||
                canonicalizeRfc8785(graph.request) !== canonicalizeRfc8785(requestGraph) ||
                graph.observedAt !== content.selection.originalObservedAt ||
                graph.activationAt !== content.recipeContents.activationAt ||
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
              for (const root of content.recipeContents.contents) {
                const matches = graph.contents.filter(
                  (row) => row.snapshot.versionReference === root.snapshot.versionReference,
                );
                const [matched] = matches;
                if (
                  matches.length !== 1 ||
                  !matched ||
                  canonicalizeRfc8785(matched.snapshot) !== canonicalizeRfc8785(root.snapshot) ||
                  matched.publicationOperationReference !== root.publicationOperationReference ||
                  matched.publicationEvidenceDigest !== root.publicationEvidenceDigest
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
                operationReference: content.recipeContents.request.operationReference,
                catalogIntentDigest: content.recipeContents.request.catalogIntentDigest,
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
                  facts.ownerObservedAt < content.selection.originalObservedAt ||
                  canonicalizeRfc8785(facts.request) !== canonicalizeRfc8785(request)
                )
                  return fail();
                const until = parseCatalogInstant(facts.validUntil);
                if (deadline === undefined) return fail();
                if (until < deadline) deadline = until;
                const assessedAt = check(),
                  activationAt = content.recipeContents.activationAt;
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
                  profile: "CurrentProductRecipeMeasurementsV2" as const,
                  content,
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
        if (tx && typeof tx === "object") failed.add(tx);
        return fail();
      } finally {
        if (entered) active.delete(tx);
      }
    },
  });
}
