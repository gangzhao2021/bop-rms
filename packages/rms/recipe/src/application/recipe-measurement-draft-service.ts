import { requireRecipeMeasurementContentDigest } from "../contracts/recipe-measurement-content-digest.js";
import type { RecipeMeasurementContentV2 } from "../domain/recipe-measurement-content.js";
import type { RecipePorts } from "./ports/recipe-ports.js";
import {
  createRecipeService,
  RecipeWorkflowError,
  type ExecuteRecipeInput,
} from "./recipe-service.js";
export interface ExecuteRecipeMeasurementDraftInput extends Omit<
  ExecuteRecipeInput,
  "action" | "candidate"
> {
  readonly action: "CreateDraft" | "ReplaceDraft";
  readonly candidate: RecipeMeasurementContentV2;
}
/** Drafts only. Published measurement qualification needs held owning conversion/yield sources. */
export function createRecipeMeasurementDraftService(
  options: Omit<RecipePorts, "repository"> & {
    readonly repositoryForContent: (
      content: RecipeMeasurementContentV2,
    ) => RecipePorts["repository"];
  },
) {
  const factory = options.repositoryForContent.bind(options);
  return Object.freeze({
    async execute(value: ExecuteRecipeMeasurementDraftInput) {
      if (
        !value ||
        typeof value !== "object" ||
        Object.getPrototypeOf(value) !== Object.prototype ||
        Reflect.ownKeys(value).length !== 5 ||
        ![
          "action",
          "operationReference",
          "expectedAggregateVersion",
          "candidate",
          "occurredAt",
        ].every((key) => {
          const d = Object.getOwnPropertyDescriptor(value, key);
          return d?.enumerable && "value" in d;
        })
      )
        throw new RecipeWorkflowError("RECIPE_INPUT_INVALID");
      if (value.action !== "CreateDraft" && value.action !== "ReplaceDraft")
        throw new RecipeWorkflowError("RECIPE_DEPENDENCY_UNAVAILABLE");
      const content = requireRecipeMeasurementContentDigest(value.candidate);
      if (content.snapshot.lifecycle !== "Draft")
        throw new RecipeWorkflowError("RECIPE_LIFECYCLE_CONFLICT");
      const service = createRecipeService({ ...options, repository: factory(content) });
      const result = await service.execute({ ...value, candidate: content.snapshot });
      if (
        result.aggregate.snapshotDigest !== content.snapshot.snapshotDigest ||
        result.aggregate.versionReference !== content.snapshot.versionReference
      )
        throw new RecipeWorkflowError("RECIPE_DEPENDENCY_UNAVAILABLE");
      return Object.freeze({ ...result, content });
    },
  });
}
