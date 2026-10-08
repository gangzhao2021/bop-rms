import {
  confirmActiveBrandMembers,
  listStoreMembers,
  type MemberDirectoryTransaction,
} from "@bop/membership";
import { brandActionHeldBy, type RoleAssignmentTransaction } from "@bop/permission";
import {
  currentAllergenRegistry,
  listBrandSkuChoices,
  listCurrentIngredientDeclarations,
} from "@rms/catalog";
import { listInventoryRecipeIngredientFacts } from "@rms/inventory";
import { listKitchenStationCapabilities } from "@rms/kitchen";
import {
  archiveRecipe,
  bindRecipeToSku,
  endStoreRecipeBinding,
  listPublishedSubRecipes,
  listRecipes,
  loadRecipe,
  parseRecipeDraft,
  publishRecipe,
  publishRecipePreparation,
  RecipeAuthoringError,
  recipeYieldUnits,
  recordRecipeReview,
  saveRecipeDraft,
  type RecipeAuthoringTransaction,
  type RecipeDraftFacts,
} from "@rms/recipe";
import { createMerchantBrandScope } from "./merchant-brand-scope.js";
import type { MerchantBffService } from "./merchant-bff.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import { retryTransactionConflict } from "./transaction-conflict-retry.js";

/**
 * WP-2423 / DEC-RECIPE-AUTHORING: RECIPE-LIST / RECIPE-EDITOR for the selected Store's Brand. Recipes
 * are Brand facts: every action needs its Brand-scoped permission (recipe.read, recipe.update for
 * drafts, recipe.approve for Cost/FoodSafety reviews, recipe.publish for publishing, kitchen
 * instructions, SKU bindings and archiving). A Store grant alone never satisfies them.
 */
export class MerchantRecipeError extends Error {
  constructor(
    readonly code:
      | "PermissionDenied"
      | "NotFound"
      | "Conflict"
      | "CodeTaken"
      | "ReviewRequired"
      | "ReviewerNotIndependent"
      | "Lifecycle"
      | "InUse"
      | "AllergenUndeclared"
      | "LineInvalid"
      | "Invalid",
    readonly line: number | null = null,
  ) {
    super(code);
    this.name = "MerchantRecipeError";
  }
}
const fail = (code: MerchantRecipeError["code"], line: number | null = null): never => {
  throw new MerchantRecipeError(code, line);
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ref = (value: unknown): string =>
  typeof value === "string" && uuid.test(value) ? value : fail("Invalid");
const version = (value: unknown): number =>
  Number.isSafeInteger(value) && (value as number) >= 1 ? (value as number) : fail("Invalid");

export type RecipeCommandBody =
  | {
      readonly action: "SaveDraft";
      readonly operationReference: string;
      readonly recipeReference: string;
      readonly expectedAggregateVersion: number | null;
      readonly revisionOf: string | null;
      readonly draft: unknown;
    }
  | {
      readonly action: "Review";
      readonly operationReference: string;
      readonly recipeReference: string;
      readonly versionReference: string;
      readonly subject: "Recipe" | "Preparation";
      readonly kind: "Cost" | "FoodSafety";
      readonly decision: "Approved" | "Rejected";
      readonly comment: string | null;
    }
  | {
      readonly action: "Publish" | "Archive";
      readonly operationReference: string;
      readonly recipeReference: string;
      readonly expectedAggregateVersion: number;
    }
  | {
      readonly action: "PublishKitchen";
      readonly operationReference: string;
      readonly recipeReference: string;
    }
  | {
      readonly action: "BindSku";
      readonly operationReference: string;
      readonly recipeReference: string;
      readonly skuReference: string;
      readonly storeOnly: boolean;
    }
  | {
      readonly action: "EndStoreBinding";
      readonly operationReference: string;
      readonly bindingReference: string;
    };
export function parseRecipeCommandBody(value: unknown): RecipeCommandBody {
  const r = value as Record<string, unknown> | null;
  if (r === null || typeof r !== "object" || Array.isArray(r)) return fail("Invalid");
  const keys = Object.keys(r).sort().join(",");
  switch (r.action) {
    case "SaveDraft":
      if (
        keys !==
        "action,draft,expectedAggregateVersion,operationReference,recipeReference,revisionOf"
      )
        return fail("Invalid");
      return {
        action: "SaveDraft",
        operationReference: ref(r.operationReference),
        recipeReference: ref(r.recipeReference),
        expectedAggregateVersion:
          r.expectedAggregateVersion === null ? null : version(r.expectedAggregateVersion),
        revisionOf: r.revisionOf === null ? null : ref(r.revisionOf),
        draft: r.draft,
      };
    case "Review": {
      if (
        keys !==
          "action,comment,decision,kind,operationReference,recipeReference,subject,versionReference" ||
        (r.subject !== "Recipe" && r.subject !== "Preparation") ||
        (r.kind !== "Cost" && r.kind !== "FoodSafety") ||
        (r.decision !== "Approved" && r.decision !== "Rejected")
      )
        return fail("Invalid");
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
        recipeReference: ref(r.recipeReference),
        versionReference: ref(r.versionReference),
        subject: r.subject,
        kind: r.kind,
        decision: r.decision,
        comment,
      };
    }
    case "Publish":
    case "Archive":
      if (keys !== "action,expectedAggregateVersion,operationReference,recipeReference")
        return fail("Invalid");
      return {
        action: r.action,
        operationReference: ref(r.operationReference),
        recipeReference: ref(r.recipeReference),
        expectedAggregateVersion: version(r.expectedAggregateVersion),
      };
    case "PublishKitchen":
      if (keys !== "action,operationReference,recipeReference") return fail("Invalid");
      return {
        action: "PublishKitchen",
        operationReference: ref(r.operationReference),
        recipeReference: ref(r.recipeReference),
      };
    case "BindSku":
      if (
        keys !== "action,operationReference,recipeReference,skuReference,storeOnly" ||
        typeof r.storeOnly !== "boolean"
      )
        return fail("Invalid");
      return {
        action: "BindSku",
        operationReference: ref(r.operationReference),
        recipeReference: ref(r.recipeReference),
        skuReference: ref(r.skuReference),
        storeOnly: r.storeOnly,
      };
    case "EndStoreBinding":
      if (keys !== "action,bindingReference,operationReference") return fail("Invalid");
      return {
        action: "EndStoreBinding",
        operationReference: ref(r.operationReference),
        bindingReference: ref(r.bindingReference),
      };
    default:
      return fail("Invalid");
  }
}

const authoringErrors: Record<RecipeAuthoringError["code"], MerchantRecipeError["code"]> = {
  RECIPE_AUTHORING_INVALID: "Invalid",
  RECIPE_AUTHORING_LINE_INVALID: "LineInvalid",
  RECIPE_AUTHORING_NOT_FOUND: "NotFound",
  RECIPE_AUTHORING_CONFLICT: "Conflict",
  RECIPE_AUTHORING_CODE_TAKEN: "CodeTaken",
  RECIPE_AUTHORING_REVIEW_REQUIRED: "ReviewRequired",
  RECIPE_AUTHORING_REVIEWER_NOT_INDEPENDENT: "ReviewerNotIndependent",
  RECIPE_AUTHORING_LIFECYCLE: "Lifecycle",
  RECIPE_AUTHORING_IN_USE: "InUse",
  RECIPE_AUTHORING_ALLERGEN_UNDECLARED: "AllergenUndeclared",
};

export function createMerchantRecipes(options: {
  persistence: PersistentMerchantBffOptions;
  authentication: Pick<MerchantBffService, "authorize">;
  references: { next(): string };
  locale: string;
}) {
  const resolveBrand = createMerchantBrandScope(options.persistence);
  type Tx = Parameters<Parameters<typeof options.persistence.transactions.run>[0]>[0];
  const session = (input: { sessionCookie: unknown; csrf: unknown }) =>
    options.authentication
      .authorize({ sessionCookie: input.sessionCookie, csrf: input.csrf })
      .catch(() => fail("PermissionDenied"));
  async function scopeFor(tx: Tx, sessionCookie: unknown, sessionReference: string) {
    const scope = await resolveBrand(tx, sessionCookie, sessionReference).catch(() =>
      fail("PermissionDenied"),
    );
    const may = async (action: string) => (await scope.authorizeAction(action))?.effect === "Allow";
    if (!(await may("recipe.read"))) fail("PermissionDenied");
    return {
      tenantReference: String(scope.tenantReference),
      brandReference: String(scope.context.brand.brandReference),
      storeReference: String(scope.selectedStoreReference),
      actorReference: String(scope.actorReference),
      may,
    };
  }
  const name = (names: Readonly<Record<string, string>>, fallback: string) =>
    names[options.locale] ?? Object.values(names)[0] ?? fallback;

  async function facts(tx: Tx, scope: Awaited<ReturnType<typeof scopeFor>>) {
    const items = await listInventoryRecipeIngredientFacts(tx as never, scope);
    const subRecipes = await listPublishedSubRecipes(
      tx as unknown as RecipeAuthoringTransaction,
      scope,
    );
    const stations = await listKitchenStationCapabilities(tx as never, scope);
    // DEC-ALLERGEN-DECLARATIONS: each item's current declaration, for its current version and
    // the current registry only.
    const registry = await currentAllergenRegistry(tx as never, scope);
    const declarations = new Map(
      (await listCurrentIngredientDeclarations(tx as never, scope, options.persistence.now()))
        .filter((d) => d.registryVersionReference === registry?.registryVersionReference)
        .map((d) => [d.itemReference, d]),
    );
    const declarationOf = (item: (typeof items)[number]) => {
      const d = declarations.get(item.itemReference);
      return d !== undefined && d.itemVersionReference === item.configurationOperationReference
        ? d
        : null;
    };
    const recipeFacts: RecipeDraftFacts = {
      items: new Map(
        items
          .filter((item) => item.stockTracked)
          .map((item) => [
            item.itemReference,
            {
              configurationOperationReference: item.configurationOperationReference,
              dimension: item.dimension,
              unitCode: item.unitCode,
              active: item.active,
              allergenDeclaration: (() => {
                const d = declarationOf(item);
                return d === null
                  ? null
                  : {
                      evidenceReference: d.evidenceReference,
                      allergenReferences: d.allergens.map((a) => a.allergenReference),
                    };
              })(),
            },
          ]),
      ),
      subRecipes: new Map(subRecipes.map((recipe) => [recipe.recipeReference, recipe])),
      capabilityReferences: new Set(
        stations
          .filter((station) => station.stationActive)
          .flatMap((station) => station.capabilityReferences),
      ),
    };
    return { items, subRecipes, stations, recipeFacts, registry, declarations, declarationOf };
  }

  const query = async (input: {
    sessionCookie: unknown;
    csrf: unknown;
    recipeReference: string | null;
  }) => {
    const current = await session(input);
    return retryTransactionConflict(() =>
      options.persistence.transactions.run(async (tx) => {
        const scope = await scopeFor(tx, input.sessionCookie, current.sessionReference);
        const permissions = {
          mayEdit: await scope.may("recipe.update"),
          mayReview: await scope.may("recipe.approve"),
          mayPublish: await scope.may("recipe.publish"),
        };
        const at = options.persistence.now();
        const rtx = tx as unknown as RecipeAuthoringTransaction;
        const { items, subRecipes, stations, registry, declarations, declarationOf } = await facts(
          tx,
          scope,
        );
        const allergenName = new Map(
          (registry?.entries ?? []).map((entry) => [
            entry.allergenReference,
            name(entry.localizedNames, entry.code),
          ]),
        );
        /** "Declared" (with allergens, possibly none), "Outdated" (older item version) or "Missing". */
        const allergenStatus = (item: (typeof items)[number]) => {
          const d = declarationOf(item);
          if (d !== null)
            return {
              status: "Declared" as const,
              contains: d.allergens
                .filter((a) => a.classification === "Contains")
                .map((a) => allergenName.get(a.allergenReference) ?? a.allergenReference),
              mayContain: d.allergens
                .filter((a) => a.classification === "CrossContactPossible")
                .map((a) => allergenName.get(a.allergenReference) ?? a.allergenReference),
            };
          return {
            status: declarations.has(item.itemReference)
              ? ("Outdated" as const)
              : ("Missing" as const),
            contains: [],
            mayContain: [],
          };
        };
        const skus = await listBrandSkuChoices(tx as never, scope);
        const members = await listStoreMembers(tx as unknown as MemberDirectoryTransaction, scope);
        const people = new Map(
          members.map((member) => [member.actorReference, member.displayName]),
        );
        const label = (actor: string) =>
          actor === scope.actorReference
            ? "You"
            : (people.get(actor) ?? "Staff " + actor.slice(-4));
        const choices = {
          yieldUnits: Object.keys(recipeYieldUnits),
          items: items
            .filter(
              (item) =>
                item.active &&
                item.stockTracked &&
                ["Mass", "Volume", "Count"].includes(item.dimension),
            )
            .map((item) => ({
              itemReference: item.itemReference,
              internalCode: item.internalCode,
              name: name(item.localizedNames, item.internalCode),
              unitCode: item.unitCode,
              latestUnitCostCents: item.latestUnitCostMinor,
              allergens: allergenStatus(item),
            })),
          subRecipes: subRecipes.map((recipe) => ({
            recipeReference: recipe.recipeReference,
            name: recipe.name,
            yieldUnit: recipe.yieldUnitCode,
          })),
          stations: stations
            .filter((station) => station.stationActive)
            .flatMap((station, index) =>
              station.capabilityReferences.map((capability) => ({
                capabilityReference: capability,
                name:
                  "Station " +
                  (index + 1) +
                  (station.selectorKind === "AllPreparedItems" ? " (all prepared items)" : ""),
              })),
            ),
          skus: skus
            .filter((sku) => sku.active)
            .map((sku) => ({
              skuReference: sku.skuReference,
              code: sku.skuCode,
              // Product and size, e.g. "Flat White — Large (16 oz)".
              name: (() => {
                const product = name(sku.productLocalizedNames, "");
                const size = name(sku.localizedNames, sku.skuCode);
                return product && product !== size ? product + " — " + size : size;
              })(),
              unitOfSale: sku.unitOfSale,
            })),
        };
        if (input.recipeReference !== null) {
          const detail = await loadRecipe(rtx, scope, input.recipeReference, at);
          if (detail === null) return fail("NotFound");
          return {
            screenId: "RECIPE-EDITOR" as const,
            sourceAsOf: at,
            permissions,
            viewer: scope.actorReference,
            choices,
            recipe: {
              ...detail,
              snapshot: undefined,
              presentation: undefined,
              // DEC-ALLERGEN-DECLARATIONS: what this version declares for each ingredient line.
              ingredientAllergens: detail.snapshot.ingredients.map((requirement, index) => {
                const reference = requirement.allergenDeclarationReference ?? null;
                const declaration = [...declarations.values()].find(
                  (d) => d.evidenceReference === reference,
                );
                const classification = (allergen: string) =>
                  declaration?.allergens.find((a) => a.allergenReference === allergen)
                    ?.classification ?? "Contains";
                const names = (kind: "Contains" | "CrossContactPossible") =>
                  requirement.allergens
                    .filter((a) => classification(a.allergenReference) === kind)
                    .map((a) => allergenName.get(a.allergenReference) ?? a.allergenReference);
                return {
                  line: index + 1,
                  kind: requirement.sourceKind,
                  declared: reference !== null,
                  current: declaration !== undefined,
                  contains: names("Contains"),
                  mayContain: names("CrossContactPossible"),
                };
              }),
              authorLabel: label(detail.authorReference),
              reviews: detail.reviews.map((review) => ({
                ...review,
                reviewerLabel: label(review.reviewerReference),
              })),
            },
          };
        }
        return {
          screenId: "RECIPE-LIST" as const,
          sourceAsOf: at,
          permissions,
          viewer: scope.actorReference,
          choices,
          recipes: await listRecipes(rtx, scope, at),
        };
      }),
    );
  };

  const command = async (input: { sessionCookie: unknown; csrf: unknown; body: unknown }) => {
    const body = parseRecipeCommandBody(input.body);
    const current = await session(input);
    return retryTransactionConflict(() =>
      options.persistence.transactions.run(async (tx) => {
        const scope = await scopeFor(tx, input.sessionCookie, current.sessionReference);
        const action =
          body.action === "SaveDraft"
            ? "recipe.update"
            : body.action === "Review"
              ? "recipe.approve"
              : "recipe.publish";
        if (!(await scope.may(action))) fail("PermissionDenied");
        const rtx = tx as unknown as RecipeAuthoringTransaction;
        const at = options.persistence.now();
        const writer = {
          actorReference: scope.actorReference,
          at,
          nextReference: () => options.references.next(),
        };
        const reviewersAuthorized = async (actors: readonly string[]) =>
          (await brandActionHeldBy(tx as unknown as RoleAssignmentTransaction, {
            brandReference: scope.brandReference,
            actorReferences: actors,
            action: "recipe.approve",
            at,
          })) &&
          (await confirmActiveBrandMembers(tx as unknown as MemberDirectoryTransaction, {
            brandReference: scope.brandReference,
            actorReferences: actors,
            at,
          }));
        try {
          switch (body.action) {
            case "SaveDraft": {
              const draft = (() => {
                try {
                  return parseRecipeDraft(body.draft);
                } catch (error) {
                  if (error instanceof RecipeAuthoringError) throw error;
                  return fail("Invalid");
                }
              })();
              return await saveRecipeDraft(rtx, scope, {
                ...writer,
                operationReference: body.operationReference,
                recipeReference: body.recipeReference,
                expectedAggregateVersion: body.expectedAggregateVersion,
                revisionOf: body.revisionOf,
                draft,
                facts: (await facts(tx, scope)).recipeFacts,
                auditReference: options.references.next(),
              });
            }
            case "Review":
              return await recordRecipeReview(rtx, scope, {
                ...writer,
                reviewReference: body.operationReference,
                recipeReference: body.recipeReference,
                versionReference: body.versionReference,
                subject: body.subject,
                kind: body.kind,
                decision: body.decision,
                comment: body.comment,
                auditReference: options.references.next(),
              });
            case "Publish":
              return await publishRecipe(rtx, scope, {
                ...writer,
                operationReference: body.operationReference,
                recipeReference: body.recipeReference,
                expectedAggregateVersion: body.expectedAggregateVersion,
                facts: (await facts(tx, scope)).recipeFacts,
                reviewersAuthorized,
                auditReference: options.references.next(),
              });
            case "PublishKitchen":
              return await publishRecipePreparation(rtx, scope, {
                ...writer,
                operationReference: body.operationReference,
                recipeReference: body.recipeReference,
                reviewersAuthorized,
                auditReference: options.references.next(),
              });
            case "BindSku": {
              const sku = (await listBrandSkuChoices(tx as never, scope)).find(
                (item) => item.skuReference === body.skuReference && item.active,
              );
              if (sku === undefined) return fail("NotFound");
              return await bindRecipeToSku(rtx, scope, {
                ...writer,
                operationReference: body.operationReference,
                recipeReference: body.recipeReference,
                skuReference: body.skuReference,
                storeReference: body.storeOnly ? scope.storeReference : null,
                skuUnitOfSale: sku.unitOfSale,
                auditReference: options.references.next(),
              });
            }
            case "EndStoreBinding":
              return await endStoreRecipeBinding(rtx, scope, {
                ...writer,
                operationReference: body.operationReference,
                bindingReference: body.bindingReference,
                auditReference: options.references.next(),
              });
            case "Archive":
              return await archiveRecipe(rtx, scope, {
                ...writer,
                operationReference: body.operationReference,
                recipeReference: body.recipeReference,
                expectedAggregateVersion: body.expectedAggregateVersion,
                auditReference: options.references.next(),
              });
          }
        } catch (error) {
          if (error instanceof RecipeAuthoringError)
            return fail(authoringErrors[error.code], error.line);
          throw error;
        }
      }),
    );
  };
  return { query, command };
}
