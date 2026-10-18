import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  parseRecipeReference,
  createRecipeSnapshot,
  validateRecipeGraph,
  type RecipeSnapshot,
} from "../../domain/recipe.js";
import {
  parseRecipeReferenceSourceRequest,
  parseRecipeReferenceSourceInstant,
  type RecipeReferenceSourceRequest,
} from "../../contracts/recipe-reference-source.js";
import { RecipeWorkflowError } from "../../application/recipe-service.js";
import { createPostgresRecipeQueryStore } from "./recipe-query-store.js";
import type { RecipeReferenceTransaction } from "./recipe-reference-source-store.js";
export const currentPublishedRecipeDependencyGraphFields = Object.freeze([
  "Recipe.CurrentVersion",
  "Recipe.AggregateVersion",
  "Recipe.CompleteSnapshot",
  "Recipe.PinnedSubrecipeVersions",
  "Recipe.BatchYield",
  "Recipe.Ingredients",
  "Recipe.Steps",
  "Recipe.PublicationEvidence",
  "Recipe.CostReview",
  "Recipe.FoodSafetyReview",
] as const);
export interface CurrentPublishedRecipeDependencyGraphOptions {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly actorReference: string;
  readonly clock: { now(): string };
  readonly transactions: {
    run<T>(work: (tx: RecipeReferenceTransaction) => Promise<T>): Promise<T>;
  };
  readonly authority: {
    holdUntilTransactionCompletes(
      tx: RecipeReferenceTransaction,
      input: {
        readonly tenantReference: string;
        readonly request: RecipeReferenceSourceRequest;
        readonly permission: "recipe.manage";
        readonly requiredScope: "FullBrandScope";
        readonly requiredFields: typeof currentPublishedRecipeDependencyGraphFields;
        readonly observedAt: string;
      },
    ): Promise<void>;
  };
}
const fail = (): never => {
  throw new RecipeWorkflowError("RECIPE_DEPENDENCY_UNAVAILABLE");
};
function record(value: unknown, fields: readonly string[]) {
  if (
    !value ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== fields.length
  )
    return fail();
  const result: Record<string, unknown> = {};
  for (const key of fields) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d?.enumerable || !("value" in d)) return fail();
    result[key] = d.value;
  }
  return result;
}
function list(value: unknown, max: number): readonly unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > max ||
    Reflect.ownKeys(value).length !== value.length + 1
  )
    return fail();
  const copied: unknown[] = [];
  for (let i = 0; i < value.length; i++) {
    const d = Object.getOwnPropertyDescriptor(value, String(i));
    if (!d?.enumerable || !("value" in d)) return fail();
    copied.push(d.value);
  }
  return copied;
}
function rows(value: unknown, max: number) {
  if (!value || typeof value !== "object") return fail();
  return list(Object.getOwnPropertyDescriptor(value, "rows")?.value, max);
}
interface PublishedRecipeDependencyGraph<
  P extends "CurrentPublishedRecipeDependencyGraphV1" | "PinnedPublishedRecipeDependencyGraphV1",
> {
  readonly profile: P;
  readonly tenantReference: string;
  readonly request: RecipeReferenceSourceRequest;
  readonly observedAt: string;
  readonly validUntil: string;
  readonly activationAt: string;
  readonly contents: readonly {
    readonly snapshot: RecipeSnapshot;
    readonly currentRootVersionReference: string;
    readonly currentRootAggregateVersion: number;
    readonly currentRootLifecycle: string;
    readonly publicationOperationReference: string;
    readonly publicationEvidenceDigest: string;
  }[];
  readonly rootVersionReferences: readonly string[];
  readonly subrecipeGraph: "PassForPinnedPublishedSubrecipes";
  readonly inventoryReferences: "NotEvaluated";
  readonly unitsAndConversions: "NotEvaluated";
  readonly publishValidation: "Incomplete";
  readonly eligibility: "NotEvaluated";
  readonly digest: string;
}
export type CurrentPublishedRecipeDependencyGraph =
  PublishedRecipeDependencyGraph<"CurrentPublishedRecipeDependencyGraphV1">;
export type PinnedPublishedRecipeDependencyGraph =
  PublishedRecipeDependencyGraph<"PinnedPublishedRecipeDependencyGraphV1">;
/** Current roots and exact pinned historical children with physical publication proof.
 * Newer owning root versions never replace a pinned child. Not complete publish readiness.
 * Bind the runner to the original caller UoW after Product/reference/Store policy holders. */
export function createCurrentPublishedRecipeDependencyGraphSource(
  options: CurrentPublishedRecipeDependencyGraphOptions,
) {
  return createPublishedGraphSource(options, "CurrentPublishedRecipeDependencyGraphV1", true);
}
/** Exact Published pins for a new parent candidate. Never replaces a pin with a newer current Draft. */
export function createPinnedPublishedRecipeDependencyGraphSource(
  options: CurrentPublishedRecipeDependencyGraphOptions,
) {
  return createPublishedGraphSource(options, "PinnedPublishedRecipeDependencyGraphV1", false);
}
function createPublishedGraphSource<
  P extends "CurrentPublishedRecipeDependencyGraphV1" | "PinnedPublishedRecipeDependencyGraphV1",
>(options: CurrentPublishedRecipeDependencyGraphOptions, profile: P, currentRoots: boolean) {
  const tenant = parseRecipeReference(options.tenantReference),
    brand = parseRecipeReference(options.brandReference),
    actor = parseRecipeReference(options.actorReference),
    now = options.clock.now.bind(options.clock),
    run = options.transactions.run.bind(options.transactions),
    hold = options.authority.holdUntilTransactionCompletes.bind(options.authority);
  const active = new WeakSet<object>(),
    failed = new WeakSet<object>();
  return Object.freeze({
    async withCurrentGraph<T>(
      value: unknown,
      work: (content: PublishedRecipeDependencyGraph<P>) => Promise<T>,
    ): Promise<T> {
      try {
        const input = record(value, [
            "request",
            "observedAt",
            "validUntil",
            "activationAt",
            "recipeVersions",
          ]),
          request = parseRecipeReferenceSourceRequest(input.request),
          observedAt = parseRecipeReferenceSourceInstant(input.observedAt),
          originalUntil = parseRecipeReferenceSourceInstant(input.validUntil),
          activationAt = parseRecipeReferenceSourceInstant(input.activationAt);
        const selected = list(input.recipeVersions, 256)
          .map((v) => {
            const r = record(v, ["recipeReference", "versionReference"]);
            return Object.freeze({
              recipeReference: parseRecipeReference(r.recipeReference),
              versionReference: parseRecipeReference(r.versionReference),
            });
          })
          .sort(
            (a, b) =>
              a.recipeReference.localeCompare(b.recipeReference) ||
              a.versionReference.localeCompare(b.versionReference),
          );
        if (
          typeof work !== "function" ||
          request.brandReference !== brand ||
          request.actorReference !== actor ||
          originalUntil <= observedAt ||
          Date.parse(originalUntil) - Date.parse(observedAt) > 30000 ||
          activationAt < observedAt ||
          selected.length === 0 ||
          new Set(
            selected.map((s) =>
              currentRoots ? s.recipeReference : s.recipeReference + ":" + s.versionReference,
            ),
          ).size !== selected.length
        )
          return fail();
        let calls = 0,
          complete: { readonly answer: T } | undefined;
        const result = await run(async (tx) => {
          if (++calls !== 1 || active.has(tx) || failed.has(tx)) {
            failed.add(tx);
            return fail();
          }
          active.add(tx);
          try {
            const query = tx.query,
              facade = Object.freeze({ query: query.bind(tx) });
            let latest = observedAt;
            let validUntil = new Date(
              Math.min(Date.parse(originalUntil), Date.parse(observedAt) + 5000),
            ).toISOString();
            const check = () => {
              const at = parseRecipeReferenceSourceInstant(now());
              if (failed.has(tx) || tx.query !== query || at < latest || at >= validUntil)
                return fail();
              latest = at;
              return at;
            };
            const authorize = async () => {
              check();
              await hold(
                tx,
                Object.freeze({
                  tenantReference: tenant,
                  request,
                  permission: "recipe.manage",
                  requiredScope: "FullBrandScope",
                  requiredFields: currentPublishedRecipeDependencyGraphFields,
                  observedAt: check(),
                }),
              );
              check();
            };
            await authorize();
            const isolation = rows(
              await facade.query(
                "SELECT current_setting('transaction_isolation') AS isolation",
                [],
              ),
              1,
            );
            if (
              isolation.length !== 1 ||
              record(isolation[0], ["isolation"]).isolation !== "read committed"
            )
              return fail();
            await facade.query(
              "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id','',true)",
              [brand],
            );
            await facade.query("SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))", [
              "RecipeCatalogReferenceV1:" + brand,
            ]);
            const repository = createPostgresRecipeQueryStore(
              { run: (action) => action(facade) },
              brand,
            );
            const read = async () => {
              const contents: CurrentPublishedRecipeDependencyGraph["contents"][number][] = [];
              const queue = selected.map((s) => ({ ...s, depth: 0, root: currentRoots }));
              const seen = new Map<string, string>();
              let requirements = 0;
              for (const s of queue) {
                const previous = seen.get(s.versionReference);
                if (previous !== undefined) {
                  if (previous !== s.recipeReference) return fail();
                  continue;
                }
                if (seen.size >= 256 || s.depth > 16) return fail();
                seen.set(s.versionReference, s.recipeReference);
                check();
                const currentRoot = await repository.load(s.recipeReference);
                if (
                  !currentRoot ||
                  currentRoot.createdAt > observedAt ||
                  currentRoot.lifecycle === "Archived" ||
                  currentRoot.lifecycle === "Invalidated"
                )
                  return fail();
                if (
                  s.root &&
                  (currentRoot.versionReference !== s.versionReference ||
                    currentRoot.lifecycle !== "Published")
                )
                  return fail();
                const physical = rows(
                  await facade.query(
                    "SELECT snapshot_json AS snapshot,created_at=date_trunc('milliseconds',created_at) AS precise FROM rms_recipe.recipe_version WHERE brand_id=$1 AND recipe_id=$2 AND recipe_version_id=$3",
                    [brand, s.recipeReference, s.versionReference],
                  ),
                  1,
                );
                if (physical.length !== 1) return fail();
                const stored = record(physical[0], ["snapshot", "precise"]);
                if (stored.precise !== true) return fail();
                const snapshot = createRecipeSnapshot(stored.snapshot as RecipeSnapshot);
                if (
                  snapshot.recipeReference !== s.recipeReference ||
                  snapshot.versionReference !== s.versionReference ||
                  snapshot.brandReference !== brand ||
                  snapshot.lifecycle !== "Published" ||
                  (s.root && canonicalizeRfc8785(snapshot) !== canonicalizeRfc8785(currentRoot)) ||
                  snapshot.createdAt > observedAt ||
                  snapshot.effectivePeriod.effectiveFrom.instant > observedAt ||
                  snapshot.effectivePeriod.effectiveFrom.instant > activationAt ||
                  (snapshot.effectivePeriod.effectiveUntil !== null &&
                    (observedAt >= snapshot.effectivePeriod.effectiveUntil.instant ||
                      activationAt >= snapshot.effectivePeriod.effectiveUntil.instant))
                )
                  return fail();
                requirements += snapshot.ingredients.length;
                if (requirements > 4096) return fail();
                for (const ingredient of snapshot.ingredients)
                  if (ingredient.sourceKind === "SubRecipe")
                    queue.push({
                      recipeReference: ingredient.sourceReference,
                      versionReference: ingredient.sourceVersionReference,
                      depth: s.depth + 1,
                      root: false,
                    });
                if (
                  snapshot.effectivePeriod.effectiveUntil !== null &&
                  snapshot.effectivePeriod.effectiveUntil.instant < validUntil
                )
                  validUntil = snapshot.effectivePeriod.effectiveUntil.instant;
                check();
                const found = rows(
                  await facade.query(
                    "SELECT operation_id AS operation FROM rms_recipe.recipe_operation_record WHERE brand_id=$1 AND recipe_id=$2 AND result_version_id=$3 AND action_code='Publish' ORDER BY operation_id LIMIT 2",
                    [brand, s.recipeReference, s.versionReference],
                  ),
                  2,
                );
                if (found.length !== 1) return fail();
                const operation = parseRecipeReference(record(found[0], ["operation"]).operation),
                  publication = await repository.resolveOperation(operation);
                if (
                  !publication ||
                  publication.action !== "Publish" ||
                  !publication.publicationEvidence ||
                  canonicalizeRfc8785(publication.aggregate) !== canonicalizeRfc8785(snapshot)
                )
                  return fail();
                const reviews = rows(
                  await facade.query(
                    `SELECT review_id AS "reviewReference",review_kind AS "reviewKind",reviewer_actor_id AS "reviewerActorReference",evidence_digest AS "evidenceDigest",decision,to_char(reviewed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "reviewedAt",reviewed_at=date_trunc('milliseconds',reviewed_at) AS precise FROM rms_recipe.recipe_review_record WHERE brand_id=$1 AND recipe_id=$2 AND recipe_version_id=$3 ORDER BY review_kind LIMIT 3`,
                    [brand, s.recipeReference, s.versionReference],
                  ),
                  3,
                ).map((v) => {
                  const r = record(v, [
                    "reviewReference",
                    "reviewKind",
                    "reviewerActorReference",
                    "evidenceDigest",
                    "decision",
                    "reviewedAt",
                    "precise",
                  ]);
                  if (r.precise !== true) return fail();
                  return Object.fromEntries(Object.entries(r).filter(([key]) => key !== "precise"));
                });
                const expected = [...publication.publicationEvidence.reviews].sort((a, b) =>
                  a.reviewKind.localeCompare(b.reviewKind),
                );
                if (
                  reviews.length !== 2 ||
                  canonicalizeRfc8785(reviews) !== canonicalizeRfc8785(expected)
                )
                  return fail();
                contents.push(
                  Object.freeze({
                    snapshot,
                    currentRootVersionReference: currentRoot.versionReference,
                    currentRootAggregateVersion: currentRoot.aggregateVersion,
                    currentRootLifecycle: currentRoot.lifecycle,
                    publicationOperationReference: operation,
                    publicationEvidenceDigest:
                      "sha256:" + sha256Hex(canonicalizeRfc8785(publication.publicationEvidence)),
                  }),
                );
              }
              check();
              const snapshots = contents.map((c) => c.snapshot);
              const versions = new Map(snapshots.map((s) => [s.versionReference, s]));
              for (const s of snapshots)
                for (const ingredient of s.ingredients)
                  if (ingredient.sourceKind === "SubRecipe") {
                    const child = versions.get(ingredient.sourceVersionReference);
                    if (
                      !child ||
                      child.recipeReference !== ingredient.sourceReference ||
                      child.yieldDimension !== ingredient.unitDimension
                    )
                      return fail();
                  }
              for (const root of selected) {
                const snapshot = versions.get(root.versionReference);
                if (!snapshot) return fail();
                validateRecipeGraph(
                  snapshot,
                  snapshots.filter((s) => s.versionReference !== root.versionReference),
                );
              }
              return Object.freeze(
                contents.sort((a, b) =>
                  a.snapshot.versionReference.localeCompare(b.snapshot.versionReference),
                ),
              );
            };
            const contents = await read();
            await authorize();
            const body = {
              profile,
              tenantReference: tenant,
              request,
              observedAt,
              validUntil,
              activationAt,
              contents,
              rootVersionReferences: Object.freeze(selected.map((s) => s.versionReference)),
              subrecipeGraph: "PassForPinnedPublishedSubrecipes" as const,
              inventoryReferences: "NotEvaluated" as const,
              unitsAndConversions: "NotEvaluated" as const,
              publishValidation: "Incomplete" as const,
              eligibility: "NotEvaluated" as const,
            };
            const content = Object.freeze({
              ...body,
              digest: "sha256:" + sha256Hex(canonicalizeRfc8785(body)),
            });
            complete = Object.freeze({ answer: await work(content) });
            await authorize();
            if (canonicalizeRfc8785(await read()) !== canonicalizeRfc8785(contents)) return fail();
            await authorize();
            check();
            return complete;
          } catch (error) {
            failed.add(tx);
            throw error;
          } finally {
            active.delete(tx);
          }
        });
        if (!complete || result !== complete || calls !== 1) return fail();
        return complete.answer;
      } catch {
        return fail();
      }
    },
  });
}
