import { canonicalizeRfc8785 } from "@bop/audit";
import { requireRecipeMeasurementContentDigest } from "../../contracts/recipe-measurement-content-digest.js";
import type { RecipeMeasurementContentV2 } from "../../domain/recipe-measurement-content.js";
import {
  createRecipeSnapshot,
  parseRecipeReference,
  type RecipeSnapshot,
} from "../../domain/recipe.js";
import { RecipeWorkflowError } from "../../application/recipe-service.js";
import type { RecipePorts, RecipeOperationRecord } from "../../application/ports/recipe-ports.js";
import { createPostgresRecipeStore } from "./recipe-store.js";
import type { RecipeTransaction, RecipeTransactionRunner } from "./recipe-query-store.js";
const fail = (): never => {
  throw new RecipeWorkflowError("RECIPE_DEPENDENCY_UNAVAILABLE");
};
function rows(value: unknown): readonly Record<string, unknown>[] {
  if (!value || typeof value !== "object") return fail();
  const d = Object.getOwnPropertyDescriptor(value, "rows");
  if (!d || !("value" in d) || !Array.isArray(d.value)) return fail();
  return d.value;
}
/** Owning draft repository. Same original Tx as existing CAS/Audit/Outbox writer.
 * This scoped durable read is not a held current publication/units source. */
export function createPostgresRecipeMeasurementDraftStore(
  runner: RecipeTransactionRunner,
  brandInput: string,
  generateReference: () => string,
  contentInput: unknown,
): RecipePorts["repository"] & {
  resolveMeasurementOperation(operation: string): Promise<{
    readonly record: RecipeOperationRecord;
    readonly content: RecipeMeasurementContentV2;
  } | null>;
} {
  return createMeasurementStore(runner, brandInput, generateReference, contentInput, "Draft");
}
/** Owning Published V2 writer, called only after current source qualification by the composition root.
 * Native Recipe service remains responsible for independent review, authorization and CAS. */
export function createPostgresRecipeMeasurementPublicationStore(
  runner: RecipeTransactionRunner,
  brandInput: string,
  generateReference: () => string,
  contentInput: unknown,
) {
  return createMeasurementStore(runner, brandInput, generateReference, contentInput, "Published");
}
function createMeasurementStore(
  runner: RecipeTransactionRunner,
  brandInput: string,
  generateReference: () => string,
  contentInput: unknown,
  lifecycle: "Draft" | "Published",
): RecipePorts["repository"] & {
  resolveMeasurementOperation(operation: string): Promise<{
    readonly record: RecipeOperationRecord;
    readonly content: RecipeMeasurementContentV2;
  } | null>;
} {
  const brand = parseRecipeReference(brandInput),
    content = requireRecipeMeasurementContentDigest(contentInput),
    run = runner.run.bind(runner),
    active = new WeakSet<object>(),
    failed = new WeakSet<object>();
  if (content.snapshot.brandReference !== brand || content.snapshot.lifecycle !== lifecycle)
    return fail();
  async function transaction<T>(work: (tx: RecipeTransaction) => Promise<T>): Promise<T> {
    let calls = 0,
      complete = false,
      answer: T | undefined,
      original: RecipeTransaction | undefined;
    let result: T;
    try {
      result = await run(async (tx) => {
        original = tx;
        if (++calls !== 1 || active.has(tx) || failed.has(tx)) {
          failed.add(tx);
          return fail();
        }
        active.add(tx);
        const query = tx.query;
        const check = () => {
          if (tx.query !== query || failed.has(tx)) return fail();
        };
        const facade = Object.freeze({
          query: async (sql: string, values: readonly unknown[]) => {
            check();
            const result = await query.call(tx, sql, values);
            check();
            return result;
          },
        });
        try {
          answer = await work(facade);
          complete = true;
          check();
          return answer;
        } catch (error) {
          failed.add(tx);
          if (error instanceof RecipeWorkflowError) throw error;
          return fail();
        } finally {
          active.delete(tx);
        }
      });
    } catch (error) {
      if (original) failed.add(original);
      if (error instanceof RecipeWorkflowError) throw error;
      return fail();
    }
    if (calls !== 1 || !complete || !Object.is(result, answer)) {
      if (original) failed.add(original);
      return fail();
    }
    return result;
  }
  const base = (tx: RecipeTransaction) =>
    createPostgresRecipeStore({ run: (work) => work(tx) }, brand, generateReference);
  const read = (tx: RecipeTransaction, record: RecipeOperationRecord) =>
    readStoredMeasurement(tx, brand, record);
  async function resolve(tx: RecipeTransaction, operation: string) {
    const record = await base(tx).resolveOperation(parseRecipeReference(operation));
    if (record === null) return null;
    return Object.freeze({ record, content: await read(tx, record) });
  }
  async function write(
    input: Parameters<RecipePorts["repository"]["create"]>[0],
    expected: number | null,
  ) {
    if (
      (lifecycle === "Draft"
        ? input.record.action !== "CreateDraft" && input.record.action !== "ReplaceDraft"
        : input.record.action !== "Publish" || expected === null) ||
      canonicalizeRfc8785(input.record.aggregate) !== canonicalizeRfc8785(content.snapshot)
    )
      return fail();
    return transaction(async (tx) => {
      const repository = base(tx),
        prior = await resolve(tx, input.record.operationReference);
      if (prior) {
        if (
          canonicalizeRfc8785(prior.record) !== canonicalizeRfc8785(input.record) ||
          canonicalizeRfc8785(prior.content) !== canonicalizeRfc8785(content)
        )
          throw new RecipeWorkflowError("RECIPE_IDEMPOTENCY_CONFLICT");
        return prior.record;
      }
      const saved =
        expected === null
          ? await repository.create(input)
          : await repository.commit({ ...input, expectedAggregateVersion: expected });
      if (canonicalizeRfc8785(saved.aggregate) !== canonicalizeRfc8785(content.snapshot))
        return fail();
      const result = await tx.query(
        "INSERT INTO rms_recipe.recipe_measurement_content (recipe_version_id,recipe_id,brand_id,content_digest,content_json) VALUES ($1,$2,$3,$4,$5) RETURNING content_json,content_digest",
        [
          content.snapshot.versionReference,
          content.snapshot.recipeReference,
          brand,
          content.snapshot.snapshotDigest,
          JSON.stringify(content),
        ],
      );
      if (
        !result ||
        typeof result !== "object" ||
        Object.getOwnPropertyDescriptor(result, "rowCount")?.value !== 1
      )
        return fail();
      const stored = await read(tx, saved);
      if (canonicalizeRfc8785(stored) !== canonicalizeRfc8785(content)) return fail();
      return saved;
    });
  }
  return Object.freeze({
    load: (reference) => transaction((tx) => base(tx).load(reference)),
    codeAvailable: (value) => transaction((tx) => base(tx).codeAvailable(value)),
    resolveOperation: (operation) =>
      transaction(async (tx) => (await resolve(tx, operation))?.record ?? null),
    resolveMeasurementOperation: (operation) => transaction((tx) => resolve(tx, operation)),
    create: (input) => write(input, null),
    commit: (input) => write(input, input.expectedAggregateVersion),
  });
}

async function readStoredMeasurement(
  tx: RecipeTransaction,
  brand: string,
  record: RecipeOperationRecord,
) {
  const result = rows(
    await tx.query(
      "SELECT content_json,content_digest FROM rms_recipe.recipe_measurement_content WHERE brand_id=$1 AND recipe_version_id=$2",
      [brand, record.aggregate.versionReference],
    ),
  );
  if (result.length !== 1 || !result[0]) return fail();
  const stored = requireRecipeMeasurementContentDigest(result[0].content_json);
  if (
    stored.snapshot.brandReference !== brand ||
    result[0].content_digest !== stored.snapshot.snapshotDigest ||
    canonicalizeRfc8785(stored.snapshot) !== canonicalizeRfc8785(record.aggregate)
  )
    return fail();
  return stored;
}

/** Scoped immutable owning read. Current permission, barrier, lease and final rereads belong to its caller's owning holder. */
export async function readPublishedRecipeMeasurementContent(
  tx: RecipeTransaction,
  brandInput: string,
  snapshotInput: RecipeSnapshot,
  operationInput: string,
): Promise<RecipeMeasurementContentV2> {
  try {
    const brand = parseRecipeReference(brandInput),
      snapshot = createRecipeSnapshot(snapshotInput),
      operation = parseRecipeReference(operationInput);
    if (snapshot.brandReference !== brand || snapshot.lifecycle !== "Published") return fail();
    const record = await createPostgresRecipeStore(
      { run: (work) => work(tx) },
      brand,
      fail,
    ).resolveOperation(operation);
    if (
      !record ||
      record.action !== "Publish" ||
      canonicalizeRfc8785(record.aggregate) !== canonicalizeRfc8785(snapshot)
    )
      return fail();
    return await readStoredMeasurement(tx, brand, record);
  } catch (error) {
    if (error instanceof RecipeWorkflowError) throw error;
    return fail();
  }
}
