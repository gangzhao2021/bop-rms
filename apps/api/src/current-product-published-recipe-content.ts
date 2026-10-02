import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { CatalogError, parseCatalogReference, parseCatalogInstant } from "@rms/catalog";
import {
  createCurrentPublishedRecipeContentSource,
  type CurrentPublishedRecipeContentOptions,
} from "@rms/recipe";
import {
  createCurrentProductStoreRecipePolicySource,
  type CurrentProductStoreRecipePolicy,
} from "./current-product-store-recipe-policy.js";
type BaseOptions = Parameters<typeof createCurrentProductStoreRecipePolicySource>[0];
type Tx = Parameters<
  ReturnType<typeof createCurrentProductStoreRecipePolicySource>["withCurrentResolution"]
>[0];
const fail = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};
/** Complete current Recipe contents come only from the owning reader, nested inside
 * actual Product/Store/Brand policy selection. No caller graph or publication DTO. */
export function createCurrentProductPublishedRecipeContentSource(
  options: BaseOptions & {
    readonly contentAuthority: CurrentPublishedRecipeContentOptions["authority"];
  },
) {
  const tenantReference = parseCatalogReference(options.tenantReference),
    brandReference = parseCatalogReference(options.brandReference),
    actorReference = parseCatalogReference(options.actorReference),
    base = createCurrentProductStoreRecipePolicySource(options),
    resolve = base.withCurrentResolution.bind(base),
    now = options.clock.now.bind(options.clock),
    hold = options.contentAuthority.holdUntilTransactionCompletes.bind(options.contentAuthority),
    active = new WeakSet<object>(),
    failed = new WeakSet<object>();
  return Object.freeze({
    async withCurrentContent<T>(
      tx: Tx,
      value: unknown,
      work: (content: CurrentProductPublishedRecipeContent) => Promise<T>,
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
        let selectedCalls = 0,
          contentCalls = 0,
          complete = false,
          answer: T | undefined;
        const source = createCurrentPublishedRecipeContentSource({
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
        const result = await resolve(tx, value, async (resolution) => {
          if (
            ++selectedCalls !== 1 ||
            resolution.recipe.decision !== "PassForDirectBrandAndStoreBindings"
          )
            return fail();
          const unique = new Map<string, { recipeReference: string; versionReference: string }>();
          for (const r of resolution.recipe.resolutions) {
            if (
              r.status !== "ResolvedStoredVersion" ||
              !r.recipeReference ||
              !r.recipeVersionReference
            )
              return fail();
            const previous = unique.get(r.recipeReference);
            if (previous && previous.versionReference !== r.recipeVersionReference) return fail();
            unique.set(r.recipeReference, {
              recipeReference: r.recipeReference,
              versionReference: r.recipeVersionReference,
            });
          }
          return source.withCurrentContent(
            {
              request: {
                purposeCode: "CATALOG_LIFECYCLE_RECIPE_SOURCE_READ",
                brandReference,
                actorReference,
                operationReference: resolution.recipe.operationReference,
                catalogIntentDigest: resolution.recipe.originalIntentDigest,
              },
              observedAt: resolution.originalObservedAt,
              validUntil: resolution.validUntil,
              activationAt: resolution.recipe.activationAt,
              recipeVersions: [...unique.values()],
            },
            async (content) => {
              if (++contentCalls !== 1) return fail();
              deadline = parseCatalogInstant(content.validUntil);
              check();
              const body = {
                profile: "CurrentProductPublishedRecipeContentV1" as const,
                selection: resolution,
                recipeContents: content,
                validUntil: content.validUntil,
                publishValidation: "Incomplete" as const,
                eligibility: "NotEvaluated" as const,
              };
              const current = Object.freeze({
                ...body,
                digest: "sha256:" + sha256Hex(canonicalizeRfc8785(body)),
              });
              answer = await work(current);
              complete = true;
              check();
              return answer;
            },
          );
        });
        if (selectedCalls !== 1 || contentCalls !== 1 || !complete || !Object.is(result, answer))
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
export interface CurrentProductPublishedRecipeContent {
  readonly profile: "CurrentProductPublishedRecipeContentV1";
  readonly selection: CurrentProductStoreRecipePolicy;
  readonly recipeContents: import("@rms/recipe").CurrentPublishedRecipeContent;
  readonly validUntil: string;
  readonly publishValidation: "Incomplete";
  readonly eligibility: "NotEvaluated";
  readonly digest: string;
}
