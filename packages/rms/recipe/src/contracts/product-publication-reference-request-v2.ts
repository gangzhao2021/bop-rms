import { RecipeWorkflowError } from "../application/recipe-service.js";
import { parseRecipeDigest, parseRecipeReference } from "../domain/recipe.js";

interface PublicationReferenceBinding {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly actorReference: string;
  readonly actorKind: "User" | "System";
  readonly operationReference: string;
  readonly productReference: string;
  readonly versionReference: string;
  readonly originalIntentDigest: string;
  readonly replacementIntentDigest: string;
  readonly aggregateSnapshotDigest: string;
  readonly currentPublicationDigest: string | null;
  readonly observedAt: string;
  readonly validUntil: string;
}
export interface RecipeProductPublicationReferenceRequestV2 extends PublicationReferenceBinding {
  readonly profile: "RecipeProductPublicationReferenceRequestV2";
  readonly purposeCode: "CATALOG_PRODUCT_PUBLICATION_RECIPE_SOURCE_READ";
}
export interface RecipeInventoryProductPublicationReferenceRequestV2 extends PublicationReferenceBinding {
  readonly profile: "RecipeInventoryProductPublicationReferenceRequestV2";
  readonly purposeCode: "CATALOG_PRODUCT_PUBLICATION_RECIPE_INVENTORY_SOURCE_READ";
}
const fail = (): never => {
  throw new RecipeWorkflowError("RECIPE_DEPENDENCY_UNAVAILABLE");
};
export const recipeProductPublicationReferenceRequestFieldsV2 = Object.freeze([
  "profile",
  "purposeCode",
  "tenantReference",
  "brandReference",
  "actorReference",
  "actorKind",
  "operationReference",
  "productReference",
  "versionReference",
  "originalIntentDigest",
  "replacementIntentDigest",
  "aggregateSnapshotDigest",
  "currentPublicationDigest",
  "observedAt",
  "validUntil",
] as const);
function instant(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    return fail();
  return value;
}
function binding(
  value: unknown,
  profile: string,
  purposeCode: string,
): PublicationReferenceBinding {
  if (
    !value ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== recipeProductPublicationReferenceRequestFieldsV2.length
  )
    return fail();
  const r: Record<string, unknown> = {};
  for (const field of recipeProductPublicationReferenceRequestFieldsV2) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor?.enumerable || !("value" in descriptor)) return fail();
    r[field] = descriptor.value;
  }
  if (
    r.profile !== profile ||
    r.purposeCode !== purposeCode ||
    (r.actorKind !== "User" && r.actorKind !== "System")
  )
    return fail();
  const observedAt = instant(r.observedAt),
    validUntil = instant(r.validUntil);
  if (validUntil <= observedAt || Date.parse(validUntil) - Date.parse(observedAt) > 5000)
    return fail();
  return {
    tenantReference: parseRecipeReference(r.tenantReference),
    brandReference: parseRecipeReference(r.brandReference),
    actorReference: parseRecipeReference(r.actorReference),
    actorKind: r.actorKind,
    operationReference: parseRecipeReference(r.operationReference),
    productReference: parseRecipeReference(r.productReference),
    versionReference: parseRecipeReference(r.versionReference),
    originalIntentDigest: parseRecipeDigest(r.originalIntentDigest),
    replacementIntentDigest: parseRecipeDigest(r.replacementIntentDigest),
    aggregateSnapshotDigest: parseRecipeDigest(r.aggregateSnapshotDigest),
    currentPublicationDigest:
      r.currentPublicationDigest === null ? null : parseRecipeDigest(r.currentPublicationDigest),
    observedAt,
    validUntil,
  };
}
/** Opaque publication bindings are derived and rebound by the owning Catalog
 * consumer. Recipe validates this explicit purpose, not an unavailable command
 * or its action/current-head rules, and never infers authority from a digest. */
export function parseRecipeProductPublicationReferenceRequestV2(
  value: unknown,
): RecipeProductPublicationReferenceRequestV2 {
  try {
    return Object.freeze({
      profile: "RecipeProductPublicationReferenceRequestV2",
      purposeCode: "CATALOG_PRODUCT_PUBLICATION_RECIPE_SOURCE_READ",
      ...binding(
        value,
        "RecipeProductPublicationReferenceRequestV2",
        "CATALOG_PRODUCT_PUBLICATION_RECIPE_SOURCE_READ",
      ),
    });
  } catch {
    return fail();
  }
}
export function parseRecipeInventoryProductPublicationReferenceRequestV2(
  value: unknown,
): RecipeInventoryProductPublicationReferenceRequestV2 {
  try {
    return Object.freeze({
      profile: "RecipeInventoryProductPublicationReferenceRequestV2",
      purposeCode: "CATALOG_PRODUCT_PUBLICATION_RECIPE_INVENTORY_SOURCE_READ",
      ...binding(
        value,
        "RecipeInventoryProductPublicationReferenceRequestV2",
        "CATALOG_PRODUCT_PUBLICATION_RECIPE_INVENTORY_SOURCE_READ",
      ),
    });
  } catch {
    return fail();
  }
}
