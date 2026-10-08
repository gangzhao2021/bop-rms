import { confirmActiveBrandMembers, type MemberDirectoryTransaction } from "@bop/membership";
import { brandActionHeldBy, type RoleAssignmentTransaction } from "@bop/permission";
import {
  listBrandOptionSets,
  listBrandProducts,
  loadBrandProduct,
  type ProductLifecycleTransaction,
} from "@rms/catalog";
import {
  listOptionRecipeChanges,
  OptionRecipeChangeError,
  optionRecipeCovered,
  parseOptionRecipeChangeContent,
  publishOptionRecipeChange,
  reviewOptionRecipeChange,
  saveOptionRecipeChange,
  type OptionRecipeChangeContent,
  type OptionRecipeTarget,
  type RecipeAuthoringTransaction,
} from "@rms/recipe";
import { createMerchantBrandScope } from "./merchant-brand-scope.js";
import type { MerchantBffService } from "./merchant-bff.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import { recipeIngredientItems } from "./recipe-ingredient-items.js";
import { retryTransactionConflict } from "./transaction-conflict-retry.js";

/**
 * WP-2423 slice 4.4: RECIPE-OPTION-LIST — what choosing each option of a product does to its recipes
 * (no change; replace an ingredient with another in the same amount; add an amount per unit chosen;
 * remove an ingredient). Saving (recipe.update) writes the explicit rules for every recipe of the
 * product's sizes and every choosable quantity; a Cost and a FoodSafety reviewer (recipe.approve,
 * two people other than the author) approve them; a publisher (recipe.publish) publishes them. The
 * menu review then discloses each option's allergens from those rules, and orders use stock and
 * kitchen instructions accordingly.
 */
export class MerchantOptionRecipeError extends Error {
  constructor(
    readonly code:
      | "PermissionDenied"
      | "NotFound"
      | "Conflict"
      | "NoRecipe"
      | "IngredientMissing"
      | "IngredientPresent"
      | "UnitMismatch"
      | "ItemUnavailable"
      | "AllergenUndeclared"
      | "ReviewRequired"
      | "ReviewerNotIndependent"
      | "Invalid",
    readonly skuReference: string | null = null,
  ) {
    super(code);
    this.name = "MerchantOptionRecipeError";
  }
}
const fail = (code: MerchantOptionRecipeError["code"], sku: string | null = null): never => {
  throw new MerchantOptionRecipeError(code, sku);
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ref = (value: unknown): string =>
  typeof value === "string" && uuid.test(value) ? value : fail("Invalid");
const keysOf = (r: Record<string, unknown>) => Object.keys(r).sort().join(",");

export type OptionRecipeCommandBody =
  | {
      readonly action: "Save";
      readonly operationReference: string;
      readonly bindingReference: string;
      readonly optionReference: string;
      readonly expectedVersion: number | null;
      readonly change: OptionRecipeChangeContent;
    }
  | {
      readonly action: "Review";
      readonly operationReference: string;
      readonly changeVersionReference: string;
      readonly kind: "Cost" | "FoodSafety";
      readonly decision: "Approved" | "Rejected";
      readonly comment: string | null;
    }
  | {
      readonly action: "Publish";
      readonly operationReference: string;
      readonly changeVersionReference: string;
    };
export function parseOptionRecipeCommandBody(value: unknown): OptionRecipeCommandBody {
  const r = value as Record<string, unknown> | null;
  if (r === null || typeof r !== "object" || Array.isArray(r)) return fail("Invalid");
  if (
    r.action === "Save" &&
    keysOf(r) ===
      "action,bindingReference,change,expectedVersion,operationReference,optionReference"
  ) {
    const expected = r.expectedVersion;
    if (expected !== null && !(Number.isSafeInteger(expected) && (expected as number) >= 1))
      return fail("Invalid");
    let change: OptionRecipeChangeContent;
    try {
      change = parseOptionRecipeChangeContent(r.change);
    } catch {
      return fail("Invalid");
    }
    return {
      action: "Save",
      operationReference: ref(r.operationReference),
      bindingReference: ref(r.bindingReference),
      optionReference: ref(r.optionReference),
      expectedVersion: expected as number | null,
      change,
    };
  }
  if (
    r.action === "Review" &&
    keysOf(r) === "action,changeVersionReference,comment,decision,kind,operationReference" &&
    (r.kind === "Cost" || r.kind === "FoodSafety") &&
    (r.decision === "Approved" || r.decision === "Rejected")
  ) {
    const comment =
      r.comment === null
        ? null
        : typeof r.comment === "string" &&
            r.comment.trim() === r.comment &&
            r.comment.length >= 1 &&
            r.comment.length <= 500 &&
            !/[\p{Cc}\p{Cf}]/u.test(r.comment)
          ? r.comment
          : fail("Invalid");
    // A rejection explains itself to the author.
    if (r.decision === "Rejected" && comment === null) return fail("Invalid");
    return {
      action: "Review",
      operationReference: ref(r.operationReference),
      changeVersionReference: ref(r.changeVersionReference),
      kind: r.kind,
      decision: r.decision,
      comment,
    };
  }
  if (r.action === "Publish" && keysOf(r) === "action,changeVersionReference,operationReference")
    return {
      action: "Publish",
      operationReference: ref(r.operationReference),
      changeVersionReference: ref(r.changeVersionReference),
    };
  return fail("Invalid");
}

const changeErrors: Record<OptionRecipeChangeError["code"], MerchantOptionRecipeError["code"]> = {
  OPTION_RECIPE_INVALID: "Invalid",
  OPTION_RECIPE_NO_RECIPE: "NoRecipe",
  OPTION_RECIPE_INGREDIENT_MISSING: "IngredientMissing",
  OPTION_RECIPE_INGREDIENT_PRESENT: "IngredientPresent",
  OPTION_RECIPE_UNIT_MISMATCH: "UnitMismatch",
  OPTION_RECIPE_ITEM_UNAVAILABLE: "ItemUnavailable",
  OPTION_RECIPE_ALLERGEN_UNDECLARED: "AllergenUndeclared",
  OPTION_RECIPE_CONFLICT: "Conflict",
  OPTION_RECIPE_NOT_FOUND: "NotFound",
  OPTION_RECIPE_REVIEW_REQUIRED: "ReviewRequired",
  OPTION_RECIPE_REVIEWER_NOT_INDEPENDENT: "ReviewerNotIndependent",
};

export function createMerchantOptionRecipes(options: {
  persistence: PersistentMerchantBffOptions;
  authentication: Pick<MerchantBffService, "authorize">;
  locale: string;
  /** Test seam: the Brand scope resolver (defaults to the current session's Brand scope). */
  resolveScope?: ReturnType<typeof createMerchantBrandScope>;
}) {
  const resolveScope = options.resolveScope ?? createMerchantBrandScope(options.persistence);
  type Tx = Parameters<Parameters<typeof options.persistence.transactions.run>[0]>[0];
  const rtx = (tx: Tx) => tx as unknown as RecipeAuthoringTransaction;
  const ctx = (tx: Tx) => tx as unknown as ProductLifecycleTransaction;
  const session = (input: { sessionCookie: unknown; csrf: unknown }) =>
    options.authentication
      .authorize({ sessionCookie: input.sessionCookie, csrf: input.csrf })
      .catch(() => fail("PermissionDenied"));
  async function scopeFor(tx: Tx, sessionCookie: unknown, sessionReference: string) {
    const scope = await resolveScope(tx, sessionCookie, sessionReference).catch(() =>
      fail("PermissionDenied"),
    );
    const may = async (action: string) => (await scope.authorizeAction(action))?.effect === "Allow";
    const permissions = {
      // Option recipe changes are recipe facts: recipe reviewers see the products' options here.
      mayRead: await may("recipe.read"),
      mayEdit: await may("recipe.update"),
      mayReview: await may("recipe.approve"),
      mayPublish: await may("recipe.publish"),
    };
    if (!permissions.mayRead) fail("PermissionDenied");
    return {
      tenantReference: String(scope.tenantReference),
      brandReference: String(scope.context.brand.brandReference),
      storeReference: String(scope.selectedStoreReference),
      actor: String(scope.actorReference),
      permissions,
    };
  }
  type Scope = Awaited<ReturnType<typeof scopeFor>>;
  const name = (names: Readonly<Record<string, string>>, fallback = "") =>
    names[options.locale] ?? Object.values(names)[0] ?? fallback;

  /** Each product option and what a change must cover: the product's sizes and quantities. */
  async function targets(tx: Tx, s: Scope) {
    const sets = await listBrandOptionSets(ctx(tx), { brandReference: s.brandReference });
    const rows = [];
    for (const summary of await listBrandProducts(ctx(tx) as never, {
      brandReference: s.brandReference,
    })) {
      const product = await loadBrandProduct(
        ctx(tx) as never,
        { brandReference: s.brandReference },
        summary.productReference,
      );
      if (product === null) continue;
      for (const binding of product.draft.optionBindings) {
        const set = sets.find((item) => item.optionSetReference === binding.optionSetReference);
        if (set === undefined) continue;
        const most = set.draft.allowRepeatedOption ? set.draft.perOptionMaximumQuantity : 1;
        for (const option of set.draft.options)
          if (binding.enabledOptionReferences.includes(option.optionReference))
            rows.push({
              productName: name(product.draft.localizedNames, product.internalCode),
              setName: name(set.draft.localizedNames, set.internalCode),
              optionName: name(option.localizedNames, option.stableCode),
              offered: option.lifecycle === "Active",
              target: {
                bindingReference: String(binding.bindingReference),
                optionReference: String(option.optionReference),
                skuReferences: product.draft.skus
                  .filter((sku) => sku.lifecycle !== "Archived")
                  .map((sku) => String(sku.skuReference)),
                quantities: Array.from({ length: most }, (_, index) => index + 1),
              } satisfies OptionRecipeTarget,
              sizes: product.draft.skus.map((sku) => ({
                skuReference: String(sku.skuReference),
                name: name(sku.localizedNames, sku.skuCode),
              })),
            });
      }
    }
    return rows;
  }
  const mapError = (error: unknown): never => {
    if (error instanceof MerchantOptionRecipeError) throw error;
    if (error instanceof OptionRecipeChangeError)
      return fail(changeErrors[error.code], error.skuReference);
    throw error;
  };

  const query = async (input: { sessionCookie: unknown; csrf: unknown }) => {
    const current = await session(input);
    return retryTransactionConflict(() =>
      options.persistence.transactions.run(async (tx) => {
        const s = await scopeFor(tx, input.sessionCookie, current.sessionReference);
        const at = options.persistence.now();
        const rows = await targets(tx, s);
        const scope = { brandReference: s.brandReference, storeReference: s.storeReference };
        const changes = await listOptionRecipeChanges(
          rtx(tx),
          scope,
          rows.map((row) => row.target),
        );
        const ingredients = await recipeIngredientItems(tx, s, at);
        const options_ = [];
        for (const row of rows) {
          const change =
            changes.get(row.target.bindingReference + ":" + row.target.optionReference) ?? null;
          options_.push({
            productName: row.productName,
            setName: row.setName,
            optionName: row.optionName,
            offered: row.offered,
            bindingReference: row.target.bindingReference,
            optionReference: row.target.optionReference,
            quantities: row.target.quantities,
            sizes: row.sizes,
            covered: await optionRecipeCovered(rtx(tx), scope, row.target, at),
            change:
              change === null
                ? null
                : {
                    changeVersionReference: change.changeVersionReference,
                    version: change.version,
                    content: change.content,
                    byViewer: change.authorReference === s.actor,
                    recordedAt: change.recordedAt,
                    published: change.publishedAt !== null,
                    reviews: change.reviews.map((review) => ({
                      kind: review.kind,
                      decision: review.decision,
                      byViewer: review.reviewerReference === s.actor,
                      comment: review.comment,
                      reviewedAt: review.reviewedAt,
                    })),
                    lines: change.expansion.map((entry) => ({
                      skuReference: entry.skuReference,
                      quantity: entry.quantity,
                      changes: entry.lines,
                    })),
                  },
          });
        }
        return {
          screenId: "RECIPE-OPTION-LIST" as const,
          sourceAsOf: at,
          permissions: s.permissions,
          ingredients: ingredients.items
            .filter((item) => item.stockTracked && item.active)
            .map((item) => ({
              itemReference: item.itemReference,
              name: name(item.localizedNames, item.internalCode),
              unitCode: item.unitCode,
              declared: ingredients.declarationOf(item) !== null,
              // Cents per base unit from the latest receipt, as the decimal text a change takes.
              latestUnitCostCents:
                item.latestUnitCostMinor === null ? null : String(item.latestUnitCostMinor),
            })),
          options: options_,
        };
      }),
    );
  };

  const command = async (input: { sessionCookie: unknown; csrf: unknown; body: unknown }) => {
    const body = parseOptionRecipeCommandBody(input.body);
    const current = await session(input);
    return retryTransactionConflict(() =>
      options.persistence.transactions.run(async (tx) => {
        const s = await scopeFor(tx, input.sessionCookie, current.sessionReference);
        const at = options.persistence.now();
        const scope = { brandReference: s.brandReference, storeReference: s.storeReference };
        try {
          if (body.action === "Save") {
            if (!s.permissions.mayEdit) fail("PermissionDenied");
            const row = (await targets(tx, s)).find(
              (item) =>
                item.target.bindingReference === body.bindingReference &&
                item.target.optionReference === body.optionReference,
            );
            if (row === undefined) return fail("NotFound");
            const { facts } = await recipeIngredientItems(tx, s, at);
            return await saveOptionRecipeChange(rtx(tx), scope, {
              operationReference: body.operationReference,
              actorReference: s.actor,
              at,
              target: row.target,
              content: body.change,
              items: facts,
              expectedVersion: body.expectedVersion,
            });
          }
          if (body.action === "Review") {
            if (!s.permissions.mayReview) fail("PermissionDenied");
            return await reviewOptionRecipeChange(rtx(tx), scope, {
              operationReference: body.operationReference,
              actorReference: s.actor,
              at,
              changeVersionReference: body.changeVersionReference,
              kind: body.kind,
              decision: body.decision,
              comment: body.comment,
            });
          }
          if (!s.permissions.mayPublish) fail("PermissionDenied");
          return await publishOptionRecipeChange(rtx(tx), scope, {
            operationReference: body.operationReference,
            actorReference: s.actor,
            at,
            changeVersionReference: body.changeVersionReference,
            reviewersAuthorized: async (actors) =>
              (await brandActionHeldBy(tx as unknown as RoleAssignmentTransaction, {
                brandReference: s.brandReference,
                actorReferences: actors,
                action: "recipe.approve",
                at,
              })) &&
              (await confirmActiveBrandMembers(tx as unknown as MemberDirectoryTransaction, {
                brandReference: s.brandReference,
                actorReferences: actors,
                at,
              })),
          });
        } catch (error) {
          return mapError(error);
        }
      }),
    );
  };
  return { query, command };
}
