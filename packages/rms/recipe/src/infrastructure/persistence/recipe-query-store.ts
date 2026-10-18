import { parseRecipePublicationEvidence } from "../../domain/publication-review.js";
import {
  createRecipeSnapshot,
  parseRecipeReference,
  parseRecipeDigest,
} from "../../domain/recipe.js";
import { RecipeWorkflowError } from "../../application/recipe-service.js";
import type { RecipePorts } from "../../application/ports/recipe-ports.js";
export interface RecipeTransaction {
  readonly query: (sql: string, values: readonly unknown[]) => Promise<unknown>;
}
export interface RecipeTransactionRunner {
  readonly run: <T>(work: (tx: RecipeTransaction) => Promise<T>) => Promise<T>;
}
function fail(): never {
  throw new RecipeWorkflowError("RECIPE_DEPENDENCY_UNAVAILABLE");
}
function object(value: unknown): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return fail();
  const result: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") return fail();
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d?.enumerable || !("value" in d)) return fail();
    result[key] = d.value;
  }
  return result;
}
function row(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object") return fail();
  const descriptor = Object.getOwnPropertyDescriptor(value, "rows");
  if (
    !descriptor ||
    !("value" in descriptor) ||
    !Array.isArray(descriptor.value) ||
    descriptor.value.length > 1
  )
    return fail();
  const rows: unknown[] = descriptor.value;
  return rows.length === 0 ? null : object(rows[0]);
}
/** Scoped internal repository reads; callers must authorize before invoking. */
export function createPostgresRecipeQueryStore(
  runner: RecipeTransactionRunner,
  brandInput: string,
): Pick<RecipePorts["repository"], "load" | "resolveOperation" | "codeAvailable"> {
  const brand = parseRecipeReference(brandInput);
  async function run<T>(work: (tx: RecipeTransaction) => Promise<T>): Promise<T> {
    try {
      return await runner.run(async (tx) => {
        await tx.query("SELECT set_config('bop.brand_id',$1,true)", [brand]);
        return work(tx);
      });
    } catch {
      return fail();
    }
  }
  return Object.freeze({
    load: (reference) =>
      run(async (tx) => {
        const id = parseRecipeReference(reference);
        const found = row(
          await tx.query(
            "SELECT v.snapshot_json AS snapshot,r.aggregate_version AS version FROM rms_recipe.recipe r JOIN rms_recipe.recipe_version v ON v.recipe_id=r.recipe_id AND v.brand_id=r.brand_id AND v.recipe_version_id=r.current_version_id WHERE r.brand_id=$1 AND r.recipe_id=$2",
            [brand, id],
          ),
        );
        if (found === null) return null;
        const snapshot = createRecipeSnapshot(found.snapshot as never);
        if (
          snapshot.brandReference !== brand ||
          snapshot.recipeReference !== id ||
          snapshot.aggregateVersion !== found.version
        )
          return fail();
        return snapshot;
      }),
    resolveOperation: (reference) =>
      run(async (tx) => {
        const id = parseRecipeReference(reference);
        const found = row(
          await tx.query(
            "SELECT record_json AS record FROM rms_recipe.recipe_operation_record WHERE brand_id=$1 AND operation_id=$2",
            [brand, id],
          ),
        );
        if (found === null) return null;
        const record = object(found.record);
        if (Object.keys(record).length !== 7 || record.operationReference !== id) return fail();
        const aggregate = createRecipeSnapshot(record.aggregate as never);
        const event = object(record.event);
        const eventTypes = {
          CreateDraft: "RecipeDraftCreated",
          ReplaceDraft: "RecipeDraftReplaced",
          Publish: "RecipePublished",
          Invalidate: "RecipeInvalidated",
          Archive: "RecipeArchived",
        } as const;
        if (
          typeof record.action !== "string" ||
          !Object.hasOwn(eventTypes, record.action) ||
          aggregate.brandReference !== brand ||
          Object.keys(event).length !== 8 ||
          event.eventType !== eventTypes[record.action as keyof typeof eventTypes] ||
          event.recipeReference !== aggregate.recipeReference ||
          event.versionReference !== aggregate.versionReference ||
          event.brandReference !== brand ||
          event.aggregateVersion !== aggregate.aggregateVersion ||
          event.lifecycle !== aggregate.lifecycle ||
          event.snapshotDigest !== aggregate.snapshotDigest ||
          event.occurredAt !== aggregate.createdAt
        )
          return fail();
        if (record.action !== "Publish" && record.publicationEvidence !== null) return fail();
        const publicationEvidence =
          record.action === "Publish"
            ? parseRecipePublicationEvidence(record.publicationEvidence, aggregate)
            : null;
        return Object.freeze({
          publicationEvidence,
          action: record.action as keyof typeof eventTypes,
          operationReference: id,
          operationIntentHash: parseRecipeDigest(record.operationIntentHash),
          actorReference: parseRecipeReference(record.actorReference),
          aggregate,
          event: Object.freeze({
            eventType: eventTypes[record.action as keyof typeof eventTypes],
            recipeReference: aggregate.recipeReference,
            versionReference: aggregate.versionReference,
            brandReference: aggregate.brandReference,
            aggregateVersion: aggregate.aggregateVersion,
            lifecycle: aggregate.lifecycle,
            snapshotDigest: aggregate.snapshotDigest,
            occurredAt: aggregate.createdAt,
          }),
        });
      }),
    codeAvailable: (input) =>
      run(async (tx) => {
        if (input.brandReference !== brand) return fail();
        const found = row(
          await tx.query(
            "SELECT recipe_id FROM rms_recipe.recipe WHERE brand_id=$1 AND stable_code=$2 AND ($3::uuid IS NULL OR recipe_id<>$3::uuid)",
            [brand, input.stableCode, input.excludingRecipeReference],
          ),
        );
        return found === null;
      }),
  });
}
