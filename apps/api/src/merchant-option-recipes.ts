import {
  merchantBrandSoleOperatorGate,
  MerchantSingleStoreListingError,
  MerchantSoleOperatorGateError,
  requireMerchantBrandSingleStore,
  requireMerchantBrandSoleOperator,
} from "./merchant-sole-operator.js";
import {
  confirmActiveBrandMembers,
  listStoreMembers,
  memberDisplayNames,
  type MemberDirectoryTransaction,
} from "@bop/membership";
import { brandActionHeldBy, type RoleAssignmentTransaction } from "@bop/permission";
import {
  listBrandOptionSets,
  listBrandProducts,
  loadBrandProduct,
  type ProductLifecycleTransaction,
} from "@rms/catalog";
import {
  listOptionRecipeChanges,
  takeOptionRecipeFence,
  OptionRecipeChangeError,
  optionRecipesCovered,
  parseOptionRecipeChangeContent,
  publishOptionRecipeChange,
  reviewOptionRecipeChange,
  saveOptionRecipeChange,
  type OptionRecipeChangeContent,
  type OptionRecipeTarget,
  type RecipeAuthoringTransaction,
} from "@rms/recipe";
import { withRememberedBrandAuthorization } from "./merchant-brand-transaction-authorization.js";
import { createMerchantBrandScope } from "./merchant-brand-scope.js";
import type { MerchantBffService } from "./merchant-bff.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import { recipeIngredientItems } from "./recipe-ingredient-items.js";
import { createStaffLabels } from "./merchant-staff-labels.js";
import { derivedReference } from "./merchant-products.js";
import { retryTransactionConflict } from "./transaction-conflict-retry.js";
import { staffContentName } from "./staff-content-locale.js";
import { onlyRefusal } from "./merchant-failure.js";

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
      | "Invalid"
      /** WP-2423 Q19: reviewing alone needs sole operator in effect for the reviewer. */
      | "SoleOperatorNotInEffect"
      /** WP-2423 Q19: reviewing alone needs a second-factor check in the last 15 minutes. */
      | "NeedsReverification"
      /** WP-2423 item 8 ⑥: reviewing one's own change alone needs a Brand with exactly one store. */
      | "NotSingleStore",
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
      /** WP-2423 Q19: the sole operator reviews alone (own change, or both kinds); WP-2423 item 8
       * ⑥: the author reviews their own change alone, listing at the Brand's one store. */
      readonly approvalMode?: "SoleOperator" | "SingleStoreListing";
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
  const withMode = r.action === "Review" && Object.hasOwn(r, "approvalMode");
  if (withMode && r.approvalMode !== "SoleOperator" && r.approvalMode !== "SingleStoreListing")
    return fail("Invalid");
  if (
    r.action === "Review" &&
    keysOf(r) ===
      (withMode
        ? "action,approvalMode,changeVersionReference,comment,decision,kind,operationReference"
        : "action,changeVersionReference,comment,decision,kind,operationReference") &&
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
      ...(withMode
        ? { approvalMode: r.approvalMode as "SoleOperator" | "SingleStoreListing" }
        : {}),
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
  OPTION_RECIPE_SOLE_OPERATOR_NOT_IN_EFFECT: "SoleOperatorNotInEffect",
  OPTION_RECIPE_NOT_SINGLE_STORE: "NotSingleStore",
};

/**
 * WP-2423 item 3: the most rules one transaction of a dish save writes. A guest's order and kitchen
 * intake at any merchant on this database wait behind the hold with a 2 s lock timeout, so a batch
 * stays near 0.3 s; a choice with more rules than this (up to 20 of each) goes alone.
 */
export const OPTION_RECIPE_RULES_PER_TRANSACTION = 12;

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
      .catch(onlyRefusal(() => fail("PermissionDenied")));
  async function scopeFor(tx: Tx, sessionCookie: unknown, sessionReference: string) {
    const scope = await resolveScope(tx, sessionCookie, sessionReference).catch(
      onlyRefusal(() => fail("PermissionDenied")),
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
    staffContentName(names, options.locale) || fallback;

  /**
   * Each product option and what a change must cover: the product's sizes and quantities. With a
   * `productReference`, that one dish only (a dish save never reads the rest of the menu).
   */
  async function targets(tx: Tx, s: Scope, productReference: string | null = null) {
    const sets = await listBrandOptionSets(ctx(tx), { brandReference: s.brandReference });
    const rows = [];
    const products =
      productReference !== null
        ? [productReference]
        : (
            await listBrandProducts(ctx(tx) as never, {
              brandReference: s.brandReference,
            })
          ).map((summary) => summary.productReference);
    for (const reference of products) {
      const product = await loadBrandProduct(
        ctx(tx) as never,
        { brandReference: s.brandReference },
        reference,
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
  const changeOf = (
    found: Awaited<ReturnType<typeof listOptionRecipeChanges>>,
    target: OptionRecipeTarget,
  ) => found.get(target.bindingReference + ":" + target.optionReference) ?? null;
  const mapError = (error: unknown): never => {
    if (error instanceof MerchantOptionRecipeError) throw error;
    if (error instanceof OptionRecipeChangeError)
      return fail(changeErrors[error.code], error.skuReference);
    if (error instanceof MerchantSoleOperatorGateError)
      return fail(error.code === "NotInEffect" ? "SoleOperatorNotInEffect" : "NeedsReverification");
    if (error instanceof MerchantSingleStoreListingError)
      return fail(error.code === "NotSingleStore" ? "NotSingleStore" : "PermissionDenied");
    throw error;
  };

  /** WP-2423 Q19 and item 8 ⑥: the Brand's recipe review gates, read in this transaction. */
  function reviewGates(tx: Tx, s: Scope, at: string) {
    const gateInput = (actor: string) => ({
      tenantReference: s.tenantReference,
      brandReference: s.brandReference,
      storeReference: s.storeReference,
      actorReference: actor,
      permissionCode: "recipe.approve",
      observedAt: at,
      allowed: async () => s.permissions.mayReview || s.permissions.mayPublish,
    });
    // The author's own single-store listing review: they hold recipe approval and the Brand has
    // exactly this one store (held until this commits).
    const singleStore = (actor: string) =>
      requireMerchantBrandSingleStore(tx as never, {
        brandReference: s.brandReference,
        storeReference: s.storeReference,
        actorReference: actor,
        permissionCode: "recipe.approve",
        observedAt: at,
        allowed: async () => s.permissions.mayReview || s.permissions.mayPublish,
      });
    return { gateInput, singleStore };
  }
  /**
   * What publishing a change asks about its reviewers, answered in this transaction. Each answer
   * is remembered for the rest of the transaction: a dish save publishes many changes by the same
   * reviewers, and these reads have no business inside its hold on the recipe fence.
   */
  function publishChecks(tx: Tx, s: Scope, at: string) {
    const { gateInput, singleStore } = reviewGates(tx, s, at);
    const once = <T>(memo: Map<string, Promise<T>>, key: string, read: () => Promise<T>) => {
      const known = memo.get(key);
      if (known !== undefined) return known;
      const pending = read();
      memo.set(key, pending);
      return pending;
    };
    const authorized = new Map<string, Promise<boolean>>();
    const soleOperator = new Map<string, Promise<boolean>>();
    const listing = new Map<string, Promise<boolean>>();
    const stillAuthorized = (actor: string) =>
      once(
        authorized,
        actor,
        async () =>
          (await brandActionHeldBy(tx as unknown as RoleAssignmentTransaction, {
            brandReference: s.brandReference,
            actorReferences: [actor],
            action: "recipe.approve",
            at,
          })) &&
          (await confirmActiveBrandMembers(tx as unknown as MemberDirectoryTransaction, {
            brandReference: s.brandReference,
            actorReferences: [actor],
            at,
          })),
      );
    return {
      reviewersAuthorized: async (actors: readonly string[]) => {
        if (actors.length === 0) return false;
        for (const actor of new Set(actors)) if (!(await stillAuthorized(actor))) return false;
        return true;
      },
      soleOperatorEffective: (actor: string) =>
        once(
          soleOperator,
          actor,
          async () =>
            (await merchantBrandSoleOperatorGate(tx as never, gateInput(actor))).status ===
            "Effective",
        ),
      singleStoreListingEffective: (actor: string) =>
        once(listing, actor, async () => {
          try {
            await singleStore(actor);
            return true;
          } catch (error) {
            if (error instanceof MerchantSingleStoreListingError) return false;
            throw error;
          }
        }),
    };
  }

  const query = async (input: { sessionCookie: unknown; csrf: unknown }) => {
    const current = await session(input);
    return retryTransactionConflict(() =>
      options.persistence.transactions.run((tx) =>
        withRememberedBrandAuthorization(tx, async () => {
          const s = await scopeFor(tx, input.sessionCookie, current.sessionReference);
          const at = options.persistence.now();
          const rows = await targets(tx, s);
          const scope = { brandReference: s.brandReference, storeReference: s.storeReference };
          const changes = await listOptionRecipeChanges(
            rtx(tx),
            scope,
            rows.map((row) => row.target),
          );
          const ingredients = await recipeIngredientItems(tx, s, at, { staffDeclared: true });
          // Who saved and who reviewed each change, by name ("You" for the viewer): Store members
          // first, then the Brand's member directory (a Brand Owner need not be assigned here).
          const directory = tx as unknown as MemberDirectoryTransaction;
          const people = new Map<string, string | null>(
            (await listStoreMembers(directory, scope)).map((member) => [
              member.actorReference,
              member.displayName,
            ]),
          );
          const unnamed = [...changes.values()]
            .flatMap((change) => [
              change.authorReference,
              ...change.reviews.map((review) => review.reviewerReference),
            ])
            .filter((actor) => actor !== s.actor && !people.get(actor));
          for (const [actor, displayName] of await memberDisplayNames(directory, scope, unnamed))
            people.set(actor, displayName);
          const label = await createStaffLabels(tx as unknown as RoleAssignmentTransaction, scope, {
            viewer: s.actor,
            at,
            names: people,
          });
          const coverage = await optionRecipesCovered(
            rtx(tx),
            scope,
            rows.map((row) => row.target),
            at,
          );
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
              covered: coverage.get(row.target)?.covered === true,
              change:
                change === null
                  ? null
                  : {
                      changeVersionReference: change.changeVersionReference,
                      version: change.version,
                      content: change.content,
                      byViewer: change.authorReference === s.actor,
                      authorLabel: label(change.authorReference),
                      recordedAt: change.recordedAt,
                      published: change.publishedAt !== null,
                      reviews: change.reviews.map((review) => ({
                        kind: review.kind,
                        decision: review.decision,
                        byViewer: review.reviewerReference === s.actor,
                        reviewerLabel: label(review.reviewerReference),
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
          // WP-2423 Q19: a reviewer who would review their own change, or give the second kind,
          // sees whether they may do it alone as sole operator and why not.
          const gate = s.permissions.mayReview
            ? await merchantBrandSoleOperatorGate(tx as never, {
                tenantReference: s.tenantReference,
                brandReference: s.brandReference,
                storeReference: s.storeReference,
                actorReference: s.actor,
                permissionCode: "recipe.approve",
                observedAt: at,
                allowed: async () => s.permissions.mayReview,
              })
            : null;
          return {
            screenId: "RECIPE-OPTION-LIST" as const,
            sourceAsOf: at,
            permissions: s.permissions,
            soleOperator:
              gate === null
                ? null
                : {
                    status: gate.status,
                    otherApprovers: gate.otherApprovers,
                    verifiedUntil: gate.verifiedUntil,
                  },
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
      ),
    );
  };

  const command = async (input: { sessionCookie: unknown; csrf: unknown; body: unknown }) => {
    const body = parseOptionRecipeCommandBody(input.body);
    const current = await session(input);
    return retryTransactionConflict(() =>
      options.persistence.transactions.run((tx) =>
        withRememberedBrandAuthorization(tx, async () => {
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
              // A combo's choice adds its dish's staff-declared allergen item.
              const { facts } = await recipeIngredientItems(tx, s, at, { staffDeclared: true });
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
            const { gateInput, singleStore } = reviewGates(tx, s, at);
            if (body.action === "Review") {
              if (!s.permissions.mayReview) fail("PermissionDenied");
              const soleOperator =
                body.approvalMode === "SoleOperator"
                  ? {
                      reviewerMfaAt: (
                        await requireMerchantBrandSoleOperator(tx as never, gateInput(s.actor))
                      ).actorMfaAt,
                    }
                  : undefined;
              const listingMode =
                body.approvalMode === "SingleStoreListing" ? await singleStore(s.actor) : null;
              return await reviewOptionRecipeChange(rtx(tx), scope, {
                ...(soleOperator === undefined ? {} : { soleOperator }),
                ...(listingMode !== null
                  ? { singleStoreListing: { storeReference: s.storeReference, mode: listingMode } }
                  : {}),
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
              ...publishChecks(tx, s, at),
            });
          } catch (error) {
            return mapError(error);
          }
        }),
      ),
    );
  };

  /**
   * WP-2423 item 3: the "no change" (or a combo's "adds this dish") option recipes of one dish's
   * choices that are not covered yet, in one transaction per round instead of one command per step
   * per choice: one session check, one authorization and one re-check. Each choice does exactly what
   * the page's commands do (the same rows, review marks and audit), under the same operation
   * references, so a save stopped under older code, or a retry, continues without duplicates. A
   * round takes at most `OPTION_RECIPE_RULES_PER_TRANSACTION` rules; call again until `remaining`
   * is 0. Nothing here is a route; the dish save calls it.
   */
  const coverDishChoices = async (input: {
    readonly sessionCookie: unknown;
    readonly csrf: unknown;
    /** The dish save's operation. */
    readonly operationReference: string;
    readonly productReference: string;
    readonly skuReference: string;
    /** The dish's choices; each with the item it adds to the recipe (a combo's), or null. */
    readonly choices: ReadonlyMap<string, string | null>;
  }): Promise<{
    readonly remaining: number;
    readonly waitingForAllergens: boolean;
    /** Choices with a real recipe change that no longer covers every quantity: left as they are. */
    readonly needsPerson: number;
  }> => {
    const current = await session(input);
    return retryTransactionConflict(() =>
      options.persistence.transactions.run((tx) =>
        withRememberedBrandAuthorization(tx, async () => {
          const s = await scopeFor(tx, input.sessionCookie, current.sessionReference);
          // One instant for the round, read here as a command reads it: before anything that takes
          // time, so what it records stays earlier than the database clock of each audit record.
          const at = options.persistence.now();
          const scope = { brandReference: s.brandReference, storeReference: s.storeReference };
          const step = (purpose: string) => derivedReference(input.operationReference, purpose);
          try {
            const rows = (await targets(tx, s, input.productReference)).filter(
              (row) =>
                input.choices.has(row.target.optionReference) &&
                row.sizes.some((size) => size.skuReference === input.skuReference),
            );
            const coverage = await optionRecipesCovered(
              rtx(tx),
              scope,
              rows.map((row) => row.target),
              at,
            );
            const uncovered = rows.filter((row) => coverage.get(row.target)?.covered !== true);
            if (uncovered.length === 0)
              return { remaining: 0, waitingForAllergens: false, needsPerson: 0 };
            // No recipe for the size yet: its allergens are not declared, so there is nothing a
            // choice could change. Nothing is written; declaring them later covers the choices.
            if (uncovered.some((row) => coverage.get(row.target)?.bound !== true))
              return { remaining: uncovered.length, waitingForAllergens: true, needsPerson: 0 };
            // WP-2423 (v15 2026-11-05): a choice whose published change is real (adds, removes or
            // replaces an ingredient) and no longer covers every quantity is a person's to set
            // under Option recipes: it is never overwritten with "no change" (a stock or allergen
            // fact would be lost). The listing names it. A combo's choice is the combo's own.
            const latest = await listOptionRecipeChanges(
              rtx(tx),
              scope,
              uncovered.map((row) => row.target),
            );
            const ours = uncovered.filter((row) => {
              const change = changeOf(latest, row.target);
              return (
                change === null ||
                change.publishedAt === null ||
                change.content.kind === "NoChange" ||
                (input.choices.get(row.target.optionReference) ?? null) !== null
              );
            });
            const needsPerson = uncovered.length - ours.length;
            if (ours.length === 0) return { remaining: 0, waitingForAllergens: false, needsPerson };
            // Always the first one, however many rules it has (up to 20 of each); then as many as
            // fit in one short hold.
            let rules = 0;
            const picked = ours.filter((row, index) => {
              const count = coverage.get(row.target)?.rules ?? 0;
              if (index > 0 && rules + count > OPTION_RECIPE_RULES_PER_TRANSACTION) return false;
              rules += count;
              return true;
            });
            const changes = latest;
            const plan = picked.map((row) => {
              const change = changeOf(changes, row.target);
              const save = change === null || change.publishedAt !== null;
              return { row, change, save };
            });
            // The three commands' own permissions, only for what this round really does.
            if (plan.some((entry) => entry.save) && !s.permissions.mayEdit)
              fail("PermissionDenied");
            const reviewing = plan.some(
              (entry) =>
                entry.save ||
                (["Cost", "FoodSafety"] as const).some(
                  (kind) =>
                    !entry.change?.reviews.some(
                      (review) => review.kind === kind && review.decision === "Approved",
                    ),
                ),
            );
            if (reviewing && !s.permissions.mayReview) fail("PermissionDenied");
            if (!s.permissions.mayPublish) fail("PermissionDenied");
            // Every read that can wait comes before the hold on the Brand's recipe fence. Publishing asks
            // these again, of the same people, and gets the answers remembered here.
            const { singleStore } = reviewGates(tx, s, at);
            const listingMode = reviewing ? await singleStore(s.actor) : null;
            const checks = publishChecks(tx, s, at);
            for (const actor of new Set([
              s.actor,
              ...plan.flatMap((entry) =>
                entry.save
                  ? []
                  : (entry.change?.reviews ?? []).map((review) => review.reviewerReference),
              ),
            ]))
              await checks.reviewersAuthorized([actor]);
            await checks.singleStoreListingEffective(s.actor);
            const adding = plan.some(
              (entry) =>
                entry.save &&
                (input.choices.get(entry.row.target.optionReference) ?? null) !== null,
            );
            // A combo's choice adds its dish's staff-declared allergen item.
            const items = adding
              ? (await recipeIngredientItems(tx, s, at, { staffDeclared: true })).facts
              : new Map();
            await takeOptionRecipeFence(rtx(tx), scope.brandReference);
            for (const { row, change, save } of plan) {
              const key = row.target.optionReference.slice(-12);
              let version = change?.changeVersionReference ?? null;
              let reviews = change?.reviews ?? [];
              if (save) {
                const item = input.choices.get(row.target.optionReference) ?? null;
                const saved = await saveOptionRecipeChange(rtx(tx), scope, {
                  operationReference: step("option-recipe-" + key),
                  actorReference: s.actor,
                  at,
                  target: row.target,
                  content:
                    item !== null
                      ? {
                          kind: "Add",
                          fromItemReference: null,
                          toItemReference: item,
                          quantity: "1",
                          unitCostCents: null,
                          lossPercent: "0",
                        }
                      : {
                          kind: "NoChange",
                          fromItemReference: null,
                          toItemReference: null,
                          quantity: null,
                          unitCostCents: null,
                          lossPercent: "0",
                        },
                  items,
                  expectedVersion: change?.version ?? null,
                });
                version = saved.changeVersionReference;
                reviews = [];
                // A replay: what that operation already recorded stands, reviews included.
                if (saved.status === "AlreadyApplied")
                  reviews =
                    changeOf(
                      await listOptionRecipeChanges(rtx(tx), scope, [row.target]),
                      row.target,
                    )?.reviews ?? [];
              }
              if (version === null) return fail("NotFound");
              for (const kind of ["Cost", "FoodSafety"] as const)
                if (
                  !reviews.some((review) => review.kind === kind && review.decision === "Approved")
                )
                  await reviewOptionRecipeChange(rtx(tx), scope, {
                    ...(listingMode !== null
                      ? {
                          singleStoreListing: {
                            storeReference: s.storeReference,
                            mode: listingMode,
                          },
                        }
                      : {}),
                    operationReference: step("option-review-" + kind + "-" + key),
                    actorReference: s.actor,
                    at,
                    changeVersionReference: version,
                    kind,
                    decision: "Approved",
                    comment: null,
                  });
              await publishOptionRecipeChange(rtx(tx), scope, {
                operationReference: step("option-publish-" + key),
                actorReference: s.actor,
                at,
                changeVersionReference: version,
                ...checks,
              });
            }
            return {
              remaining: ours.length - picked.length,
              waitingForAllergens: false,
              needsPerson,
            };
          } catch (error) {
            return mapError(error);
          }
        }),
      ),
    );
  };
  /**
   * WP-2423 (v15 2026-11-05): "List it" at a single store, after a choice group of existing dishes
   * was turned into "a quantity of each" under Option sets. A choice whose published change is "no
   * change" at the quantities it had changes nothing at the new ones either, so that change is saved
   * again for every quantity now choosable, reviewed (Cost, FoodSafety) and published, exactly as
   * a dish save covers a new choice: the owner in single-store listing mode, the same audit, under
   * operation references derived from the listing's (`extend-…`), so a retried listing continues
   * without duplicates. A real change (adds, removes or replaces an ingredient) is never extended:
   * it stays for a person under Option recipes, and the listing check names it. Without option
   * recipe edit, review and publish permission nothing is written. Reads first, in one
   * transaction; then at most `OPTION_RECIPE_RULES_PER_TRANSACTION` rules per short transaction.
   */
  const extendNoChangeChoices = async (input: {
    readonly sessionCookie: unknown;
    readonly csrf: unknown;
    /** The listing's operation. */
    readonly operationReference: string;
    /** The menu's dishes (sizes). */
    readonly skuReferences: ReadonlySet<string>;
  }): Promise<{ readonly extended: number; readonly needsPerson: number }> => {
    const current = await session(input);
    const run = <T>(work: (tx: Tx, s: Scope, at: string) => Promise<T>) =>
      retryTransactionConflict(() =>
        options.persistence.transactions.run((tx) =>
          withRememberedBrandAuthorization(tx, async () => {
            const s = await scopeFor(tx, input.sessionCookie, current.sessionReference);
            const at = options.persistence.now();
            try {
              return await work(tx, s, at);
            } catch (error) {
              return mapError(error);
            }
          }),
        ),
      );
    const found = await run(async (tx, s, at) => {
      const { mayEdit, mayReview, mayPublish } = s.permissions;
      if (!mayEdit || !mayReview || !mayPublish) return null;
      const scope = { brandReference: s.brandReference, storeReference: s.storeReference };
      const rows = (await targets(tx, s)).filter((row) =>
        row.sizes.some((size) => input.skuReferences.has(size.skuReference)),
      );
      const coverage = await optionRecipesCovered(
        rtx(tx),
        scope,
        rows.map((row) => row.target),
        at,
      );
      // Not covered, with a recipe to change (a dish without one waits for its allergens).
      const uncovered = rows.filter(
        (row) =>
          coverage.get(row.target)?.covered !== true && coverage.get(row.target)?.bound === true,
      );
      const latest = await listOptionRecipeChanges(
        rtx(tx),
        scope,
        uncovered.map((row) => row.target),
      );
      return uncovered.map((row) => ({
        target: row.target,
        rules: coverage.get(row.target)?.rules ?? 0,
        change: changeOf(latest, row.target),
      }));
    });
    if (found === null) return { extended: 0, needsPerson: 0 };
    const extendable = found.filter(
      (entry) => entry.change?.publishedAt != null && entry.change.content.kind === "NoChange",
    );
    // Rounds: always the first, however many rules; then as many as fit in one short hold.
    const rounds: (typeof extendable)[] = [];
    let rules = 0;
    for (const entry of extendable) {
      const last = rounds.at(-1);
      if (last === undefined || rules + entry.rules > OPTION_RECIPE_RULES_PER_TRANSACTION) {
        rounds.push([entry]);
        rules = entry.rules;
      } else {
        last.push(entry);
        rules += entry.rules;
      }
    }
    let extended = 0;
    for (const round of rounds)
      extended += await run(async (tx, s, at) => {
        const scope = { brandReference: s.brandReference, storeReference: s.storeReference };
        // Again in this transaction: still uncovered, and still that same published "no change".
        const coverage = await optionRecipesCovered(
          rtx(tx),
          scope,
          round.map((entry) => entry.target),
          at,
        );
        const latest = await listOptionRecipeChanges(
          rtx(tx),
          scope,
          round.map((entry) => entry.target),
        );
        const plan = round.filter((entry) => {
          const change = changeOf(latest, entry.target);
          return (
            coverage.get(entry.target)?.covered !== true &&
            change !== null &&
            change.publishedAt !== null &&
            change.content.kind === "NoChange" &&
            change.changeVersionReference === entry.change?.changeVersionReference
          );
        });
        if (plan.length === 0) return 0;
        const { singleStore } = reviewGates(tx, s, at);
        const listingMode = await singleStore(s.actor);
        const checks = publishChecks(tx, s, at);
        await checks.reviewersAuthorized([s.actor]);
        await checks.singleStoreListingEffective(s.actor);
        await takeOptionRecipeFence(rtx(tx), scope.brandReference);
        for (const { target, change } of plan) {
          const key = derivedReference(
            input.operationReference,
            "extend-" +
              target.bindingReference +
              ":" +
              target.optionReference +
              ":" +
              target.quantities.join(","),
          );
          const step = (purpose: string) => derivedReference(key, purpose);
          const saved = await saveOptionRecipeChange(rtx(tx), scope, {
            operationReference: step("save"),
            actorReference: s.actor,
            at,
            target,
            content: {
              kind: "NoChange",
              fromItemReference: null,
              toItemReference: null,
              quantity: null,
              unitCostCents: null,
              lossPercent: "0",
            },
            items: new Map(),
            expectedVersion: change?.version ?? null,
          });
          // A replay: what that operation already recorded stands, reviews included.
          const reviews =
            saved.status === "AlreadyApplied"
              ? (changeOf(await listOptionRecipeChanges(rtx(tx), scope, [target]), target)
                  ?.reviews ?? [])
              : [];
          for (const kind of ["Cost", "FoodSafety"] as const)
            if (!reviews.some((review) => review.kind === kind && review.decision === "Approved"))
              await reviewOptionRecipeChange(rtx(tx), scope, {
                singleStoreListing: { storeReference: s.storeReference, mode: listingMode },
                operationReference: step("review-" + kind),
                actorReference: s.actor,
                at,
                changeVersionReference: saved.changeVersionReference,
                kind,
                decision: "Approved",
                comment: null,
              });
          await publishOptionRecipeChange(rtx(tx), scope, {
            operationReference: step("publish"),
            actorReference: s.actor,
            at,
            changeVersionReference: saved.changeVersionReference,
            ...checks,
          });
        }
        return plan.length;
      });
    return { extended, needsPerson: found.length - extendable.length };
  };
  return { query, command, coverDishChoices, extendNoChangeChoices };
}
