import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { readClosedRecord } from "@bop/identity";
import {
  CatalogError,
  parseCatalogReference,
  parseCatalogInstant,
  copyCategoryPersistenceValue,
  parseProductLifecycleReviewRequest,
  parseProductPricingBindingSourceSnapshot,
  createPostgresProductPricingBindingSourceStore,
} from "@rms/catalog";
import {
  createPostgresRecipeReferenceSourceStore,
  assessCurrentRecipeCatalogBindingScope,
} from "@rms/recipe";
type CatalogOptions = Parameters<typeof createPostgresProductPricingBindingSourceStore>[0];
type RecipeOptions = Parameters<typeof createPostgresRecipeReferenceSourceStore>[0];
type Tx = Parameters<CatalogOptions["authority"]["holdUntilTransactionCompletes"]>[0];
export type CurrentProductRecipeBindingScope = Readonly<{
  profile: "CurrentProductRecipeBindingScopeV1";
  tenantReference: string;
  recipe: ReturnType<typeof assessCurrentRecipeCatalogBindingScope>;
  originalObservedAt: string;
  validUntil: string;
  sourceAuthority: "CurrentProductDraftAndRecipeStoredScope";
  publishValidation: "Incomplete";
  eligibility: "NotEvaluated";
  digest: string;
}>;
const fail = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};
/** Same caller UoW, actual owning current Product Draft and Recipe source. Not
 * Store topology/executable resolution or full publish validation. */
export function createCurrentProductRecipeBindingScopeSource(options: {
  tenantReference: string;
  brandReference: string;
  actorReference: string;
  clock: CatalogOptions["clock"];
  catalogAuthority: CatalogOptions["authority"];
  recipeAuthority: RecipeOptions["authority"];
}) {
  const tenantReference = parseCatalogReference(options.tenantReference),
    brandReference = parseCatalogReference(options.brandReference),
    actorReference = parseCatalogReference(options.actorReference),
    now = options.clock.now.bind(options.clock),
    catalogHold = options.catalogAuthority.holdUntilTransactionCompletes.bind(
      options.catalogAuthority,
    ),
    recipeHold = options.recipeAuthority.holdUntilTransactionCompletes.bind(
      options.recipeAuthority,
    ),
    active = new WeakSet<object>(),
    failed = new WeakSet<object>();
  return Object.freeze({
    async withCurrentScope<T>(
      tx: Tx,
      value: unknown,
      work: (scope: CurrentProductRecipeBindingScope) => Promise<T>,
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
            "request",
            "observedAt",
            "validUntil",
            "activationAt",
          ]),
          request = parseProductLifecycleReviewRequest(input.request),
          originalObservedAt = parseCatalogInstant(input.observedAt),
          originalUntil = parseCatalogInstant(input.validUntil),
          activationAt = parseCatalogInstant(input.activationAt),
          query = tx.query,
          facade = Object.freeze({ query: query.bind(tx) });
        if (
          request.brandReference !== brandReference ||
          request.actorReference !== actorReference ||
          originalUntil <= originalObservedAt ||
          Date.parse(originalUntil) - Date.parse(originalObservedAt) > 30000 ||
          activationAt < originalObservedAt
        )
          return fail();
        let latest = originalObservedAt,
          until = originalUntil,
          catalogCalls = 0,
          finalCatalogCalls = 0,
          recipeCalls = 0,
          workCalls = 0,
          complete = false,
          answer: T | undefined;
        const check = () => {
          const at = parseCatalogInstant(now());
          if (failed.has(tx) || tx.query !== query || at < latest || at >= until) return fail();
          latest = at;
          return at;
        };
        const narrow = (observedAt: string) => {
          if (observedAt < originalObservedAt || observedAt > check()) return fail();
          const deadline = parseCatalogInstant(
            new Date(Date.parse(observedAt) + 5000).toISOString(),
          );
          if (deadline < until) until = deadline;
          check();
        };
        const bridge = <I>(hold: (actual: Tx, input: I) => Promise<void>) => ({
          async holdUntilTransactionCompletes(actual: Tx, input: I) {
            check();
            if (actual !== facade) return fail();
            await hold(tx, input);
            check();
          },
        });
        const common = {
          tenantReference,
          brandReference,
          actorReference,
          clock: { now: check },
          transactions: { run: <V>(action: (actual: Tx) => Promise<V>) => action(facade) },
        };
        const catalog = createPostgresProductPricingBindingSourceStore({
            ...common,
            authority: bridge(catalogHold),
          }),
          recipe = createPostgresRecipeReferenceSourceStore({
            ...common,
            authority: bridge(recipeHold),
          }),
          recipeRequest = {
            purposeCode: "CATALOG_LIFECYCLE_RECIPE_SOURCE_READ" as const,
            brandReference,
            actorReference,
            operationReference: request.operationReference,
            catalogIntentDigest: "sha256:" + sha256Hex(canonicalizeRfc8785(request)),
          };
        check();
        const result = await catalog.withCurrentSnapshot(request, async (raw) => {
          if (++catalogCalls !== 1) return fail();
          const initial = parseProductPricingBindingSourceSnapshot(raw, request, check());
          narrow(initial.observedAt);
          const target = {
            mappingProfile: "KnownDraftBindings" as const,
            catalogConfigurationDigest: initial.digest,
            productReference: request.productReference,
            versionReference: initial.versionReference,
            skuReference: request.skuReference,
            skuReferences: initial.skuReferences,
            bindings: initial.bindings.map((b) => ({
              bindingReference: b.bindingReference,
              enabledOptionReferences: b.enabledOptionReferences,
              includedSkuReferences: b.includedSkuReferences,
              excludedSkuReferences: b.excludedSkuReferences,
            })),
          };
          return recipe.withCurrentSnapshot(recipeRequest, async (source) => {
            if (++recipeCalls !== 1) return fail();
            narrow(source.observedAt);
            const assessed = assessCurrentRecipeCatalogBindingScope({
                request: recipeRequest,
                target,
                source,
                now: check(),
                activationAt,
              }),
              body = {
                profile: "CurrentProductRecipeBindingScopeV1" as const,
                tenantReference,
                recipe: assessed,
                originalObservedAt,
                validUntil: until,
                sourceAuthority: "CurrentProductDraftAndRecipeStoredScope" as const,
                publishValidation: "Incomplete" as const,
                eligibility: "NotEvaluated" as const,
              },
              scope = Object.freeze({
                ...body,
                digest: "sha256:" + sha256Hex(canonicalizeRfc8785(body)),
              });
            if (++workCalls !== 1) return fail();
            answer = await work(scope);
            complete = true;
            check();
            // The outer Catalog source fence was acquired first and remains held. Re-read
            // that same source after caller writes; a held barrier alone is insufficient.
            await catalog.withCurrentSnapshot(request, async (rawCurrent) => {
              if (++finalCatalogCalls !== 1) return fail();
              const current = parseProductPricingBindingSourceSnapshot(
                rawCurrent,
                request,
                check(),
              );
              narrow(current.observedAt);
              if (current.digest !== initial.digest || until < scope.validUntil) return fail();
            });
            check();
            return answer;
          });
        });
        if (
          catalogCalls !== 1 ||
          finalCatalogCalls !== 1 ||
          recipeCalls !== 1 ||
          workCalls !== 1 ||
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
