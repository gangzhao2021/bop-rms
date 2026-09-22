import { revalidateTenantContext } from "@bop/permission";
import { validateAuditRecord } from "@bop/audit";
import { createRecipeSnapshot, parseRecipeReference } from "../domain/recipe.js";
import {
  applyRecipeIngredientModifiers,
  calculateConfiguredRecipeInventoryDemand,
  parseRecipeModifierRule,
} from "../domain/recipe-modifier.js";
import { parseRecipeModifierPublicationEvidence } from "../domain/publication-review.js";
import { RecipeWorkflowError } from "./recipe-service.js";
import type { RecipeModifierCommand, RecipeModifierPorts } from "./ports/recipe-modifier-ports.js";

function deny(): never {
  throw new RecipeWorkflowError("RECIPE_PERMISSION_DENIED");
}
/** Authorization always precedes operation recovery; current source facts guard only new writes. */
export function createRecipeModifierService(ports: RecipeModifierPorts) {
  return Object.freeze({
    async execute(input: RecipeModifierCommand) {
      try {
        const base = createRecipeSnapshot(input.base);
        const rule = parseRecipeModifierRule(input.rule, base);
        const operationReference = parseRecipeReference(input.operationReference);
        const command = Object.freeze({ ...input, base, rule, operationReference });
        const authorization = await ports.authorization.authorize(command);
        if (authorization === null) return deny();
        const context = revalidateTenantContext(authorization.tenantContext);
        const actor = context.actor.actorReference;
        const audit = validateAuditRecord(authorization.audit, Date.parse(input.occurredAt));
        if (
          context.scopeKind !== "Brand" ||
          actor === null ||
          String(context.brand.brandReference) !== base.brandReference ||
          authorization.permission.effect !== "Allow" ||
          authorization.permission.action !== "recipe.manage" ||
          authorization.permission.scopeKind !== "Brand" ||
          audit.brandId !== base.brandReference ||
          audit.storeId !== undefined ||
          audit.actor.type === "System" ||
          audit.actor.reference !== actor ||
          audit.targetType !== "RecipeModifier" ||
          audit.targetId !== rule.ruleReference ||
          audit.actionCode !== "RECIPE_MODIFIER_" + input.lifecycle.toUpperCase() ||
          audit.occurredAt !== input.occurredAt
        )
          return deny();
        const proof =
          input.lifecycle === "Published"
            ? parseRecipeModifierPublicationEvidence(
                authorization.publicationEvidence,
                rule,
                input.occurredAt,
              )
            : null;
        if (
          proof !== null &&
          (authorization.costReviewPermission?.effect !== "Allow" ||
            authorization.costReviewPermission.action !== "recipe.cost-review" ||
            authorization.costReviewPermission.scopeKind !== "Brand" ||
            authorization.foodSafetyReviewPermission?.effect !== "Allow" ||
            authorization.foodSafetyReviewPermission.action !== "recipe.food-safety-review" ||
            authorization.foodSafetyReviewPermission.scopeKind !== "Brand" ||
            proof.draftAuthorActorReference !== authorization.draftAuthorActorReference ||
            proof.reviews.find((r) => r.reviewKind === "Cost")?.reviewerActorReference !==
              authorization.costReviewerActorReference ||
            proof.reviews.find((r) => r.reviewKind === "FoodSafety")?.reviewerActorReference !==
              authorization.foodSafetyReviewerActorReference)
        )
          throw new RecipeWorkflowError("RECIPE_DUAL_REVIEW_REQUIRED");
        return await ports.repository.append(
          { ...command, actorReference: actor, publicationEvidence: proof, audit },
          async () => {
            // Invalidation/archival must remain possible when referenced ingredients become unavailable.
            if (input.lifecycle === "Invalidated" || input.lifecycle === "Archived") return;
            const configured = applyRecipeIngredientModifiers(base, [rule.selection], [rule]);
            const facts = await ports.facts.validate(
              createRecipeSnapshot({ ...base, ingredients: configured.ingredients }),
            );
            if (!facts.referencesValid) throw new RecipeWorkflowError("RECIPE_EVIDENCE_INCOMPLETE");
            if (input.lifecycle === "Published") {
              if (
                base.lifecycle !== "Published" ||
                !facts.mappingsComplete ||
                !facts.allergenEvidenceVerified ||
                !facts.costEvidenceVerified
              )
                throw new RecipeWorkflowError("RECIPE_EVIDENCE_INCOMPLETE");
              calculateConfiguredRecipeInventoryDemand(
                base,
                facts.graphSnapshots,
                [rule.selection],
                [rule],
                base.yieldQuantityMicrounits,
              );
            }
          },
        );
      } catch (error) {
        if (error instanceof RecipeWorkflowError) throw error;
        throw new RecipeWorkflowError("RECIPE_DEPENDENCY_UNAVAILABLE");
      }
    },
  });
}
