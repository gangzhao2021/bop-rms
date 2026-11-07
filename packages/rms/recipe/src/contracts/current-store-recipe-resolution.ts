import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { parseTenantStoreReferenceSnapshot } from "@bop/tenant";
import { parseRecipeReference, parseRecipeDigest } from "../domain/recipe.js";
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
/** A minimal projection from held current Tenant content plus owning Publishing release.
 * This value is not itself authority: only server composition may acquire that proof. */
export interface RecipeStoreOverridePolicy {
  readonly profile: "CurrentRecipeStoreOverridePolicyV1";
  readonly brandReference: string;
  readonly configurationVersionReference: string;
  readonly currentPublicationReference: string;
  readonly contentDigest: string;
  readonly originalIntentDigest: string;
  readonly observedAt: string;
  readonly validUntil: string;
  readonly effectiveFrom: string;
  readonly effectiveUntil: string | null;
  readonly storeRecipeOverrideAllowed: boolean;
}
function policy(
  value: unknown,
  request: RecipeReferenceSourceRequest,
  now: string,
  activationAt: string,
) {
  if (value === "Unavailable") return null;
  const fields = [
    "profile",
    "brandReference",
    "configurationVersionReference",
    "currentPublicationReference",
    "contentDigest",
    "originalIntentDigest",
    "observedAt",
    "validUntil",
    "effectiveFrom",
    "effectiveUntil",
    "storeRecipeOverrideAllowed",
  ];
  if (
    !value ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== fields.length
  )
    throw new Error("invalid policy");
  const r: Record<string, unknown> = {};
  for (const key of fields) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d?.enumerable || !("value" in d)) throw new Error("invalid policy descriptor");
    r[key] = d.value;
  }
  const observedAt = parseRecipeReferenceSourceInstant(r.observedAt),
    validUntil = parseRecipeReferenceSourceInstant(r.validUntil),
    effectiveFrom = parseRecipeReferenceSourceInstant(r.effectiveFrom),
    effectiveUntil =
      r.effectiveUntil === null ? null : parseRecipeReferenceSourceInstant(r.effectiveUntil);
  if (
    r.profile !== "CurrentRecipeStoreOverridePolicyV1" ||
    parseRecipeReference(r.brandReference) !== request.brandReference ||
    parseRecipeDigest(r.originalIntentDigest) !== request.catalogIntentDigest ||
    observedAt > now ||
    now >= validUntil ||
    validUntil <= observedAt ||
    Date.parse(validUntil) - Date.parse(observedAt) > 30000 ||
    effectiveFrom > now ||
    effectiveFrom > activationAt ||
    (effectiveUntil !== null &&
      (effectiveUntil <= effectiveFrom ||
        now >= effectiveUntil ||
        activationAt >= effectiveUntil)) ||
    typeof r.storeRecipeOverrideAllowed !== "boolean"
  )
    throw new Error("unavailable policy");
  return Object.freeze({
    profile: "CurrentRecipeStoreOverridePolicyV1" as const,
    brandReference: request.brandReference,
    configurationVersionReference: parseRecipeReference(r.configurationVersionReference),
    currentPublicationReference: parseRecipeReference(r.currentPublicationReference),
    contentDigest: parseRecipeDigest(r.contentDigest),
    originalIntentDigest: request.catalogIntentDigest,
    observedAt,
    validUntil,
    effectiveFrom,
    effectiveUntil,
    storeRecipeOverrideAllowed: r.storeRecipeOverrideAllowed,
  });
}
/** Resolve only base whole-version bindings for one registered Store. Option modifiers,
 * Store Groups, preparation classification and executable Recipe content remain separate. */
export function resolveCurrentStoreRecipeVersions(input: {
  readonly request: RecipeReferenceSourceRequest;
  readonly target: RecipeCatalogReferenceTarget;
  readonly source: unknown;
  readonly stores: unknown;
  readonly storeReference: string;
  readonly overridePolicy: unknown;
  readonly now: string;
  readonly activationAt: string;
}) {
  try {
    const now = parseRecipeReferenceSourceInstant(input.now),
      activationAt = parseRecipeReferenceSourceInstant(input.activationAt),
      storeReference = parseRecipeReference(input.storeReference);
    if (activationAt < now) throw new Error("past activation");
    const source = parseRecipeReferenceSourceSnapshot(input.source, input.request, now),
      matched = matchRecipeCatalogReferences({ ...input, source }),
      stores = parseTenantStoreReferenceSnapshot(input.stores),
      currentPolicy = policy(input.overridePolicy, input.request, now, activationAt);
    if (
      stores.brandReference !== input.request.brandReference ||
      stores.originalIntentDigest !== input.request.catalogIntentDigest ||
      stores.observedAt > now ||
      Date.parse(now) - Date.parse(stores.observedAt) >= 5000
    )
      throw new Error("stale topology");
    const registered = stores.references.find((s) => s.storeReference === storeReference),
      topology =
        stores.brandLifecycle !== "Active"
          ? "InactiveBrand"
          : !registered
            ? "UnknownStore"
            : registered.lifecycle !== "Active"
              ? "InactiveStore"
              : "CurrentRegisteredActiveStore";
    const skus =
      matched.targetMembership === "Absent"
        ? []
        : matched.target.skuReference === null
          ? matched.target.skuReferences
          : [matched.target.skuReference];
    const covers = (p: { effectiveFrom: string; effectiveUntil: string | null }) =>
      p.effectiveFrom <= activationAt &&
      (p.effectiveUntil === null || activationAt < p.effectiveUntil);
    const roots = new Map(source.recipes.map((r) => [r.recipeReference, r])),
      versions = new Map(source.versions.map((v) => [v.recipeVersionReference, v]));
    const resolutions = skus.map((skuReference) => {
      // An applicable bad override must not be discarded in favour of a good Brand default.
      const applicable = source.bindings.filter(
        (b) =>
          b.skuReference === skuReference &&
          b.optionBindingReference === null &&
          (b.storeReference === null || b.storeReference === storeReference) &&
          covers(b),
      );
      const overrides = applicable.filter((b) => b.storeReference === storeReference),
        defaults = applicable.filter((b) => b.storeReference === null),
        candidates = overrides.length > 0 ? overrides : defaults;
      const b = candidates[0],
        version = b ? versions.get(b.recipeVersionReference) : undefined,
        root = b ? roots.get(b.recipeReference) : undefined;
      const status =
        topology !== "CurrentRegisteredActiveStore"
          ? topology
          : overrides.length > 0 && currentPolicy === null
            ? "OverridePolicyUnavailable"
            : overrides.length > 0 && !currentPolicy?.storeRecipeOverrideAllowed
              ? "StoreOverrideDenied"
              : candidates.length === 0
                ? "MissingRecipeBinding"
                : candidates.length !== 1
                  ? "AmbiguousRecipeBinding"
                  : !version ||
                      !root ||
                      root.currentVersionReference !== version.recipeVersionReference
                    ? "StaleRecipeVersion"
                    : version.lifecycle !== "Published"
                      ? "UnpublishedRecipeVersion"
                      : !covers(version)
                        ? "InactiveRecipeActivationPeriod"
                        : "ResolvedStoredVersion";
      return Object.freeze({
        skuReference,
        storeReference,
        status,
        source: overrides.length > 0 ? ("StoreOverride" as const) : ("BrandDefault" as const),
        candidateBindingReferences: Object.freeze(candidates.map((c) => c.bindingReference).sort()),
        selectedBindingReference:
          status === "ResolvedStoredVersion" && b ? b.bindingReference : null,
        recipeReference: status === "ResolvedStoredVersion" && b ? b.recipeReference : null,
        recipeVersionReference:
          status === "ResolvedStoredVersion" && b ? b.recipeVersionReference : null,
      });
    });
    const body = {
      profile: "CurrentStoreRecipeResolutionV1" as const,
      brandReference: input.request.brandReference,
      productReference: matched.target.productReference,
      productVersionReference: matched.target.versionReference,
      catalogConfigurationDigest: matched.target.catalogConfigurationDigest,
      recipeSourceDigest: source.digest,
      recipeGeneration: source.generation,
      storeSourceDigest: "sha256:" + sha256Hex(canonicalizeRfc8785(stores)),
      storeGeneration: stores.generation,
      storeReference,
      storeVersion: registered?.version ?? null,
      operationReference: input.request.operationReference,
      originalIntentDigest: input.request.catalogIntentDigest,
      assessedAt: now,
      activationAt,
      topology,
      overridePolicy: currentPolicy,
      resolutions: Object.freeze(resolutions),
      decision:
        skus.length > 0 && resolutions.every((r) => r.status === "ResolvedStoredVersion")
          ? ("PassForDirectBrandAndStoreBindings" as const)
          : ("HardError" as const),
      storeGroupResolution: "NotSupportedBySource" as const,
      preparationClassification: "NotEvaluated" as const,
      optionModifiers: "NotEvaluated" as const,
      ingredientsAndImpacts: "NotEvaluated" as const,
      eligibility: "NotEvaluated" as const,
    };
    return Object.freeze({ ...body, digest: "sha256:" + sha256Hex(canonicalizeRfc8785(body)) });
  } catch {
    throw new RecipeWorkflowError("RECIPE_DEPENDENCY_UNAVAILABLE");
  }
}
