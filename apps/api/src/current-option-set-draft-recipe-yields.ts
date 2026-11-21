import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { readClosedRecord } from "@bop/identity";
import { CatalogError, copyCategoryPersistenceValue, parseCatalogInstant } from "@rms/catalog";
import {
  createPostgresRecipeOptionConsumptionYieldSource,
  parseRecipeReferenceSourceRequest,
  type RecipeOptionConsumptionYieldOptions,
  type assessRecipeOptionConsumptionYields,
} from "@rms/recipe";
import { createCurrentOptionSetDraftGraphSource } from "./current-option-set-draft-graph.js";
type GraphOptions = Parameters<typeof createCurrentOptionSetDraftGraphSource>[0];
type Tx = Parameters<
  ReturnType<typeof createCurrentOptionSetDraftGraphSource>["withCurrentGraph"]
>[0];
export type CurrentOptionSetDraftRecipeYields = Readonly<{
  profile: "CurrentOptionSetDraftRecipeYieldsV1";
  tenantReference: string;
  brandReference: string;
  optionSetReference: string;
  versionReference: string;
  sourceDigest: string;
  contentDigest: string;
  configurationDigest: string;
  graphDigest: string;
  recipe: ReturnType<typeof assessRecipeOptionConsumptionYields>;
  originalObservedAt: string;
  rootObservedAt: string;
  validUntil: string;
  sourceAuthority: "CurrentDraftRootAndRecipeYields";
  publishValidation: "Incomplete";
  eligibility: "NotEvaluated";
  digest: string;
}>;
const fail = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};
export function createCurrentOptionSetDraftRecipeYieldSource(options: {
  tenantReference: string;
  brandReference: string;
  actorReference: string;
  clock: GraphOptions["clock"];
  readAuthority: GraphOptions["authority"];
  recipeAuthority: RecipeOptionConsumptionYieldOptions["authority"];
  yieldAuthority: RecipeOptionConsumptionYieldOptions["yieldAuthority"];
}) {
  const graph = createCurrentOptionSetDraftGraphSource({
      ...options,
      authority: options.readAuthority,
    }),
    now = options.clock.now.bind(options.clock),
    metadataHold = options.recipeAuthority.holdUntilTransactionCompletes.bind(
      options.recipeAuthority,
    ),
    yieldHold = options.yieldAuthority.holdUntilTransactionCompletes.bind(options.yieldAuthority),
    active = new WeakSet<object>(),
    failed = new WeakSet<object>();
  return Object.freeze({
    async withCurrentAssessment<T>(
      tx: Tx,
      value: unknown,
      work: (v: CurrentOptionSetDraftRecipeYields) => Promise<T>,
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
            "recipeRequest",
            "activationAt",
          ]),
          request = parseRecipeReferenceSourceRequest(input.recipeRequest),
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
          originalObservedAt = parseCatalogInstant(r.observedAt),
          activationAt = parseCatalogInstant(input.activationAt),
          query = tx.query,
          sql = Object.freeze({ query: query.bind(tx) });
        if (
          request.brandReference !== graph.context.brandReference ||
          request.actorReference !== graph.context.actorReference ||
          activationAt < originalObservedAt
        )
          return fail();
        let latest = originalObservedAt,
          until: string = parseCatalogInstant(r.validUntil),
          roots = 0,
          calls = 0,
          completed = false,
          answer: T | undefined;
        const check = () => {
          const at = parseCatalogInstant(now());
          if (failed.has(tx) || tx.query !== query || at < latest || at >= until) return fail();
          latest = at;
          return at;
        };
        const bridge = <I>(hold: (tx: Tx, input: I) => Promise<void>) => ({
          async holdUntilTransactionCompletes(actual: Tx, input: I) {
            check();
            if (actual !== sql) return fail();
            await hold(tx, input);
            check();
          },
        });
        check();
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
          const pins = root.graph.contents.flatMap((n) =>
            n.optionDetails
              .filter((d) => d.consumption?.kind === "Recipe")
              .map((d) => {
                const c = d.consumption;
                if (!c) return fail();
                return {
                  optionReference: d.optionReference,
                  reference: c.reference,
                  versionReference: c.versionReference,
                  quantity: c.quantity,
                  unitCode: c.unitCode,
                };
              }),
          );
          const owner = createPostgresRecipeOptionConsumptionYieldSource({
            tenantReference: graph.context.tenantReference,
            brandReference: graph.context.brandReference,
            actorReference: graph.context.actorReference,
            clock: { now: check },
            transactions: { run: <V>(action: (tx: Tx) => Promise<V>) => action(sql) },
            authority: bridge(metadataHold),
            yieldAuthority: bridge(yieldHold),
          });
          const result = await owner.withCurrentYields(
            request,
            pins,
            activationAt,
            async (recipe) => {
              if (++calls !== 1) return fail();
              const { validUntil: ownerUntil, ...assessment } = recipe;
              until = ownerUntil < until ? ownerUntil : until;
              check();
              const body = {
                profile: "CurrentOptionSetDraftRecipeYieldsV1" as const,
                tenantReference: graph.context.tenantReference,
                brandReference: graph.context.brandReference,
                optionSetReference: root.graph.rootOptionSetReference,
                versionReference: root.graph.rootVersionReference,
                sourceDigest: root.sourceDigest,
                contentDigest: root.contentDigest,
                configurationDigest: root.configurationDigest,
                graphDigest: root.graphDigest,
                recipe: Object.freeze(assessment),
                originalObservedAt,
                rootObservedAt: root.observedAt,
                validUntil: until,
                sourceAuthority: "CurrentDraftRootAndRecipeYields" as const,
                publishValidation: "Incomplete" as const,
                eligibility: "NotEvaluated" as const,
              };
              answer = await work(
                Object.freeze({
                  ...body,
                  digest: "sha256:" + sha256Hex(canonicalizeRfc8785(body)),
                }),
              );
              check();
              completed = true;
              return answer;
            },
          );
          if (calls !== 1 || !completed || !Object.is(result, answer)) return fail();
          check();
          return result;
        });
        if (roots !== 1 || calls !== 1 || !completed || !Object.is(result, answer)) return fail();
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
