import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { RecipeWorkflowError } from "../application/recipe-service.js";
import {
  matchRecipeCatalogReferences,
  type RecipeCatalogReferenceTarget,
} from "./recipe-catalog-reference-matches.js";
import {
  parseRecipeReferenceSourceInstant,
  parseRecipeReferenceSourceSnapshot,
  type RecipeReferenceSourceRequest,
} from "./recipe-reference-source.js";
/** Current stored membership/period checks. Catalog supplies an owning current Draft
 * graph; Store existence/override precedence and executable resolution are separate. */
export function assessCurrentRecipeCatalogBindingScope(input: {
  readonly request: RecipeReferenceSourceRequest;
  readonly target: RecipeCatalogReferenceTarget;
  readonly source: unknown;
  readonly now: string;
  readonly activationAt: string;
}) {
  try {
    const now = parseRecipeReferenceSourceInstant(input.now),
      activationAt = parseRecipeReferenceSourceInstant(input.activationAt);
    if (activationAt < now) throw new Error("past activation");
    const source = parseRecipeReferenceSourceSnapshot(input.source, input.request, now),
      matched = matchRecipeCatalogReferences({ ...input, source });
    const covers = (r: { effectiveFrom: string; effectiveUntil: string | null }, at: string) =>
      r.effectiveFrom <= at && (r.effectiveUntil === null || at < r.effectiveUntil);
    const state = (
      g: (typeof matched.references)[number],
      period: { effectiveFrom: string; effectiveUntil: string | null },
      lifecycle = "Published",
    ) =>
      !g.isCurrentRecipeVersion
        ? "StaleRecipeVersion"
        : g.version.lifecycle !== "Published"
          ? "UnpublishedRecipeVersion"
          : !covers(g.version, now)
            ? "InactiveRecipeObservedPeriod"
            : !covers(g.version, activationAt)
              ? "InactiveRecipeActivationPeriod"
              : lifecycle !== "Published"
                ? "UnpublishedModifierVersion"
                : !covers(period, now)
                  ? "InactiveObservedPeriod"
                  : !covers(period, activationAt)
                    ? "InactiveActivationPeriod"
                    : "CurrentStoredMembershipAndPeriods";
    const bindingChecks = matched.references
      .flatMap((g) =>
        g.bindings.map((b) =>
          Object.freeze({
            bindingReference: b.bindingReference,
            recipeReference: g.recipe.recipeReference,
            recipeVersionReference: g.version.recipeVersionReference,
            skuReference: b.skuReference,
            optionBindingReference: b.optionBindingReference,
            storeReference: b.storeReference,
            status: state(g, b),
            storeApplicability: "NotEvaluated" as const,
          }),
        ),
      )
      .sort((a, b) => a.bindingReference.localeCompare(b.bindingReference));
    // Complete history stays in the source digest; only latest owning rule revisions are current candidates.
    const latest = new Map<string, number>();
    for (const m of source.modifiers)
      latest.set(m.ruleReference, Math.max(latest.get(m.ruleReference) ?? 0, m.version));
    const modifierChecks = matched.references
      .flatMap((g) =>
        g.modifiers
          .filter((m) => latest.get(m.reference.ruleReference) === m.reference.version)
          .map((m) =>
            Object.freeze({
              ruleReference: m.reference.ruleReference,
              ruleVersionReference: m.reference.ruleVersionReference,
              recipeReference: g.recipe.recipeReference,
              recipeVersionReference: g.version.recipeVersionReference,
              bindingReference: m.reference.bindingReference,
              optionReference: m.reference.optionReference,
              skuReferences: m.matchedSkuReferences,
              status: state(g, m.reference, m.reference.lifecycle),
            }),
          ),
      )
      .sort((a, b) => a.ruleReference.localeCompare(b.ruleReference));
    const gaps = matched.unresolved
      .flatMap((g) => [
        ...g.bindings.map((b) =>
          Object.freeze({
            kind: "Binding" as const,
            reference: b.reference.bindingReference,
            recipeVersionReference: g.version.recipeVersionReference,
            reason: b.reason,
          }),
        ),
        ...g.modifiers
          .filter((m) => latest.get(m.reference.ruleReference) === m.reference.version)
          .map((m) =>
            Object.freeze({
              kind: "Modifier" as const,
              reference: m.reference.ruleVersionReference,
              recipeVersionReference: g.version.recipeVersionReference,
              reason: m.reason,
            }),
          ),
      ])
      .sort((a, b) => a.reference.localeCompare(b.reference));
    const body = {
      profile: "CurrentRecipeCatalogBindingScopeV1" as const,
      brandReference: input.request.brandReference,
      productReference: matched.target.productReference,
      versionReference: matched.target.versionReference,
      catalogConfigurationDigest: matched.target.catalogConfigurationDigest,
      recipeSourceDigest: source.digest,
      recipeGeneration: source.generation,
      operationReference: input.request.operationReference,
      catalogIntentDigest: input.request.catalogIntentDigest,
      assessedAt: now,
      activationAt,
      targetMembership: matched.targetMembership,
      bindingChecks: Object.freeze(bindingChecks),
      modifierChecks: Object.freeze(modifierChecks),
      gaps: Object.freeze(gaps),
      decision:
        matched.targetMembership === "Absent" || gaps.length > 0
          ? ("HardError" as const)
          : [...bindingChecks, ...modifierChecks].every(
                (c) => c.status === "CurrentStoredMembershipAndPeriods",
              )
            ? ("PassForStoredMembershipAndPeriods" as const)
            : ("RequiresReview" as const),
      storeTopology: "NotEvaluated" as const,
      storeOverrideAuthorization: "NotEvaluated" as const,
      uniqueRecipeResolution: "NotEvaluated" as const,
      ingredients: "NotEvaluated" as const,
      eligibility: "NotEvaluated" as const,
    };
    return Object.freeze({ ...body, digest: "sha256:" + sha256Hex(canonicalizeRfc8785(body)) });
  } catch {
    throw new RecipeWorkflowError("RECIPE_DEPENDENCY_UNAVAILABLE");
  }
}
