import { createHash } from "node:crypto";
import {
  AllergenDeclarationError,
  currentAllergenRegistry,
  listBrandSkuChoices,
  listIngredientDeclarationHistory,
  recordIngredientAllergenDeclaration,
  staffAllergenDeclarationSource,
} from "@rms/catalog";
import {
  createPostgresInventoryItemStore,
  executeInventoryItemCommand,
  listInventoryRecipeIngredientFacts,
  parseInventoryReference,
  type InventoryItemTransaction,
} from "@rms/inventory";
import { listKitchenStationCapabilities } from "@rms/kitchen";
import {
  bindRecipeToSku,
  listRecipes,
  listStaffDeclaredAllergenSources,
  loadRecipe,
  parseRecipeDraft,
  publishRecipe,
  publishRecipePreparation,
  RecipeAuthoringError,
  recordRecipeReview,
  recordStaffDeclaredAllergenSource,
  saveRecipeDraft,
  type RecipeAuthoringTransaction,
  type RecipeDraftFacts,
} from "@rms/recipe";
import { withRememberedBrandAuthorization } from "./merchant-brand-transaction-authorization.js";
import { createMerchantBrandScope } from "./merchant-brand-scope.js";
import { derivedReference } from "./merchant-products.js";
import {
  MerchantSingleStoreListingError,
  requireMerchantBrandSingleStore,
} from "./merchant-sole-operator.js";
import type { MerchantBffService } from "./merchant-bff.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import { recipeIngredientItems } from "./recipe-ingredient-items.js";
import { retryTransactionConflict } from "./transaction-conflict-retry.js";

/**
 * WP-2423 item 8 ⑥ DEC-SINGLE-STORE-MENU (coordinator 2026-10-28, accepted with four conditions):
 * a dish's allergens declared by staff in the one-page menu reach guests through the existing
 * allergen chain. Each dish size gets an inventory item standing for it (Finished good, not
 * stock-tracked, so never counted or deducted) that holds the staff declaration (source
 * StaffDeclaration), and a recipe generated with that one item and one kitchen step. The author
 * lists it alone at the Brand's one store (single-store review marks), and it becomes the size's
 * recipe for the whole Brand. Both are labelled AllergensDeclaredByStaff (Recipe owner record):
 * never a costed recipe, never edited as one, and replaced by a real recipe once the store keeps
 * inventory and recipes. A size that already has a real recipe keeps it (never mixed).
 */
export class MerchantDishAllergenError extends Error {
  constructor(
    readonly code:
      | "PermissionDenied"
      | "NotFound"
      | "Invalid"
      | "Conflict"
      /** The Brand has no approved allergen list yet. */
      | "RegistryMissing"
      /** The store has no active kitchen station for the dish's kitchen step. */
      | "NoKitchenStation"
      /** The size already has a real recipe: its allergens come from that recipe's ingredients. */
      | "RealRecipe"
      /** Declaring without review needs a Brand with exactly one store. */
      | "NotSingleStore"
      /** WP-2423 item 8 ⑦: the size was declared the other way (allergens, or no ingredients). */
      | "DeclaredOtherwise",
  ) {
    super(code);
    this.name = "MerchantDishAllergenError";
  }
}
const fail = (code: MerchantDishAllergenError["code"]): never => {
  throw new MerchantDishAllergenError(code);
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ref = (value: unknown): string =>
  typeof value === "string" && uuid.test(value) ? value : fail("Invalid");

export type DishAllergenCommandBody =
  | {
      readonly action: "DeclareDish";
      readonly operationReference: string;
      readonly skuReference: string;
      readonly allergens: readonly {
        readonly allergenReference: string;
        readonly classification: "Contains" | "CrossContactPossible";
      }[];
    }
  /**
   * WP-2423 item 8 ⑦ (coordinator 2026-10-29): the owner declares the size uses no stock
   * ingredients — a charge such as the per-head tea. Recorded like declared allergens (who and
   * when; none declared), labelled NoIngredientsDeclaredByStaff; the listing review accepts its
   * generated recipe, and it never counts or deducts stock.
   */
  | {
      readonly action: "DeclareNoIngredients";
      readonly operationReference: string;
      readonly skuReference: string;
    };
export function parseDishAllergenCommandBody(value: unknown): DishAllergenCommandBody {
  const r = value as Record<string, unknown> | null;
  if (
    r !== null &&
    typeof r === "object" &&
    !Array.isArray(r) &&
    r.action === "DeclareNoIngredients"
  ) {
    if (Object.keys(r).sort().join(",") !== "action,operationReference,skuReference")
      return fail("Invalid");
    return {
      action: "DeclareNoIngredients",
      operationReference: ref(r.operationReference),
      skuReference: ref(r.skuReference),
    };
  }
  if (
    r === null ||
    typeof r !== "object" ||
    Array.isArray(r) ||
    Object.keys(r).sort().join(",") !== "action,allergens,operationReference,skuReference" ||
    r.action !== "DeclareDish" ||
    !Array.isArray(r.allergens) ||
    r.allergens.length > 64
  )
    return fail("Invalid");
  const allergens = r.allergens.map((candidate: unknown) => {
    const a = candidate as Record<string, unknown> | null;
    if (
      a === null ||
      typeof a !== "object" ||
      Object.keys(a).sort().join(",") !== "allergenReference,classification" ||
      (a.classification !== "Contains" && a.classification !== "CrossContactPossible")
    )
      return fail("Invalid");
    return {
      allergenReference: ref(a.allergenReference),
      classification: a.classification as "Contains" | "CrossContactPossible",
    };
  });
  if (new Set(allergens.map((a) => a.allergenReference)).size !== allergens.length)
    return fail("Invalid");
  return {
    action: "DeclareDish",
    operationReference: ref(r.operationReference),
    skuReference: ref(r.skuReference),
    allergens,
  };
}

/** The allergen set as one comparable key (order-free). */
export function allergenKey(
  allergens: readonly { readonly allergenReference: string; readonly classification: string }[],
): string {
  return allergens
    .map((a) => a.allergenReference + ":" + a.classification)
    .sort()
    .join(",");
}
/**
 * Where a size's allergens come from: its Brand-wide recipe when that is a real one ("Recipe"),
 * its generated recipe of staff-declared allergens ("StaffDeclared"), or neither ("None"). A
 * size never has both: a real recipe bound to it supersedes the generated one.
 */
export function sizeRecipeSource(
  recipes: readonly {
    readonly familyReference: string;
    readonly bindings: readonly {
      readonly skuReference: string;
      readonly storeReference: string | null;
    }[];
  }[],
  sources: readonly {
    readonly subject: string;
    readonly skuReference: string | null;
    readonly recipeReference: string | null;
  }[],
  skuReference: string,
): "Recipe" | "StaffDeclared" | "None" {
  const generated = new Set(
    sources.flatMap((x) => (x.recipeReference === null ? [] : [x.recipeReference])),
  );
  const bound = recipes.find((recipe) =>
    recipe.bindings.some((b) => b.skuReference === skuReference && b.storeReference === null),
  );
  if (bound !== undefined && !generated.has(bound.familyReference)) return "Recipe";
  return sources.some((x) => x.subject === "Dish" && x.skuReference === skuReference)
    ? "StaffDeclared"
    : "None";
}
/** A staff declaration stays valid a year; staff confirm it again when it runs out. */
export const staffDeclarationValidityDays = 365;
const code = (prefix: string, skuCode: string) =>
  (prefix + skuCode.toUpperCase().replace(/[^A-Z0-9]+/gu, "-")).slice(0, 48);
const digest = (value: string) => "sha256:" + createHash("sha256").update(value).digest("hex");

/**
 * The declaration in the caller's transaction: the caller resolved the Brand scope, its actor and
 * `may` (current Brand-scoped decisions). Exported for the restricted-role acceptance.
 */
export async function declareDishAllergens(
  tx: unknown,
  input: {
    readonly scope: {
      readonly tenantReference: string;
      readonly brandReference: string;
      readonly storeReference: string;
    };
    readonly actorReference: string;
    readonly may: (action: string) => Promise<boolean>;
    readonly at: string;
    readonly locale: string;
    readonly nextReference: () => string;
    readonly body: DishAllergenCommandBody;
  },
) {
  const { may, body } = input;
  const noIngredients = body.action === "DeclareNoIngredients";
  const declared = body.action === "DeclareDish" ? body.allergens : [];
  const label = noIngredients ? "NoIngredientsDeclaredByStaff" : "AllergensDeclaredByStaff";
  const name = (names: Readonly<Record<string, string>>, fallback: string) =>
    names[input.locale] ?? Object.values(names)[0] ?? fallback;
  // Every step is one staff would otherwise do themselves on the recipe, allergen and
  // inventory pages; the one who declares holds each of those permissions.
  for (const action of [
    "recipe.update",
    "recipe.approve",
    "recipe.publish",
    "catalog.allergen.declare",
    "inventory.item.create",
    "inventory.item.activate",
  ])
    if (!(await may(action))) fail("PermissionDenied");
  const s = input.scope;
  const actor = input.actorReference;
  const at = input.at;
  const rtx = tx as unknown as RecipeAuthoringTransaction;
  const op = body.operationReference;
  const step = (purpose: string) => derivedReference(op, purpose);
  // The author lists alone only at the Brand's one store (held until this commits).
  const singleStore = () =>
    requireMerchantBrandSingleStore(tx as never, {
      brandReference: s.brandReference,
      storeReference: s.storeReference,
      actorReference: actor,
      permissionCode: "recipe.approve",
      observedAt: at,
      allowed: async () => await may("recipe.approve"),
    });
  try {
    const listingMode = await singleStore();
    const sku = (await listBrandSkuChoices(tx as never, s)).find(
      (candidate) => candidate.skuReference === body.skuReference && candidate.active,
    );
    if (sku === undefined) return fail("NotFound");
    const registry = await currentAllergenRegistry(tx as never, s);
    if (registry === null) return fail("RegistryMissing");
    const known = new Set(registry.entries.map((entry) => entry.allergenReference));
    if (declared.some((a) => !known.has(a.allergenReference))) fail("Invalid");
    const sources = await listStaffDeclaredAllergenSources(rtx, s);
    const source = sources.find(
      (candidate) => candidate.subject === "Dish" && candidate.skuReference === sku.skuReference,
    );
    // Never mixed: a size bound to a real recipe keeps it.
    const recipes = await listRecipes(rtx, s, at);
    if (sizeRecipeSource(recipes, sources, sku.skuReference) === "Recipe")
      return fail("RealRecipe");
    // A size stays declared the one way it was first declared (the record is append-only).
    if (source !== undefined && source.label !== label) return fail("DeclaredOtherwise");
    const dishName = (() => {
      const product = name(sku.productLocalizedNames, "");
      const size = name(sku.localizedNames, sku.skuCode);
      return product && product !== size ? product + " — " + size : size || product;
    })();

    // 1. The item standing for the size: Finished good, not stock-tracked, active.
    const store = createPostgresInventoryItemStore(
      { run: (work) => work(tx as unknown as InventoryItemTransaction) },
      { tenantReference: s.tenantReference, brandReference: s.brandReference },
    );
    const itemCommand = (
      purpose: string,
      action: "Create" | "Activate",
      payload: Record<string, unknown>,
    ) =>
      executeInventoryItemCommand(
        {
          tenantReference: s.tenantReference,
          brandReference: s.brandReference,
          actorReference: actor,
          purpose: "InventoryItemManagement",
          operationReference: step(purpose),
          occurredAt: at,
          action,
          payload,
        },
        {
          authorization: {
            authorize: async (request) =>
              (await may(request.permission)) ? { authorized: true } : null,
          },
          audit: {
            create: async ({ command: c, after }) => ({
              auditId: step(purpose + "-audit"),
              brandId: c.brandReference,
              actor: { type: "User", reference: c.actorReference },
              actionCode: "INVENTORY_ITEM_" + c.action.toUpperCase(),
              targetType: "InventoryItem",
              targetId: after.itemReference,
              reasonCode: "STAFF_DECLARED_ALLERGENS",
              correlationId: c.operationReference,
              occurredAt: c.occurredAt,
              sourceChannel: "MERCHANT_WEB",
              dataClassification: "Internal",
              retentionPolicyCode: "AUDIT_STANDARD",
              retentionPolicyVersion: 1,
            }),
          },
          references: {
            generate: () => input.nextReference(),
            hashIntent: digest,
            equals: (left, right) => left === right,
          },
          repository: store,
        },
      );
    let itemReference = source?.itemReference ?? null;
    if (itemReference === null)
      itemReference = String(
        parseInventoryReference(
          (
            await itemCommand("item", "Create", {
              internalCode: code("DECL-", sku.skuCode),
              itemType: "FinishedGood",
              localizedNames: {
                [input.locale]:
                  dishName +
                  (noIngredients
                    ? " (no stock ingredients, a charge)"
                    : " (allergens declared by staff)"),
              },
              baseUnit: {
                unitCode: "EA",
                dimension: "Count",
                displayPrecision: 0,
                ledgerPrecision: 0,
                roundingMode: "HalfEven",
              },
              trackingPolicy: {
                stockTrackingEnabled: false,
                lotTrackingMode: "NoLot",
                defaultShelfLifeDays: null,
                expiryWarningDays: null,
                issuePolicy: "FIFO",
                negativeStockPolicy: "AllowWithWarning",
              },
            })
          ).item.itemReference,
        ),
      );
    const stored = await store.load(parseInventoryReference(itemReference));
    if (stored === null) return fail("Conflict");
    // A new item starts inactive; one deactivated on the inventory page is activated again.
    if (stored.lifecycle !== "Active")
      await itemCommand("item-activate", "Activate", {
        itemReference,
        expectedVersion: stored.aggregateVersion,
        reasonCode: "STAFF_DECLARED_ALLERGENS",
      });
    const item = (await listInventoryRecipeIngredientFacts(tx as never, s)).find(
      (candidate) => candidate.itemReference === itemReference,
    );
    if (item === undefined || item.stockTracked) return fail("Conflict");

    // 2. The staff declaration of the size's allergens, against the current list.
    const history = await listIngredientDeclarationHistory(tx as never, s, item.itemReference);
    const latest = history.find(
      (d) =>
        d.registryVersionReference === registry.registryVersionReference &&
        d.itemVersionReference === item.configurationOperationReference &&
        Date.parse(d.validUntil) > Date.parse(at),
    );
    const declaration =
      latest !== undefined && allergenKey(latest.allergens) === allergenKey(declared)
        ? latest
        : (
            await recordIngredientAllergenDeclaration(tx as never, s, {
              evidenceReference: step("declaration"),
              itemReference: item.itemReference,
              itemVersionReference: item.configurationOperationReference,
              registryVersionReference: registry.registryVersionReference,
              allergens: declared,
              sourceKind: staffAllergenDeclarationSource,
              documentReference: "Declared by staff in the menu",
              note: null,
              validUntil: new Date(
                Date.parse(at) + staffDeclarationValidityDays * 86_400_000,
              ).toISOString(),
              actorReference: actor,
              at,
              auditReference: step("declaration-audit"),
            })
          ).declaration;

    // 3. The generated recipe: that one item, one kitchen step at the store's station.
    const station = (await listKitchenStationCapabilities(tx as never, s))
      .filter((candidate) => candidate.stationActive)
      .flatMap((candidate) => candidate.capabilityReferences)[0];
    if (station === undefined) return fail("NoKitchenStation");
    const { facts: itemFacts } = await recipeIngredientItems(tx, s, at);
    const facts: RecipeDraftFacts = {
      items: new Map([
        ...itemFacts,
        [
          item.itemReference,
          {
            configurationOperationReference: item.configurationOperationReference,
            dimension: item.dimension,
            unitCode: item.unitCode,
            active: item.active,
            allergenDeclaration: {
              evidenceReference: declaration.evidenceReference,
              allergenReferences: declaration.allergens.map((a) => a.allergenReference),
            },
          },
        ],
      ]),
      subRecipes: new Map(),
      capabilityReferences: new Set([station]),
    };
    const draftOf = (revision: number) =>
      parseRecipeDraft({
        name:
          dishName +
          (noIngredients ? " — No stock ingredients (a charge)" : " — Allergens declared by staff"),
        // Each revision keeps its own code, as the recipe editor names them (-R2, -R3, …).
        code: code("DECL-", sku.skuCode).slice(0, 44) + (revision > 1 ? "-R" + revision : ""),
        yieldQuantity: "1",
        yieldUnit: "EACH",
        ingredients: [
          {
            kind: "InventoryItem",
            sourceReference: item.itemReference,
            quantity: "1",
            lossPercent: "0",
            unitCostCents: null,
          },
        ],
        steps: [
          {
            sequence: 1,
            instruction: "Prepare " + dishName,
            durationSeconds: 60,
            capabilityReference: station,
          },
        ],
      });
    const family = source?.recipeReference ?? null;
    const currentRecipe =
      family === null
        ? undefined
        : recipes
            .filter((recipe) => recipe.familyReference === family)
            .sort((a, b) => b.familyRevision - a.familyRevision)[0];
    const detail =
      currentRecipe === undefined
        ? null
        : await loadRecipe(rtx, s, currentRecipe.recipeReference, at);
    const pinned = detail?.snapshot.ingredients[0]?.allergenDeclarationReference ?? null;
    const upToDate =
      detail !== null &&
      detail.lifecycle === "Published" &&
      pinned === declaration.evidenceReference &&
      detail.bindings.some(
        (binding) => binding.skuReference === sku.skuReference && binding.storeReference === null,
      );
    if (upToDate) return { status: "AlreadyApplied" as const, skuReference: sku.skuReference };
    const writer = {
      actorReference: actor,
      at,
      nextReference: () => input.nextReference(),
    };
    // A first recipe, or a revision of the published one (a draft left open is replaced).
    const recipeReference =
      detail !== null && detail.lifecycle === "Draft" ? detail.recipeReference : step("recipe");
    const revision =
      detail === null || currentRecipe === undefined
        ? 1
        : currentRecipe.familyRevision + (detail.lifecycle === "Published" ? 1 : 0);
    const draft = draftOf(revision);
    await saveRecipeDraft(rtx, s, {
      ...writer,
      operationReference: step("draft"),
      recipeReference,
      expectedAggregateVersion:
        detail !== null && detail.lifecycle === "Draft" ? detail.aggregateVersion : null,
      revisionOf:
        detail !== null && detail.lifecycle === "Published" ? detail.recipeReference : null,
      draft,
      facts,
      auditReference: step("draft-audit"),
    });
    const saved = await loadRecipe(rtx, s, recipeReference, at);
    if (saved === null) return fail("Conflict");
    const listing = {
      singleStoreListing: { storeReference: s.storeReference, mode: listingMode },
    };
    const effective = async () => {
      try {
        await singleStore();
        return true;
      } catch (error) {
        if (error instanceof MerchantSingleStoreListingError) return false;
        throw error;
      }
    };
    for (const kind of ["Cost", "FoodSafety"] as const)
      await recordRecipeReview(rtx, s, {
        ...writer,
        reviewReference: step("review-" + kind),
        recipeReference,
        versionReference: saved.versionReference,
        subject: "Recipe",
        kind,
        decision: "Approved",
        comment: null,
        auditReference: step("review-audit-" + kind),
        ...listing,
      });
    await publishRecipe(rtx, s, {
      ...writer,
      operationReference: step("publish"),
      recipeReference,
      expectedAggregateVersion: saved.aggregateVersion,
      facts,
      reviewersAuthorized: async () => true,
      singleStoreListingEffective: effective,
      auditReference: step("publish-audit"),
    });
    const published = await loadRecipe(rtx, s, recipeReference, at);
    if (published === null) return fail("Conflict");
    for (const kind of ["Cost", "FoodSafety"] as const)
      await recordRecipeReview(rtx, s, {
        ...writer,
        reviewReference: step("kitchen-review-" + kind),
        recipeReference,
        versionReference: published.versionReference,
        subject: "Preparation",
        kind,
        decision: "Approved",
        comment: null,
        auditReference: step("kitchen-review-audit-" + kind),
        ...listing,
      });
    await publishRecipePreparation(rtx, s, {
      ...writer,
      operationReference: step("kitchen"),
      recipeReference,
      reviewersAuthorized: async () => true,
      singleStoreListingEffective: effective,
      auditReference: step("kitchen-audit"),
    });
    await bindRecipeToSku(rtx, s, {
      ...writer,
      operationReference: step("bind"),
      recipeReference,
      skuReference: sku.skuReference,
      storeReference: null,
      skuUnitOfSale: sku.unitOfSale,
      auditReference: step("bind-audit"),
    });
    // 4. The label, recorded once per size.
    if (source === undefined)
      await recordStaffDeclaredAllergenSource(rtx, s, {
        operationReference: step("label"),
        actorReference: actor,
        at,
        auditReference: step("label-audit"),
        itemReference: item.itemReference,
        subject: "Dish",
        skuReference: sku.skuReference,
        recipeReference,
        label,
      });
    return { status: "Applied" as const, skuReference: sku.skuReference };
  } catch (error) {
    if (error instanceof MerchantDishAllergenError) throw error;
    if (error instanceof MerchantSingleStoreListingError)
      return fail(error.code === "NotSingleStore" ? "NotSingleStore" : "PermissionDenied");
    if (error instanceof AllergenDeclarationError)
      return fail(
        error.code === "ALLERGEN_REGISTRY_UNAVAILABLE"
          ? "RegistryMissing"
          : error.code === "ALLERGEN_IDEMPOTENCY_CONFLICT"
            ? "Conflict"
            : "Invalid",
      );
    if (error instanceof RecipeAuthoringError)
      return fail(
        error.code === "RECIPE_AUTHORING_CONFLICT" ||
          error.code === "RECIPE_AUTHORING_CODE_TAKEN" ||
          error.code === "RECIPE_AUTHORING_LIFECYCLE"
          ? "Conflict"
          : error.code === "RECIPE_AUTHORING_NOT_SINGLE_STORE"
            ? "NotSingleStore"
            : "Invalid",
      );
    throw error;
  }
}

export function createMerchantDishAllergens(options: {
  persistence: PersistentMerchantBffOptions;
  authentication: Pick<MerchantBffService, "authorize">;
  references: { next(): string };
  locale: string;
  /** Test seam: the Brand scope resolver (defaults to the current session's Brand scope). */
  resolveScope?: ReturnType<typeof createMerchantBrandScope>;
}) {
  const resolveBrand = options.resolveScope ?? createMerchantBrandScope(options.persistence);
  type Tx = Parameters<Parameters<typeof options.persistence.transactions.run>[0]>[0];
  const session = (input: { sessionCookie: unknown; csrf: unknown }) =>
    options.authentication
      .authorize({ sessionCookie: input.sessionCookie, csrf: input.csrf })
      .catch(() => fail("PermissionDenied"));
  const command = async (input: { sessionCookie: unknown; csrf: unknown; body: unknown }) => {
    const body = parseDishAllergenCommandBody(input.body);
    const current = await session(input);
    return retryTransactionConflict(() =>
      options.persistence.transactions.run((tx: Tx) =>
        withRememberedBrandAuthorization(tx, async () => {
          const scope = await resolveBrand(tx, input.sessionCookie, current.sessionReference).catch(
            () => fail("PermissionDenied"),
          );
          return declareDishAllergens(tx, {
            scope: {
              tenantReference: String(scope.tenantReference),
              brandReference: String(scope.context.brand.brandReference),
              storeReference: String(scope.selectedStoreReference),
            },
            actorReference: String(scope.actorReference),
            may: async (action) => (await scope.authorizeAction(action))?.effect === "Allow",
            at: options.persistence.now(),
            locale: options.locale,
            nextReference: () => options.references.next(),
            body,
          });
        }),
      ),
    );
  };
  return { command };
}
