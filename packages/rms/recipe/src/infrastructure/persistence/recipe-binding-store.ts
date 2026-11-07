import { createRecipeSnapshot, parseRecipeReference } from "../../domain/recipe.js";
import { RecipeWorkflowError } from "../../application/recipe-service.js";
import type { RecipeTransactionRunner } from "./recipe-query-store.js";
function fail(): never {
  throw new RecipeWorkflowError("RECIPE_EVIDENCE_INCOMPLETE");
}
/** Resolves only the base SKU Recipe. Option modifiers must be applied separately. A binding no longer
 * applies from the instant it was ended (superseded by a revision or removed; DEC-RECIPE-AUTHORING). */
export function createPostgresBaseRecipeSource(
  runner: RecipeTransactionRunner,
  brandInput: string,
) {
  const brand = parseRecipeReference(brandInput);
  return Object.freeze({
    async resolve(
      input: Readonly<{ storeReference: string; skuReference: string; occurredAt: string }>,
    ) {
      const store = parseRecipeReference(input.storeReference),
        sku = parseRecipeReference(input.skuReference);
      const at = input.occurredAt;
      if (
        typeof at !== "string" ||
        !Number.isFinite(Date.parse(at)) ||
        new Date(at).toISOString() !== at
      )
        return fail();
      try {
        return await runner.run(async (tx) => {
          await tx.query(
            "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
            [brand, store],
          );
          const result = await tx.query(
            "SELECT b.recipe_scope_binding_id AS binding,b.store_id AS store,v.snapshot_json AS snapshot,c.lifecycle AS current_lifecycle FROM rms_recipe.recipe_scope_binding b JOIN rms_recipe.recipe_version v ON v.recipe_version_id=b.recipe_version_id AND v.recipe_id=b.recipe_id AND v.brand_id=b.brand_id JOIN rms_recipe.recipe r ON r.recipe_id=b.recipe_id AND r.brand_id=b.brand_id LEFT JOIN rms_recipe.recipe_version c ON c.recipe_version_id=r.current_version_id AND c.recipe_id=r.recipe_id AND c.brand_id=r.brand_id WHERE b.brand_id=$1 AND b.sku_id=$2 AND (b.store_id IS NULL OR b.store_id=$3) AND b.option_binding_id IS NULL AND b.effective_from<=$4::timestamptz AND (b.effective_until IS NULL OR b.effective_until>$4::timestamptz) AND NOT EXISTS (SELECT 1 FROM rms_recipe.recipe_scope_binding_end e WHERE e.recipe_scope_binding_id=b.recipe_scope_binding_id AND e.ended_at<=$4::timestamptz)",
            [brand, sku, store, at],
          );
          if (result === null || typeof result !== "object") return fail();
          const d = Object.getOwnPropertyDescriptor(result, "rows");
          if (!d || !("value" in d) || !Array.isArray(d.value) || d.value.length > 256)
            return fail();
          const rows = d.value as {
            binding: unknown;
            store: unknown;
            snapshot: unknown;
            current_lifecycle: unknown;
          }[];
          if (
            rows.some(
              (row) =>
                row === null ||
                typeof row !== "object" ||
                (row.store !== null && row.store !== store),
            )
          )
            return fail();
          const local = rows.filter((row) => row.store === store),
            candidates = local.length ? local : rows;
          if (candidates.length !== 1) return fail();
          const selected = candidates[0];
          if (!selected || selected.current_lifecycle !== "Published") return fail();
          const snapshot = createRecipeSnapshot(selected.snapshot as never);
          if (
            snapshot.brandReference !== brand ||
            snapshot.lifecycle !== "Published" ||
            snapshot.createdAt > at ||
            snapshot.effectivePeriod.effectiveFrom.instant > at ||
            (snapshot.effectivePeriod.effectiveUntil !== null &&
              snapshot.effectivePeriod.effectiveUntil.instant <= at)
          )
            return fail();
          return Object.freeze({
            bindingReference: parseRecipeReference(selected.binding),
            brandReference: brand,
            storeReference: store,
            skuReference: sku,
            observedAt: at,
            snapshot,
          });
        });
      } catch {
        return fail();
      }
    },
  });
}
