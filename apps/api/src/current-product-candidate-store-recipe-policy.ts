import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { readClosedRecord } from "@bop/identity";
import {
  CatalogError,
  parseCatalogReference,
  parseCatalogInstant,
  copyCategoryPersistenceValue,
  parseProductPublicationCommand,
  bindCatalogProductValidationCandidate,
  deriveCatalogProductCandidateRecipeTarget,
  createPostgresProductValidationCandidateSource,
  type CatalogCurrentProductValidationCandidate,
} from "@rms/catalog";
import {
  createPostgresRecipeReferenceSourceStore,
  resolveCurrentStoreRecipeVersions,
} from "@rms/recipe";
import {
  createPostgresTenantStoreReferenceSource,
  type TenantStoreReferenceSourceOptions,
  createPostgresTenantBrandConfigurationContentSource,
  type TenantBrandConfigurationContentSourceOptions,
  parseTenantBrandConfigurationContentRequest,
} from "@bop/tenant";
import { createCurrentBrandConfigurationContentSource } from "./current-brand-configuration-content.js";
type CatalogOptions = Parameters<typeof createPostgresProductValidationCandidateSource>[0];
type RecipeOptions = Parameters<typeof createPostgresRecipeReferenceSourceStore>[0];
type Tx = Parameters<CatalogOptions["authority"]["holdUntilTransactionCompletes"]>[0];
export type CurrentProductCandidateStoreRecipePolicy = Readonly<{
  profile: "CurrentProductCandidateStoreRecipePolicyV1";
  tenantReference: string;
  productReference: string;
  versionReference: string;
  aggregateVersion: number;
  contentDigest: string;
  configurationDigest: string;
  originalIntentDigest: string;
  candidateValidUntil: string;
  recipe: ReturnType<typeof resolveCurrentStoreRecipeVersions>;
  originalObservedAt: string;
  validUntil: string;
  sourceAuthority: "CurrentValidateCandidateRecipeStoreAndPublishedBrandPolicy";
  publishValidation: "Incomplete";
  eligibility: "NotEvaluated";
  digest: string;
}>;
const fail = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};
/** Current owning Brand content and Publishing release authorize whole Store overrides.
 * All held sources and final rereads share the original caller UoW. */
export function createCurrentProductCandidateStoreRecipePolicySource(options: {
  tenantReference: string;
  brandReference: string;
  actorReference: string;
  clock: CatalogOptions["clock"];
  candidateAuthority: CatalogOptions["authority"];
  categoryAssignments?: CatalogOptions["categoryAssignments"];
  recipeAuthority: RecipeOptions["authority"];
  storeAuthority: TenantStoreReferenceSourceOptions["authority"];
  brandAuthority: TenantBrandConfigurationContentSourceOptions["authority"];
}) {
  if (
    typeof options.clock?.now !== "function" ||
    typeof options.candidateAuthority?.holdUntilTransactionCompletes !== "function" ||
    typeof options.recipeAuthority?.holdUntilTransactionCompletes !== "function" ||
    typeof options.storeAuthority?.withCurrentBrandReferenceRead !== "function" ||
    typeof options.storeAuthority?.isCurrent !== "function" ||
    typeof options.brandAuthority?.withCurrentContentRead !== "function" ||
    typeof options.brandAuthority?.isCurrent !== "function" ||
    (options.categoryAssignments !== undefined &&
      typeof options.categoryAssignments.holdUntilTransactionCompletes !== "function")
  )
    return fail();
  const tenantReference = parseCatalogReference(options.tenantReference),
    brandReference = parseCatalogReference(options.brandReference),
    actorReference = parseCatalogReference(options.actorReference),
    now = options.clock.now.bind(options.clock),
    catalogHold = options.candidateAuthority.holdUntilTransactionCompletes.bind(
      options.candidateAuthority,
    ),
    recipeHold = options.recipeAuthority.holdUntilTransactionCompletes.bind(
      options.recipeAuthority,
    ),
    storeHold = options.storeAuthority.withCurrentBrandReferenceRead.bind(options.storeAuthority),
    storeCurrent = options.storeAuthority.isCurrent.bind(options.storeAuthority),
    brandHold = options.brandAuthority.withCurrentContentRead.bind(options.brandAuthority),
    brandCurrent = options.brandAuthority.isCurrent.bind(options.brandAuthority),
    categoryHold = options.categoryAssignments?.holdUntilTransactionCompletes.bind(
      options.categoryAssignments,
    ),
    active = new WeakSet<object>(),
    failed = new WeakSet<object>();
  return Object.freeze({
    async withCurrentResolution<T>(
      tx: Tx,
      value: unknown,
      work: (scope: CurrentProductCandidateStoreRecipePolicy) => Promise<T>,
    ): Promise<T> {
      let entered = false;
      let candidateDenial: CatalogError | undefined;
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
            "command",
            "storeReference",
            "configurationVersionReference",
            "expectedBrandVersion",
          ]),
          request = parseProductPublicationCommand(input.command),
          activationAt = request.effectivePeriod.effectiveFrom.instant,
          storeReference = parseCatalogReference(input.storeReference),
          query = tx.query,
          bound = query.bind(tx);
        if (
          request.action !== "Validate" ||
          request.actorKind !== "User" ||
          request.tenantReference !== tenantReference ||
          request.brandReference !== brandReference ||
          request.actorReference !== actorReference ||
          !request.scopeSet.some(
            (s) =>
              s.channelCodes.length === 0 &&
              s.orderTypeCodes.length === 0 &&
              (s.level === "Brand" || (s.level === "Store" && s.reference === storeReference)),
          )
        )
          return fail();
        let originalObservedAt = parseCatalogInstant(now());
        const originalUntil = parseCatalogInstant(
          new Date(Date.parse(originalObservedAt) + 30000).toISOString(),
        );
        let latest = originalObservedAt,
          until = originalUntil,
          catalogCalls = 0,
          finalCatalogCalls = 0,
          recipeCalls = 0,
          storeCalls = 0,
          storeAuthorityCalls = 0,
          brandAuthorityCalls = 0,
          brandCalls = 0,
          finalBrandCalls = 0,
          workCalls = 0,
          complete = false,
          answer: T | undefined;
        const check = () => {
          const at = parseCatalogInstant(now());
          if (failed.has(tx) || tx.query !== query || at < latest || at >= until) return fail();
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
        const candidate = (raw: CatalogCurrentProductValidationCandidate, actual: Tx) => {
          if (actual !== facade) return fail();
          const copied = copyCategoryPersistenceValue(
              raw,
            ) as CatalogCurrentProductValidationCandidate,
            expected = bindCatalogProductValidationCandidate(
              request,
              copied.aggregate,
              copied.observedAt,
            );
          const { internalCodeCheck, ...content } = copied;
          if (
            !internalCodeCheck ||
            typeof internalCodeCheck !== "object" ||
            Array.isArray(internalCodeCheck) ||
            Object.keys(internalCodeCheck).length !== 2 ||
            internalCodeCheck.code !== "InternalCode" ||
            !["Pass", "HardError"].includes(internalCodeCheck.outcome) ||
            canonicalizeRfc8785(content) !== canonicalizeRfc8785(expected) ||
            expected.completeContent !== "Present" ||
            expected.observedAt > check()
          )
            return fail();
          if (expected.validUntil < until) until = expected.validUntil;
          check();
          return expected;
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
        const catalog = createPostgresProductValidationCandidateSource({
            ...common,
            authority: bridge(async (actual, input) => {
              try {
                await catalogHold(actual, input);
              } catch (error) {
                if (error instanceof CatalogError && error.code === "CATALOG_PERMISSION_DENIED")
                  candidateDenial = error;
                throw error;
              }
            }),
            ...(categoryHold === undefined ? {} : { categoryAssignments: bridge(categoryHold) }),
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
        const stores = createPostgresTenantStoreReferenceSource({
          brandReference,
          transactions: common.transactions,
          authority: {
            async withCurrentBrandReferenceRead(r, action) {
              if (++storeAuthorityCalls !== 1) return fail();
              check();
              let calls = 0,
                done = false,
                answer: unknown;
              const result = await storeHold(r, async () => {
                if (++calls !== 1) return fail();
                check();
                answer = await action();
                done = true;
                check();
                return answer;
              });
              if (calls !== 1 || !done || !Object.is(result, answer)) return fail();
              check();
              return result as Awaited<ReturnType<typeof action>>;
            },
            async isCurrent(actual, r) {
              check();
              if (actual !== facade) return fail();
              const result = await storeCurrent(tx, r);
              check();
              return result === true;
            },
          },
        });
        const brand = createCurrentBrandConfigurationContentSource(
          createPostgresTenantBrandConfigurationContentSource({
            brandReference,
            clock: check,
            transactions: common.transactions,
            authority: {
              async withCurrentContentRead(r, fields, action) {
                if (++brandAuthorityCalls > 2) return fail();
                check();
                let calls = 0,
                  done = false,
                  answer: unknown;
                const result = await brandHold(r, fields, async () => {
                  if (++calls !== 1) return fail();
                  check();
                  answer = await action();
                  done = true;
                  check();
                  return answer;
                });
                if (calls !== 1 || !done || !Object.is(result, answer)) return fail();
                check();
                return result as Awaited<ReturnType<typeof action>>;
              },
              async isCurrent(actual, r, fields) {
                check();
                if (actual !== facade) return fail();
                const result = await brandCurrent(tx, r, fields);
                check();
                return result === true;
              },
            },
          }),
        );
        check();
        const result = await catalog.withCurrentCandidate(request, async (raw, actual) => {
          if (++catalogCalls !== 1) return fail();
          const initial = candidate(raw, actual);
          originalObservedAt = initial.observedAt;
          const target = deriveCatalogProductCandidateRecipeTarget(
              request,
              initial.aggregate,
              initial.observedAt,
            ),
            brandRequest = parseTenantBrandConfigurationContentRequest({
              tenantReference,
              brandReference,
              actorReference,
              purposeCode: "CATALOG_PRODUCT_CONTENT",
              configurationVersionReference: input.configurationVersionReference,
              expectedBrandVersion: input.expectedBrandVersion,
              originalIntentDigest: initial.originalIntentDigest,
              observedAt: initial.observedAt,
              validUntil: until,
            });
          return stores.withCurrentSnapshot(
            {
              brandReference,
              actorReference,
              purposeCode: "CATALOG_PRODUCT_RECIPE_STORE_RESOLUTION",
              originalIntentDigest: recipeRequest.catalogIntentDigest,
              observedAt: check(),
            },
            async (registered) => {
              if (++storeCalls !== 1) return fail();
              narrow(registered.observedAt);
              return recipe.withCurrentSnapshot(recipeRequest, async (source) => {
                if (++recipeCalls !== 1) return fail();
                narrow(source.observedAt);
                return brand.withCurrentContent(brandRequest, async (content, actual) => {
                  if (++brandCalls !== 1 || actual !== facade) return fail();
                  if (content.validUntil < until) until = parseCatalogInstant(content.validUntil);
                  check();
                  const overridePolicy = Object.freeze({
                    profile: "CurrentRecipeStoreOverridePolicyV1" as const,
                    brandReference: content.brandReference,
                    configurationVersionReference: content.configurationVersionReference,
                    currentPublicationReference: content.currentPublicationReference,
                    contentDigest: content.contentDigest,
                    originalIntentDigest: content.originalIntentDigest,
                    observedAt: content.observedAt,
                    validUntil: until,
                    effectiveFrom: content.effectiveFrom,
                    effectiveUntil: content.effectiveUntil,
                    storeRecipeOverrideAllowed:
                      content.overrideAllowedFieldCodes.includes("RECIPE.VERSION") &&
                      !content.hardRequirementFieldCodes.includes("RECIPE.VERSION"),
                  });
                  const assessed = resolveCurrentStoreRecipeVersions({
                      request: recipeRequest,
                      target,
                      source,
                      now: check(),
                      activationAt,
                      stores: registered,
                      storeReference,
                      overridePolicy,
                    }),
                    body = {
                      profile: "CurrentProductCandidateStoreRecipePolicyV1" as const,
                      tenantReference,
                      productReference: initial.aggregate.productReference,
                      versionReference: initial.aggregate.draft.versionReference,
                      aggregateVersion: initial.aggregate.aggregateVersion,
                      contentDigest: initial.contentDigest,
                      configurationDigest: initial.configurationDigest,
                      originalIntentDigest: initial.originalIntentDigest,
                      candidateValidUntil: initial.validUntil,
                      recipe: assessed,
                      originalObservedAt,
                      validUntil: until,
                      sourceAuthority:
                        "CurrentValidateCandidateRecipeStoreAndPublishedBrandPolicy" as const,
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
                  // Retain the same immutable selector and original window. Held SHARE fences
                  // block competing transactions, but only this reread detects caller-UoW changes.
                  await brand.withCurrentContent(brandRequest, async (current, actualCurrent) => {
                    if (
                      ++finalBrandCalls !== 1 ||
                      actualCurrent !== facade ||
                      canonicalizeRfc8785(current) !== canonicalizeRfc8785(content)
                    )
                      return fail();
                    if (current.validUntil < until) until = parseCatalogInstant(current.validUntil);
                    if (until < scope.validUntil) return fail();
                    check();
                  });
                  // The outer Catalog source fence was acquired first and remains held. Re-read
                  // that same source after caller writes; a held barrier alone is insufficient.
                  const finalResult = await catalog.withCurrentCandidate(
                    request,
                    async (rawCurrent, actualCurrent) => {
                      if (++finalCatalogCalls !== 1) return fail();
                      const current = candidate(rawCurrent, actualCurrent);
                      if (
                        current.observedAt < initial.observedAt ||
                        canonicalizeRfc8785(current.aggregate) !==
                          canonicalizeRfc8785(initial.aggregate) ||
                        current.originalIntentDigest !== initial.originalIntentDigest ||
                        until < scope.validUntil
                      )
                        return fail();
                      check();
                    },
                  );
                  if (finalResult !== undefined) return fail();
                  check();
                  return answer;
                });
              });
            },
          );
        });
        if (
          catalogCalls !== 1 ||
          finalCatalogCalls !== 1 ||
          recipeCalls !== 1 ||
          storeCalls !== 1 ||
          storeAuthorityCalls !== 1 ||
          brandAuthorityCalls !== 2 ||
          brandCalls !== 1 ||
          finalBrandCalls !== 1 ||
          workCalls !== 1 ||
          !complete ||
          !Object.is(result, answer)
        )
          return fail();
        check();
        return result;
      } catch {
        if (tx && typeof tx === "object") failed.add(tx);
        if (candidateDenial !== undefined) throw candidateDenial;
        return fail();
      } finally {
        if (entered) active.delete(tx);
      }
    },
  });
}
