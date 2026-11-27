import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { readClosedRecord } from "@bop/identity";
import { CatalogError, copyCategoryPersistenceValue, parseCatalogInstant } from "@rms/catalog";
import {
  createPostgresInventoryConfigurationReferenceSourceStore,
  parseInventoryConfigurationReferenceRequest,
  matchOptionDraftInventoryConsumptionMetadata,
} from "@rms/inventory";
import {
  createPostgresRecipeReferenceSourceStore,
  parseRecipeReferenceSourceRequest,
  matchOptionDraftRecipeConsumptionMetadata,
} from "@rms/recipe";
import { createCurrentOptionSetDraftGraphSource } from "./current-option-set-draft-graph.js";
type GraphOptions = Parameters<typeof createCurrentOptionSetDraftGraphSource>[0];
type Tx = Parameters<
  ReturnType<typeof createCurrentOptionSetDraftGraphSource>["withCurrentGraph"]
>[0];
type InventoryOptions = Parameters<
  typeof createPostgresInventoryConfigurationReferenceSourceStore
>[0];
type RecipeOptions = Parameters<typeof createPostgresRecipeReferenceSourceStore>[0];
export type CurrentOptionSetDraftConsumptionReferences = Readonly<{
  profile: "CurrentOptionSetDraftConsumptionReferencesV1";
  tenantReference: string;
  brandReference: string;
  inventory: ReturnType<typeof matchOptionDraftInventoryConsumptionMetadata>;
  recipe: ReturnType<typeof matchOptionDraftRecipeConsumptionMetadata>;
  originalObservedAt: string;
  rootObservedAt: string;
  validUntil: string;
  sourceAuthority: "CurrentDraftRootAndConsumptionMetadata";
  publishValidation: "Incomplete";
  eligibility: "NotEvaluated";
  digest: string;
}>;
const fail = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};
/** Actual owning full Draft and complete current Inventory/Recipe metadata.
 * Quantity/conversion/Binding/current reference admission remain separate. */
export function createCurrentOptionSetDraftConsumptionReferenceSource(options: {
  tenantReference: string;
  brandReference: string;
  actorReference: string;
  clock: GraphOptions["clock"];
  readAuthority: GraphOptions["authority"];
  inventoryAuthority: InventoryOptions["authority"];
  recipeAuthority: RecipeOptions["authority"];
}) {
  const graph = createCurrentOptionSetDraftGraphSource({
      ...options,
      authority: options.readAuthority,
    }),
    now = options.clock.now.bind(options.clock),
    active = new WeakSet<object>(),
    failed = new WeakSet<object>();
  const capture = <I>(authority: {
    holdUntilTransactionCompletes(tx: Tx, input: I): Promise<void>;
  }) => {
    if (typeof authority?.holdUntilTransactionCompletes !== "function") return fail();
    return authority.holdUntilTransactionCompletes.bind(authority);
  };
  const inventoryHold = capture(options.inventoryAuthority),
    recipeHold = capture(options.recipeAuthority);
  return Object.freeze({
    async withCurrentAssessment<T>(
      tx: Tx,
      value: unknown,
      work: (v: CurrentOptionSetDraftConsumptionReferences) => Promise<T>,
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
        )
          return fail();
        active.add(tx);
        entered = true;
        const input = readClosedRecord(copyCategoryPersistenceValue(value), [
            "graphRequest",
            "inventoryRequest",
            "recipeRequest",
            "activationAt",
          ]),
          r = readClosedRecord(input.graphRequest, [
            "optionSetReference",
            "versionReference",
            "expectedAggregateVersion",
            "sourceDigest",
            "contentDigest",
            "configurationDigest",
            "observedAt",
            "validUntil",
          ]),
          inventoryRequest = parseInventoryConfigurationReferenceRequest(input.inventoryRequest),
          recipeRequest = parseRecipeReferenceSourceRequest(input.recipeRequest),
          originalObservedAt = parseCatalogInstant(r.observedAt),
          activationAt = parseCatalogInstant(input.activationAt),
          query = tx.query,
          sql = Object.freeze({ query: query.bind(tx) });
        if (
          inventoryRequest.tenantReference !== graph.context.tenantReference ||
          inventoryRequest.brandReference !== graph.context.brandReference ||
          recipeRequest.brandReference !== graph.context.brandReference ||
          inventoryRequest.actorReference !== graph.context.actorReference ||
          recipeRequest.actorReference !== graph.context.actorReference ||
          inventoryRequest.operationReference !== recipeRequest.operationReference ||
          inventoryRequest.catalogIntentDigest !== recipeRequest.catalogIntentDigest ||
          activationAt < originalObservedAt
        )
          return fail();
        let until: string = parseCatalogInstant(r.validUntil),
          latest = originalObservedAt,
          roots = 0,
          inventoryCalls = 0,
          recipeCalls = 0,
          completed = false,
          answer: T | undefined;
        const check = () => {
          const at = parseCatalogInstant(now());
          if (failed.has(tx) || tx.query !== query || at < latest || at >= until) return fail();
          latest = at;
          return at;
        };
        check();
        const bridge = <I>(hold: (tx: Tx, input: I) => Promise<void>) => ({
          async holdUntilTransactionCompletes(actual: Tx, input: I) {
            check();
            if (actual !== sql) return fail();
            await hold(tx, input);
            check();
          },
        });
        const result = await graph.withCurrentGraph(tx, r, async (root) => {
          if (
            ++roots !== 1 ||
            root.sourceAuthority !== "CurrentDraftRootOnly" ||
            root.publishValidation !== "Incomplete" ||
            root.eligibility !== "NotEvaluated" ||
            root.originalObservedAt !== originalObservedAt
          )
            return fail();
          until = root.validUntil < until ? root.validUntil : until;
          check();
          const common = {
            tenantReference: graph.context.tenantReference,
            brandReference: graph.context.brandReference,
            actorReference: graph.context.actorReference,
            clock: { now: check },
            transactions: { run: <V>(action: (tx: Tx) => Promise<V>) => action(sql) },
          };
          const inventorySource = createPostgresInventoryConfigurationReferenceSourceStore({
              ...common,
              authority: bridge(inventoryHold),
            }),
            recipeSource = createPostgresRecipeReferenceSourceStore({
              ...common,
              authority: bridge(recipeHold),
            });
          const inventoryResult = await inventorySource.withCurrentSnapshot(
            inventoryRequest,
            async (inventory) => {
              if (++inventoryCalls !== 1) return fail();
              const invUntil = new Date(Date.parse(inventory.observedAt) + 5000).toISOString();
              until = invUntil < until ? invUntil : until;
              check();
              const recipeResult = await recipeSource.withCurrentSnapshot(
                recipeRequest,
                async (recipe) => {
                  if (++recipeCalls !== 1) return fail();
                  const recUntil = new Date(Date.parse(recipe.observedAt) + 5000).toISOString();
                  until = recUntil < until ? recUntil : until;
                  const at = check();
                  const base = {
                    profile: "CurrentFullOptionDraftConsumptionPinsV1",
                    brandReference: graph.context.brandReference,
                    optionSetReference: root.graph.rootOptionSetReference,
                    versionReference: root.graph.rootVersionReference,
                    sourceDigest: root.sourceDigest,
                    contentDigest: root.contentDigest,
                    configurationDigest: root.configurationDigest,
                  };
                  const pins = (kind: "Inventory" | "Recipe") =>
                    root.graph.contents.flatMap((n) =>
                      n.optionDetails
                        .filter((d) => d.consumption?.kind === kind)
                        .map((d) => {
                          if (d.consumption === null) return fail();
                          return {
                            optionReference: d.optionReference,
                            reference: d.consumption.reference,
                            versionReference: d.consumption.versionReference,
                          };
                        }),
                    );
                  const evidence = {
                    profile: "CurrentOptionSetDraftConsumptionReferencesV1" as const,
                    tenantReference: graph.context.tenantReference,
                    brandReference: graph.context.brandReference,
                    inventory: matchOptionDraftInventoryConsumptionMetadata(
                      { ...base, pins: pins("Inventory") },
                      inventory,
                      inventoryRequest,
                      at,
                      activationAt,
                    ),
                    recipe: matchOptionDraftRecipeConsumptionMetadata(
                      { ...base, pins: pins("Recipe") },
                      recipe,
                      recipeRequest,
                      at,
                      activationAt,
                    ),
                    originalObservedAt,
                    rootObservedAt: root.observedAt,
                    validUntil: until,
                    sourceAuthority: "CurrentDraftRootAndConsumptionMetadata" as const,
                    publishValidation: "Incomplete" as const,
                    eligibility: "NotEvaluated" as const,
                  };
                  answer = await work(
                    Object.freeze({
                      ...evidence,
                      digest: "sha256:" + sha256Hex(canonicalizeRfc8785(evidence)),
                    }),
                  );
                  check();
                  completed = true;
                  return answer;
                },
              );
              if (recipeCalls !== 1 || !completed || !Object.is(recipeResult, answer))
                return fail();
              check();
              return recipeResult;
            },
          );
          if (inventoryCalls !== 1 || !completed || !Object.is(inventoryResult, answer))
            return fail();
          check();
          return inventoryResult;
        });
        if (
          roots !== 1 ||
          inventoryCalls !== 1 ||
          recipeCalls !== 1 ||
          !completed ||
          !Object.is(result, answer)
        )
          return fail();
        check();
        return result as T;
      } catch {
        if (tx && typeof tx === "object") failed.add(tx);
        return fail();
      } finally {
        if (entered) active.delete(tx);
      }
    },
  });
}
