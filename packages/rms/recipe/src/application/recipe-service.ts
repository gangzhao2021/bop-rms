import { validateAuditRecord, type AppendAuditRecordInput } from "@bop/audit";
import { revalidateTenantContext } from "@bop/permission";
import {
  calculateRecipe,
  createRecipeSnapshot,
  parseRecipeDigest,
  parseRecipeReference,
  validateRecipeGraph,
  type RecipeReference,
  type RecipeSnapshot,
} from "../domain/recipe.js";
import type {
  RecipeAction,
  RecipeEvent,
  RecipeOperationRecord,
  RecipePorts,
} from "./ports/recipe-ports.js";

export type RecipeWorkflowErrorCode =
  | "RECIPE_INPUT_INVALID"
  | "RECIPE_PERMISSION_DENIED"
  | "RECIPE_DUAL_REVIEW_REQUIRED"
  | "RECIPE_VERSION_CONFLICT"
  | "RECIPE_IDEMPOTENCY_CONFLICT"
  | "RECIPE_CODE_CONFLICT"
  | "RECIPE_LIFECYCLE_CONFLICT"
  | "RECIPE_EVIDENCE_INCOMPLETE"
  | "RECIPE_DEPENDENCY_UNAVAILABLE";
export class RecipeWorkflowError extends Error {
  constructor(readonly code: RecipeWorkflowErrorCode) {
    super("Recipe operation is unavailable");
    this.name = "RecipeWorkflowError";
  }
}
const invalid = (): never => {
  throw new RecipeWorkflowError("RECIPE_INPUT_INVALID");
};
function instant(value: unknown) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    return invalid();
  return value;
}
function positive(value: unknown) {
  if (!Number.isSafeInteger(value) || (value as number) < 1) return invalid();
  return value as number;
}
function dependency(error: unknown): never {
  if (
    error instanceof RecipeWorkflowError &&
    ["RECIPE_VERSION_CONFLICT", "RECIPE_IDEMPOTENCY_CONFLICT", "RECIPE_CODE_CONFLICT"].includes(
      error.code,
    )
  )
    throw error;
  throw new RecipeWorkflowError("RECIPE_DEPENDENCY_UNAVAILABLE");
}
function event(action: RecipeAction, aggregate: RecipeSnapshot, at: string): RecipeEvent {
  const types: Record<RecipeAction, RecipeEvent["eventType"]> = {
    CreateDraft: "RecipeDraftCreated",
    ReplaceDraft: "RecipeDraftReplaced",
    Publish: "RecipePublished",
    Invalidate: "RecipeInvalidated",
    Archive: "RecipeArchived",
  };
  return Object.freeze({
    eventType: types[action],
    recipeReference: aggregate.recipeReference,
    versionReference: aggregate.versionReference,
    brandReference: aggregate.brandReference,
    aggregateVersion: aggregate.aggregateVersion,
    lifecycle: aggregate.lifecycle,
    snapshotDigest: aggregate.snapshotDigest,
    occurredAt: at,
  });
}
interface Authorization {
  readonly brand: RecipeReference;
  readonly author: RecipeReference | null;
  readonly costReviewer: RecipeReference | null;
  readonly foodReviewer: RecipeReference | null;
  readonly costReviewAllowed: boolean;
  readonly foodReviewAllowed: boolean;
  readonly audit: AppendAuditRecordInput;
}
async function authorize(
  ports: RecipePorts,
  action: RecipeAction,
  operationReference: RecipeReference,
  recipeReference: RecipeReference,
  at: string,
): Promise<Authorization> {
  const evidence = await ports.authorization
    .authorize({ action, operationReference, recipeReference, observedAt: at })
    .catch(dependency);
  if (evidence === null) throw new RecipeWorkflowError("RECIPE_PERMISSION_DENIED");
  try {
    const context = revalidateTenantContext(evidence.tenantContext);
    const audit = validateAuditRecord(evidence.audit, Date.parse(at));
    const actor = context.actor.actorReference;
    if (
      context.scopeKind !== "Brand" ||
      actor === null ||
      evidence.permission.effect !== "Allow" ||
      evidence.permission.action !== "recipe.manage" ||
      evidence.permission.scopeKind !== "Brand" ||
      audit.brandId !== context.brand.brandReference ||
      audit.storeId !== undefined ||
      audit.actor.type === "System" ||
      audit.actor.reference !== actor ||
      audit.actionCode !== `RECIPE_${action.toUpperCase()}` ||
      audit.targetType !== "Recipe" ||
      audit.targetId !== recipeReference ||
      audit.occurredAt !== at
    )
      throw new Error("denied");
    return {
      brand: parseRecipeReference(context.brand.brandReference),
      author:
        evidence.draftAuthorActorReference === null
          ? null
          : parseRecipeReference(evidence.draftAuthorActorReference),
      costReviewer:
        evidence.costReviewerActorReference === null
          ? null
          : parseRecipeReference(evidence.costReviewerActorReference),
      foodReviewer:
        evidence.foodSafetyReviewerActorReference === null
          ? null
          : parseRecipeReference(evidence.foodSafetyReviewerActorReference),
      costReviewAllowed:
        evidence.costReviewPermission?.effect === "Allow" &&
        evidence.costReviewPermission.action === "recipe.cost-review" &&
        evidence.costReviewPermission.scopeKind === "Brand",
      foodReviewAllowed:
        evidence.foodSafetyReviewPermission?.effect === "Allow" &&
        evidence.foodSafetyReviewPermission.action === "recipe.food-safety-review" &&
        evidence.foodSafetyReviewPermission.scopeKind === "Brand",
      audit,
    };
  } catch {
    throw new RecipeWorkflowError("RECIPE_PERMISSION_DENIED");
  }
}
export interface ExecuteRecipeInput {
  readonly action: RecipeAction;
  readonly operationReference: RecipeReference;
  readonly expectedAggregateVersion: number | null;
  readonly candidate: RecipeSnapshot;
  readonly occurredAt: string;
}
export function createRecipeService(ports: RecipePorts) {
  return Object.freeze({
    async execute(input: ExecuteRecipeInput) {
      if (
        input === null ||
        typeof input !== "object" ||
        Array.isArray(input) ||
        Object.getPrototypeOf(input) !== Object.prototype ||
        Reflect.ownKeys(input).length !== 5 ||
        !["CreateDraft", "ReplaceDraft", "Publish", "Invalidate", "Archive"].includes(input.action)
      )
        invalid();
      const at = instant(input.occurredAt);
      const operationReference = parseRecipeReference(input.operationReference);
      const candidate = createRecipeSnapshot(input.candidate);
      if (candidate.createdAt !== at) invalid();
      const intent = parseRecipeDigest(ports.references.hashIntent(JSON.stringify(input)));
      const prior = await ports.repository.resolveOperation(operationReference).catch(dependency);
      if (prior !== null) {
        if (!ports.references.equals(prior.operationIntentHash, intent))
          throw new RecipeWorkflowError("RECIPE_IDEMPOTENCY_CONFLICT");
        return Object.freeze({
          status: "AlreadyApplied" as const,
          aggregate: createRecipeSnapshot(prior.aggregate),
        });
      }
      const auth = await authorize(
        ports,
        input.action,
        operationReference,
        candidate.recipeReference,
        at,
      );
      if (candidate.brandReference !== auth.brand)
        throw new RecipeWorkflowError("RECIPE_PERMISSION_DENIED");
      const current = await ports.repository.load(candidate.recipeReference).catch(dependency);
      if (input.action === "CreateDraft") {
        if (
          input.expectedAggregateVersion !== null ||
          current !== null ||
          candidate.lifecycle !== "Draft" ||
          candidate.aggregateVersion !== 1 ||
          !(await ports.repository
            .codeAvailable({
              brandReference: candidate.brandReference,
              stableCode: candidate.stableCode,
              excludingRecipeReference: null,
            })
            .catch(dependency))
        )
          throw new RecipeWorkflowError(
            current === null ? "RECIPE_CODE_CONFLICT" : "RECIPE_LIFECYCLE_CONFLICT",
          );
      } else {
        const expected = positive(input.expectedAggregateVersion);
        if (current === null || current.aggregateVersion !== expected)
          throw new RecipeWorkflowError("RECIPE_VERSION_CONFLICT");
        const target: Record<Exclude<RecipeAction, "CreateDraft">, RecipeSnapshot["lifecycle"]> = {
          ReplaceDraft: "Draft",
          Publish: "Published",
          Invalidate: "Invalidated",
          Archive: "Archived",
        };
        if (
          candidate.recipeReference !== current.recipeReference ||
          candidate.stableCode !== current.stableCode ||
          candidate.aggregateVersion !== expected + 1 ||
          candidate.versionNumber !== current.versionNumber + 1 ||
          candidate.lifecycle !== target[input.action]
        )
          invalid();
        if (
          (input.action === "ReplaceDraft" || input.action === "Publish") &&
          current.lifecycle !== "Draft"
        )
          throw new RecipeWorkflowError("RECIPE_LIFECYCLE_CONFLICT");
        if (input.action === "Invalidate" && current.lifecycle !== "Published")
          throw new RecipeWorkflowError("RECIPE_LIFECYCLE_CONFLICT");
        if (input.action === "Archive" && current.lifecycle === "Archived")
          throw new RecipeWorkflowError("RECIPE_LIFECYCLE_CONFLICT");
      }
      const facts = await ports.facts.validate(candidate).catch(dependency);
      if (!facts.referencesValid) throw new RecipeWorkflowError("RECIPE_EVIDENCE_INCOMPLETE");
      if (input.action === "Publish") {
        const reviewers = [auth.costReviewer, auth.foodReviewer];
        if (
          !auth.costReviewAllowed ||
          !auth.foodReviewAllowed ||
          reviewers.some((reviewer) => reviewer === null || reviewer === auth.author) ||
          auth.author === null ||
          auth.costReviewer === auth.foodReviewer ||
          !facts.mappingsComplete ||
          !facts.allergenEvidenceVerified ||
          !facts.costEvidenceVerified
        )
          throw new RecipeWorkflowError("RECIPE_DUAL_REVIEW_REQUIRED");
        validateRecipeGraph(candidate, facts.graphSnapshots);
        calculateRecipe(candidate);
      }
      const record: RecipeOperationRecord = Object.freeze({
        action: input.action,
        operationReference,
        operationIntentHash: intent,
        aggregate: candidate,
        event: event(input.action, candidate, at),
      });
      const saved =
        input.action === "CreateDraft"
          ? await ports.repository.create({ record, audit: auth.audit }).catch(dependency)
          : await ports.repository
              .commit({
                record,
                expectedAggregateVersion: positive(input.expectedAggregateVersion),
                audit: auth.audit,
              })
              .catch(dependency);
      const aggregate = createRecipeSnapshot(saved.aggregate);
      if (
        saved.action !== record.action ||
        saved.operationReference !== record.operationReference ||
        !ports.references.equals(saved.operationIntentHash, record.operationIntentHash) ||
        aggregate.aggregateVersion !== candidate.aggregateVersion ||
        JSON.stringify(saved.event) !== JSON.stringify(record.event)
      )
        throw new RecipeWorkflowError("RECIPE_DEPENDENCY_UNAVAILABLE");
      return Object.freeze({ status: "Applied" as const, aggregate });
    },
  });
}
