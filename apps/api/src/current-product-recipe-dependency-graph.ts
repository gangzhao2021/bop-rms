import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { CatalogError, parseCatalogReference, parseCatalogInstant } from "@rms/catalog";
import {
  createPostgresInventoryConfigurationReferenceSourceStore,
  assessCurrentRecipeIngredientInventoryReferences,
  type InventoryConfigurationReferenceOptions,
} from "@rms/inventory";
import {
  createCurrentPublishedRecipeDependencyGraphSource,
  type CurrentPublishedRecipeDependencyGraph,
  type CurrentPublishedRecipeDependencyGraphOptions,
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
export interface CurrentProductRecipeDependencyGraph {
  readonly profile: "CurrentProductRecipeDependencyGraphV1";
  readonly content: CurrentProductPublishedRecipeContent;
  readonly graph: CurrentPublishedRecipeDependencyGraph;
  readonly inventory: ReturnType<typeof assessCurrentRecipeIngredientInventoryReferences>;
  readonly subrecipeReferenceCount: number;
  readonly subrecipes: "PassForPinnedPublishedSubrecipes";
  readonly unitsAndConversions: "NotEvaluated";
  readonly childReferences: "Incomplete";
  readonly publishValidation: "Incomplete";
  readonly eligibility: "NotEvaluated";
  readonly validUntil: string;
  readonly digest: string;
}
/** Every reachable exact pinned Ingredient comes from the owning Recipe graph.
 * Current Item facts come only from Inventory's held owning source.
 * Recipe content and all final Catalog/Store/Brand/Recipe rereads share original UoW. */
export function createCurrentProductRecipeDependencyGraphSource(
  options: ParentOptions & {
    readonly graphAuthority: CurrentPublishedRecipeDependencyGraphOptions["authority"];
    readonly inventoryAuthority: InventoryConfigurationReferenceOptions["authority"];
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
      work: (v: CurrentProductRecipeDependencyGraph) => Promise<T>,
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
          facade = Object.freeze({ query: query.bind(tx) });
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
        const source = createPostgresInventoryConfigurationReferenceSourceStore({
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
        });
        const graphSource = createCurrentPublishedRecipeDependencyGraphSource({
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
                graph.subrecipeGraph !== "PassForPinnedPublishedSubrecipes" ||
                canonicalizeRfc8785([...graph.rootVersionReferences].sort()) !==
                  canonicalizeRfc8785(roots.map((r) => r.versionReference).sort())
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
                for (const ingredient of row.snapshot.ingredients) {
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
              return source.withCurrentSnapshot(request, async (metadata) => {
                if (
                  ++sourceCalls !== 1 ||
                  metadata.observedAt < content.selection.originalObservedAt
                )
                  return fail();
                const until = new Date(Date.parse(metadata.observedAt) + 5000).toISOString();
                if (deadline === undefined) return fail();
                if (until < deadline) deadline = until;
                check();
                const inventory = assessCurrentRecipeIngredientInventoryReferences(
                  targets,
                  metadata,
                  request,
                  check(),
                  content.recipeContents.activationAt,
                );
                if (inventory.decision === "HardError") return fail();
                const body = {
                  profile: "CurrentProductRecipeDependencyGraphV1" as const,
                  content,
                  graph,
                  inventory,
                  subrecipeReferenceCount,
                  subrecipes: "PassForPinnedPublishedSubrecipes" as const,
                  unitsAndConversions: "NotEvaluated" as const,
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
