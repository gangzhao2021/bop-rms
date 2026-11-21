import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  CatalogError,
  bindCatalogProductValidationCandidate,
  copyCategoryPersistenceValue,
  createPostgresProductValidationCandidateSource,
  deriveCatalogProductCandidateRecipeTarget,
  parseCatalogInstant,
  parseCatalogReference,
  parseProductPublicationCommand,
  type CatalogCurrentProductValidationCandidate,
} from "@rms/catalog";
import {
  assessCurrentRecipeCatalogBindingScope,
  createPostgresRecipeReferenceSourceStore,
  parseRecipeReferenceSourceSnapshot,
} from "@rms/recipe";
type CandidateOptions = Parameters<typeof createPostgresProductValidationCandidateSource>[0];
type RecipeOptions = Parameters<typeof createPostgresRecipeReferenceSourceStore>[0];
type Tx = Parameters<CandidateOptions["authority"]["holdUntilTransactionCompletes"]>[0];
export type CurrentProductCandidateRecipeBindingScope = Readonly<{
  profile: "CurrentProductCandidateRecipeBindingScopeV1";
  tenantReference: string;
  brandReference: string;
  actorReference: string;
  productReference: string;
  versionReference: string;
  aggregateVersion: number;
  originalIntentDigest: string;
  contentDigest: string;
  configurationDigest: string;
  candidateObservedAt: string;
  candidateValidUntil: string;
  validUntil: string;
  recipe: ReturnType<typeof assessCurrentRecipeCatalogBindingScope>;
  sourceAuthority: "CurrentValidateCandidateAndRecipeStoredScope";
  completeContent: "Present";
  publishValidation: "Incomplete";
  eligibility: "NotEvaluated";
  digest: string;
}>;
const fail = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};
/** Actual Validate and owning current sources; no lifecycle transition, supplied
 * Draft DTO, Store resolution, or publication permission is synthesized here. */
export function createCurrentProductCandidateRecipeBindingScopeSource(options: {
  tenantReference: string;
  brandReference: string;
  actorReference: string;
  clock: CandidateOptions["clock"];
  candidateAuthority: CandidateOptions["authority"];
  categoryAssignments?: CandidateOptions["categoryAssignments"];
  recipeAuthority: RecipeOptions["authority"];
}) {
  if (
    typeof options.clock?.now !== "function" ||
    typeof options.candidateAuthority?.holdUntilTransactionCompletes !== "function" ||
    typeof options.recipeAuthority?.holdUntilTransactionCompletes !== "function" ||
    (options.categoryAssignments !== undefined &&
      typeof options.categoryAssignments.holdUntilTransactionCompletes !== "function")
  )
    return fail();
  const tenantReference = parseCatalogReference(options.tenantReference),
    brandReference = parseCatalogReference(options.brandReference),
    actorReference = parseCatalogReference(options.actorReference),
    now = options.clock.now.bind(options.clock),
    candidateHold = options.candidateAuthority.holdUntilTransactionCompletes.bind(
      options.candidateAuthority,
    ),
    recipeHold = options.recipeAuthority.holdUntilTransactionCompletes.bind(
      options.recipeAuthority,
    ),
    categoryHold = options.categoryAssignments?.holdUntilTransactionCompletes.bind(
      options.categoryAssignments,
    ),
    active = new WeakSet<object>(),
    failed = new WeakSet<object>();
  return Object.freeze({
    async withCurrentAssessment<T>(
      tx: Tx,
      value: unknown,
      work: (scope: CurrentProductCandidateRecipeBindingScope) => Promise<T>,
    ): Promise<T> {
      let entered = false;
      // The Recipe public holder sanitizes foreign callback errors. Retain only
      // this invocation's explicit trusted Catalog authority denial across it.
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
        const c = parseProductPublicationCommand(copyCategoryPersistenceValue(value));
        if (
          c.action !== "Validate" ||
          c.actorKind !== "User" ||
          c.tenantReference !== tenantReference ||
          c.brandReference !== brandReference ||
          c.actorReference !== actorReference
        )
          return fail();
        const query = tx.query,
          bound = query.bind(tx),
          activationAt = c.effectivePeriod.effectiveFrom.instant;
        let latest: string | undefined,
          until: string | undefined,
          candidateCalls = 0,
          recipeCalls = 0,
          finalCandidateCalls = 0,
          workCalls = 0,
          complete = false,
          answer: T | undefined;
        const check = () => {
          const at = parseCatalogInstant(now());
          if (
            failed.has(tx) ||
            tx.query !== query ||
            (latest !== undefined && at < latest) ||
            (until !== undefined && at >= until)
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
        const bridge = <I>(hold: (actual: Tx, input: I) => Promise<void>) => ({
          async holdUntilTransactionCompletes(actual: Tx, input: I) {
            if (actual !== facade) return fail();
            check();
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
                await candidateHold(actual, input);
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
          });
        const candidate = (raw: CatalogCurrentProductValidationCandidate, actual: Tx) => {
          if (actual !== facade) return fail();
          const copied = copyCategoryPersistenceValue(
              raw,
            ) as CatalogCurrentProductValidationCandidate,
            expected = bindCatalogProductValidationCandidate(
              c,
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
          if (until === undefined || expected.validUntil < until) until = expected.validUntil;
          check();
          return expected;
        };
        check();
        const result = await catalog.withCurrentCandidate(c, async (raw, actual) => {
          if (++candidateCalls !== 1) return fail();
          const initial = candidate(raw, actual),
            target = deriveCatalogProductCandidateRecipeTarget(
              c,
              initial.aggregate,
              initial.observedAt,
            ),
            request = {
              // Accepted source read purpose, distinct from Catalog's Validate mutation purpose.
              purposeCode: "CATALOG_LIFECYCLE_RECIPE_SOURCE_READ" as const,
              brandReference,
              actorReference,
              operationReference: c.operationReference,
              catalogIntentDigest: initial.originalIntentDigest,
            };
          return recipe.withCurrentSnapshot(request, async (rawSource) => {
            const source = parseRecipeReferenceSourceSnapshot(rawSource, request, check());
            if (
              ++recipeCalls !== 1 ||
              source.observedAt < initial.observedAt ||
              source.observedAt > check()
            )
              return fail();
            const deadline = parseCatalogInstant(
              new Date(Date.parse(source.observedAt) + 5000).toISOString(),
            );
            if (until === undefined || deadline < until) until = deadline;
            check();
            const assessed = assessCurrentRecipeCatalogBindingScope({
                request,
                target,
                source,
                now: check(),
                activationAt,
              }),
              body = {
                profile: "CurrentProductCandidateRecipeBindingScopeV1" as const,
                tenantReference,
                brandReference,
                actorReference,
                productReference: initial.aggregate.productReference,
                versionReference: initial.aggregate.draft.versionReference,
                aggregateVersion: initial.aggregate.aggregateVersion,
                originalIntentDigest: initial.originalIntentDigest,
                contentDigest: initial.contentDigest,
                configurationDigest: initial.configurationDigest,
                candidateObservedAt: initial.observedAt,
                candidateValidUntil: initial.validUntil,
                validUntil: until,
                recipe: assessed,
                sourceAuthority: "CurrentValidateCandidateAndRecipeStoredScope" as const,
                completeContent: "Present" as const,
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
            const finalResult = await catalog.withCurrentCandidate(
              c,
              async (rawCurrent, actualCurrent) => {
                if (++finalCandidateCalls !== 1) return fail();
                const current = candidate(rawCurrent, actualCurrent);
                if (
                  current.observedAt < initial.observedAt ||
                  canonicalizeRfc8785(current.aggregate) !==
                    canonicalizeRfc8785(initial.aggregate) ||
                  current.originalIntentDigest !== initial.originalIntentDigest ||
                  until === undefined ||
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
        if (
          candidateCalls !== 1 ||
          recipeCalls !== 1 ||
          finalCandidateCalls !== 1 ||
          workCalls !== 1 ||
          !complete ||
          !Object.is(result, answer)
        )
          return fail();
        check();
        return result;
      } catch (error) {
        if (tx && typeof tx === "object") failed.add(tx);
        if (candidateDenial !== undefined) throw candidateDenial;
        if (error instanceof CatalogError && error.code === "CATALOG_PERMISSION_DENIED")
          throw error;
        return fail();
      } finally {
        if (entered) active.delete(tx);
      }
    },
  });
}
