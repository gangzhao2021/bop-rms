import {
  parseRecipeInventoryProductPublicationReferenceRequestV2,
  type RecipeInventoryProductPublicationReferenceRequestV2,
} from "./product-publication-reference-request-v2.js";
import {
  parseRecipeInventoryProductPublicationReferenceSnapshotV2,
  type RecipeInventoryReferenceSnapshot,
} from "./recipe-inventory-reference-source.js";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { parseRecipeReference } from "../domain/recipe.js";
import { RecipeWorkflowError } from "../application/recipe-service.js";
import {
  parseRecipeInventoryReferenceSnapshot,
  parseRecipeInventoryReferenceRequest,
  recipeInventoryReferenceMaximumRows,
  type RecipeInventoryReferenceRequest,
  type RecipeIngredientReference,
  type RecipeInventoryModifierReference,
  type RecipeInventoryChangeReference,
} from "./recipe-inventory-reference-source.js";
interface Context {
  readonly rootRecipeVersionReference: string;
  readonly ownerRecipeVersionReference: string;
  readonly conditional: boolean;
}
export type RecipeInventoryReachableRequirement =
  | (Context & {
      readonly kind: "BaseIngredient";
      readonly reference: RecipeIngredientReference;
      readonly modifier: null;
    })
  | (Context & {
      readonly kind: "ModifierAdd" | "ModifierReplace";
      readonly reference: Extract<RecipeInventoryChangeReference, { action: "Add" | "Replace" }>;
      readonly modifier: RecipeInventoryModifierReference;
    })
  | (Context & {
      readonly kind: "ModifierRemove";
      readonly reference: Extract<RecipeInventoryChangeReference, { action: "Remove" }>;
      readonly modifier: RecipeInventoryModifierReference;
    });
const fail = (): never => {
  throw new RecipeWorkflowError("RECIPE_DEPENDENCY_UNAVAILABLE");
};
function list(value: unknown, maximum: number): unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > maximum ||
    Reflect.ownKeys(value).length !== value.length + 1
  )
    return fail();
  return Array.from({ length: value.length }, (_, i) => {
    const d = Object.getOwnPropertyDescriptor(value, String(i));
    return d?.enumerable && "value" in d ? d.value : fail();
  });
}
/** Pure stored reachability. Roots come from the consumer's independently validated
 * Catalog/Recipe reference graphs; this function supplies no Catalog authority.
 * All historical conditional changes are retained, never applied as a combined recipe. */
export function matchRecipeInventoryReferenceRoots(input: {
  readonly request: RecipeInventoryReferenceRequest;
  readonly rootGroups: unknown;
  readonly source: unknown;
  readonly now: string;
}) {
  try {
    const request = parseRecipeInventoryReferenceRequest(input.request),
      source = parseRecipeInventoryReferenceSnapshot(input.source, request, input.now);
    return matchRoots(request, source, input.rootGroups);
  } catch {
    return fail();
  }
}
function matchRoots<
  Request extends
    RecipeInventoryReferenceRequest | RecipeInventoryProductPublicationReferenceRequestV2,
>(
  request: Request,
  source: Pick<
    RecipeInventoryReferenceSnapshot,
    | "recipes"
    | "versions"
    | "ingredients"
    | "modifiers"
    | "changes"
    | "digest"
    | "generation"
    | "observedAt"
  >,
  rootGroups: unknown,
) {
  try {
    const groups = list(rootGroups, 1001).map((value) => {
      const roots = list(value, 1000).map(parseRecipeReference);
      if (new Set(roots).size !== roots.length) return fail();
      return Object.freeze(roots.sort());
    });
    if (groups.length === 0) return fail();
    const versions = new Map(source.versions.map((v) => [v.recipeVersionReference, v])),
      recipes = new Map(source.recipes.map((r) => [r.recipeReference, r]));
    const ingredients = new Map<string, RecipeIngredientReference[]>(),
      modifiers = new Map<string, RecipeInventoryModifierReference[]>(),
      changes = new Map<string, RecipeInventoryChangeReference[]>();
    for (const i of source.ingredients) {
      const rows = ingredients.get(i.recipeVersionReference) ?? [];
      rows.push(i);
      ingredients.set(i.recipeVersionReference, rows);
    }
    for (const m of source.modifiers) {
      const rows = modifiers.get(m.recipeVersionReference) ?? [];
      rows.push(m);
      modifiers.set(m.recipeVersionReference, rows);
    }
    for (const c of source.changes) {
      const rows = changes.get(c.ruleVersionReference) ?? [];
      rows.push(c);
      changes.set(c.ruleVersionReference, rows);
    }
    let budget =
      source.recipes.length +
      source.versions.length +
      source.ingredients.length +
      source.modifiers.length +
      source.changes.length;
    const consume = (count = 1) => {
      budget += count;
      if (budget > recipeInventoryReferenceMaximumRows) return fail();
    };
    return Object.freeze(
      groups.map((roots) => {
        const requirements: RecipeInventoryReachableRequirement[] = [],
          reachableVersions: Readonly<{
            rootRecipeVersionReference: string;
            version: (typeof source.versions)[number];
            conditional: boolean;
            isCurrentRecipeVersion: boolean;
          }>[] = [];
        for (const root of roots) {
          if (!versions.has(root)) return fail();
          consume();
          const queue: { version: string; conditional: boolean }[] = [
              { version: root, conditional: false },
            ],
            seen = new Set<string>(),
            emitted = new Set<string>();
          for (const node of queue) {
            if (!node) return fail();
            const key = node.version + ":" + String(node.conditional);
            if (seen.has(key)) continue;
            seen.add(key);
            const version = versions.get(node.version),
              recipe = version && recipes.get(version.recipeReference);
            if (!version || !recipe) return fail();
            consume(2);
            reachableVersions.push(
              Object.freeze({
                rootRecipeVersionReference: root,
                version,
                conditional: node.conditional,
                isCurrentRecipeVersion:
                  recipe.currentVersionReference === version.recipeVersionReference,
              }),
            );
            const append = (row: RecipeInventoryReachableRequirement) => {
              const rowKey =
                row.ownerRecipeVersionReference +
                ":" +
                String(row.conditional) +
                ":" +
                row.kind +
                ":" +
                (row.kind === "BaseIngredient"
                  ? row.reference.requirementReference
                  : row.reference.ruleVersionReference + ":" + row.reference.sequence);
              if (emitted.has(rowKey)) return;
              emitted.add(rowKey);
              consume(row.modifier === null ? 1 : 2);
              requirements.push(Object.freeze(row));
              if (row.kind !== "ModifierRemove" && row.reference.sourceKind === "SubRecipe")
                queue.push({
                  version: row.reference.sourceVersionReference,
                  conditional: row.conditional,
                });
            };
            for (const reference of ingredients.get(node.version) ?? [])
              append({
                rootRecipeVersionReference: root,
                ownerRecipeVersionReference: node.version,
                conditional: node.conditional,
                kind: "BaseIngredient",
                reference,
                modifier: null,
              });
            for (const modifier of modifiers.get(node.version) ?? [])
              for (const reference of changes.get(modifier.ruleVersionReference) ?? []) {
                const context = {
                  rootRecipeVersionReference: root,
                  ownerRecipeVersionReference: node.version,
                  conditional: true,
                  modifier,
                };
                if (reference.action === "Remove")
                  append({ ...context, kind: "ModifierRemove", reference });
                else
                  append({
                    ...context,
                    kind: reference.action === "Add" ? "ModifierAdd" : "ModifierReplace",
                    reference,
                  });
              }
          }
        }
        const body = {
          request,
          rootRecipeVersionReferences: roots,
          coverage: "CompleteStoredReachableRecipeReferences" as const,
          applicability: "Unavailable" as const,
          conditionalApplicability: "Unavailable" as const,
          removalResolution: "Unavailable" as const,
          conditionalCycleResolution: "Unavailable" as const,
          recipeInventorySourceDigest: source.digest,
          recipeGeneration: source.generation,
          reachableVersions: Object.freeze(reachableVersions),
          requirements: Object.freeze(requirements),
        };
        return Object.freeze({
          ...body,
          digest: "sha256:" + sha256Hex(canonicalizeRfc8785(body)),
          observedAt: source.observedAt,
        });
      }),
    );
  } catch {
    return fail();
  }
}

export function matchRecipeInventoryProductPublicationReferenceRootsV2(input: {
  readonly request: RecipeInventoryProductPublicationReferenceRequestV2;
  readonly rootGroups: unknown;
  readonly source: unknown;
  readonly now: string;
}) {
  try {
    const request = parseRecipeInventoryProductPublicationReferenceRequestV2(input.request),
      source = parseRecipeInventoryProductPublicationReferenceSnapshotV2(
        input.source,
        request,
        input.now,
      );
    return matchRoots(request, source, input.rootGroups);
  } catch {
    return fail();
  }
}
