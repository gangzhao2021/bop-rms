import { parseRecipeReference, parseRecipeDigest } from "../domain/recipe.js";
import { coreQueryRecord, coreQueryInstant, coreQueryRevision } from "./recipe-core-query.js";
import {
  parseRecipeCoverageSnapshot,
  RecipeCoverageError,
  type RecipeCoverageSnapshot,
} from "./recipe-source-coverage.js";
import { RecipeCoveragePublicationError } from "./recipe-coverage-publication-error.js";
export interface RecipeCoreRebuildRequest {
  readonly generationReference: string;
  readonly actorReference: string;
  readonly purpose: "RecipeProjectionBuild";
  readonly observedAtUtc: string;
}
export interface RecipeCoreRebuildIntent {
  readonly generationReference: string;
  readonly actorReference: string;
  readonly purpose: "RecipeProjectionBuild";
  readonly expectedRevision: string;
  readonly builtAt: string;
  readonly coverage: RecipeCoverageSnapshot;
}
export interface RecipeCoreRebuildResult {
  readonly generationReference: string;
  readonly publicationRevision: string;
  readonly projectionVersion: 2;
  readonly coreDigest: string;
  readonly rowCount: number;
  readonly active: boolean;
  readonly replay: boolean;
}
export interface RecipeCoreRebuildState {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly sourceRevision: string;
  readonly sourceGenerationReference: string | null;
  readonly coreRevision: string;
  readonly coreGenerationReference: string | null;
  readonly operation: {
    readonly intent: RecipeCoreRebuildIntent;
    readonly result: RecipeCoreRebuildResult | null;
  } | null;
}
export class RecipeCoreRebuildError extends Error {
  constructor(readonly code: "RECIPE_REBUILD_INPUT_INVALID" | "RECIPE_REBUILD_UNAVAILABLE") {
    super("Recipe core rebuild is unavailable");
    this.name = "RecipeCoreRebuildError";
  }
}
const fail = (): never => {
  throw new RecipeCoreRebuildError("RECIPE_REBUILD_UNAVAILABLE");
};
export function parseRecipeCoreRebuildRequest(value: unknown): RecipeCoreRebuildRequest {
  try {
    const row = coreQueryRecord(value, [
      "generationReference",
      "actorReference",
      "purpose",
      "observedAtUtc",
    ]);
    if (row.purpose !== "RecipeProjectionBuild") return fail();
    return Object.freeze({
      generationReference: parseRecipeReference(row.generationReference),
      actorReference: parseRecipeReference(row.actorReference),
      purpose: row.purpose,
      observedAtUtc: coreQueryInstant(row.observedAtUtc),
    });
  } catch {
    throw new RecipeCoreRebuildError("RECIPE_REBUILD_INPUT_INVALID");
  }
}
export function parseRecipeCoreRebuildIntent(value: unknown): RecipeCoreRebuildIntent {
  const row = coreQueryRecord(value, [
    "generationReference",
    "actorReference",
    "purpose",
    "expectedRevision",
    "builtAt",
    "coverage",
  ]);
  if (row.purpose !== "RecipeProjectionBuild") return fail();
  const expectedRevision = coreQueryRevision(row.expectedRevision);
  if (expectedRevision === "9223372036854775807") return fail();
  const coverage = parseRecipeCoverageSnapshot(row.coverage);
  if (coverage.sources.some((source) => !source.complete)) return fail();
  return Object.freeze({
    generationReference: parseRecipeReference(row.generationReference),
    actorReference: parseRecipeReference(row.actorReference),
    purpose: row.purpose,
    expectedRevision,
    builtAt: coreQueryInstant(row.builtAt),
    coverage,
  });
}
function result(value: unknown, generation: string): RecipeCoreRebuildResult {
  const row = coreQueryRecord(value, [
      "generationReference",
      "publicationRevision",
      "projectionVersion",
      "coreDigest",
      "rowCount",
      "active",
      "replay",
    ]),
    publicationRevision = coreQueryRevision(row.publicationRevision);
  if (
    row.generationReference !== generation ||
    publicationRevision === "0" ||
    row.projectionVersion !== 2 ||
    !Number.isSafeInteger(row.rowCount) ||
    (row.rowCount as number) < 0 ||
    (row.rowCount as number) > 2048 ||
    typeof row.active !== "boolean" ||
    typeof row.replay !== "boolean"
  )
    return fail();
  return Object.freeze({
    generationReference: generation,
    publicationRevision,
    projectionVersion: 2,
    coreDigest: parseRecipeDigest(row.coreDigest),
    rowCount: row.rowCount as number,
    active: row.active,
    replay: row.replay,
  });
}
function state(
  value: unknown,
  scope: { readonly tenantReference: string; readonly brandReference: string },
  request: RecipeCoreRebuildRequest,
): RecipeCoreRebuildState {
  const row = coreQueryRecord(value, [
    "tenantReference",
    "brandReference",
    "sourceRevision",
    "sourceGenerationReference",
    "coreRevision",
    "coreGenerationReference",
    "operation",
  ]);
  if (row.tenantReference !== scope.tenantReference || row.brandReference !== scope.brandReference)
    return fail();
  const sourceRevision = coreQueryRevision(row.sourceRevision),
    coreRevision = coreQueryRevision(row.coreRevision),
    sourceGenerationReference =
      row.sourceGenerationReference === null
        ? null
        : parseRecipeReference(row.sourceGenerationReference),
    coreGenerationReference =
      row.coreGenerationReference === null
        ? null
        : parseRecipeReference(row.coreGenerationReference);
  if (
    (sourceRevision === "0") !== (sourceGenerationReference === null) ||
    (coreRevision === "0") !== (coreGenerationReference === null) ||
    BigInt(coreRevision) > BigInt(sourceRevision)
  )
    return fail();
  let operation: RecipeCoreRebuildState["operation"] = null;
  if (row.operation !== null) {
    const op = coreQueryRecord(row.operation, ["intent", "result"]),
      intent = parseRecipeCoreRebuildIntent(op.intent);
    if (
      intent.generationReference !== request.generationReference ||
      intent.coverage.tenantReference !== scope.tenantReference ||
      intent.coverage.brandReference !== scope.brandReference ||
      intent.builtAt > request.observedAtUtc ||
      BigInt(intent.expectedRevision) + 1n > BigInt(sourceRevision)
    )
      return fail();
    if (intent.actorReference !== request.actorReference)
      throw new RecipeCoveragePublicationError("RECIPE_PUBLICATION_IDEMPOTENCY_CONFLICT");
    const receipt = op.result === null ? null : result(op.result, request.generationReference);
    if (
      receipt &&
      (BigInt(receipt.publicationRevision) !== BigInt(intent.expectedRevision) + 1n ||
        BigInt(receipt.publicationRevision) > BigInt(coreRevision) ||
        receipt.active !== (coreGenerationReference === request.generationReference) ||
        (receipt.active && receipt.publicationRevision !== coreRevision))
    )
      return fail();
    operation = Object.freeze({ intent, result: receipt });
  }
  return Object.freeze({
    ...scope,
    sourceRevision,
    sourceGenerationReference,
    coreRevision,
    coreGenerationReference,
    operation,
  });
}
/** Required owner/public ports. Stable generation identity is supplied by the authorized caller. */
export function createRecipeCoreRebuildCoordinator(options: {
  readonly scope: { readonly tenantReference: string; readonly brandReference: string };
  readonly head: { load(request: unknown): Promise<unknown> };
  readonly sources: { capture(request: unknown): Promise<unknown> };
  readonly publication: { publish(intent: unknown): Promise<unknown> };
}) {
  const scope = Object.freeze({
    tenantReference: parseRecipeReference(options.scope.tenantReference),
    brandReference: parseRecipeReference(options.scope.brandReference),
  });
  async function load(request: RecipeCoreRebuildRequest) {
    return state(await options.head.load(request), scope, request);
  }
  function saved(head: RecipeCoreRebuildState): RecipeCoreRebuildResult | null {
    if (!head.operation) return null;
    if (!head.operation.result)
      throw new RecipeCoveragePublicationError("RECIPE_PUBLICATION_IDEMPOTENCY_CONFLICT");
    return Object.freeze({ ...head.operation.result, replay: true });
  }
  return Object.freeze({
    async rebuild(value: unknown): Promise<RecipeCoreRebuildResult> {
      const request = parseRecipeCoreRebuildRequest(value);
      try {
        const before = await load(request),
          receipt = saved(before);
        if (receipt) return receipt;
        if (before.sourceRevision === "9223372036854775807") return fail();
        const coverage = parseRecipeCoverageSnapshot(
          await options.sources.capture({
            actorReference: request.actorReference,
            purpose: request.purpose,
            observedAtUtc: request.observedAtUtc,
          }),
        );
        if (
          coverage.tenantReference !== scope.tenantReference ||
          coverage.brandReference !== scope.brandReference
        )
          return fail();
        if (coverage.sources.some((source) => !source.complete))
          throw new RecipeCoverageError("RECIPE_COVERAGE_INCOMPLETE");
        const intent: RecipeCoreRebuildIntent = Object.freeze({
          generationReference: request.generationReference,
          actorReference: request.actorReference,
          purpose: request.purpose,
          expectedRevision: before.sourceRevision,
          builtAt: request.observedAtUtc,
          coverage,
        });
        try {
          const published = result(
            await options.publication.publish(intent),
            request.generationReference,
          );
          if (BigInt(published.publicationRevision) !== BigInt(intent.expectedRevision) + 1n)
            return fail();
          return published;
        } catch (error) {
          // Read back committed evidence once. No retry loop, source recapture, or invented acknowledgement.
          const after = await load(request),
            resolved = saved(after);
          if (resolved) return resolved;
          throw error;
        }
      } catch (error) {
        if (
          error instanceof RecipeCoreRebuildError ||
          error instanceof RecipeCoveragePublicationError ||
          error instanceof RecipeCoverageError
        )
          throw error;
        return fail();
      }
    },
  });
}
