/** WP-2423 / DEC-RECIPE-AUTHORING: RECIPE-LIST / RECIPE-EDITOR view contract and same-origin client. */
export type RecipeErrorCode =
  | "PermissionDenied"
  | "NotFound"
  | "Conflict"
  | "CodeTaken"
  | "ReviewRequired"
  | "ReviewerNotIndependent"
  | "Lifecycle"
  | "InUse"
  | "LineInvalid"
  | "Invalid"
  | "Offline"
  | "Unavailable";
export class RecipePageError extends Error {
  constructor(
    readonly code: RecipeErrorCode,
    readonly line: number | null = null,
  ) {
    super("Recipes are unavailable");
    this.name = "RecipePageError";
  }
}
export type RecipeLifecycle = "Draft" | "Published" | "Invalidated" | "Archived";
export interface RecipeBinding {
  readonly bindingReference: string;
  readonly recipeVersionReference: string;
  readonly skuReference: string;
  readonly storeReference: string | null;
  readonly since: string;
}
export interface RecipeSummary {
  readonly recipeReference: string;
  readonly familyReference: string;
  readonly familyRevision: number;
  readonly name: string;
  readonly code: string;
  readonly lifecycle: RecipeLifecycle;
  readonly versionReference: string;
  readonly aggregateVersion: number;
  readonly yieldQuantity: string;
  readonly yieldUnit: string;
  readonly ingredientCount: number;
  readonly standardCostCents: string;
  readonly kitchenInstructions: "NotPublished" | "Published";
  readonly bindings: readonly RecipeBinding[];
  readonly updatedAt: string;
}
export interface RecipeDraftIngredient {
  readonly kind: "InventoryItem" | "SubRecipe";
  readonly sourceReference: string;
  readonly quantity: string;
  readonly lossPercent: string;
  readonly unitCostCents: string | null;
}
export interface RecipeDraftStep {
  readonly sequence: number;
  readonly instruction: string;
  readonly durationSeconds: number;
  readonly capabilityReference: string;
}
export interface RecipeDraft {
  readonly name: string;
  readonly code: string;
  readonly yieldQuantity: string;
  readonly yieldUnit: string;
  readonly ingredients: readonly RecipeDraftIngredient[];
  readonly steps: readonly RecipeDraftStep[];
}
export interface RecipeReview {
  readonly reviewReference: string;
  readonly subject: "Recipe" | "Preparation";
  readonly kind: "Cost" | "FoodSafety";
  readonly decision: "Approved" | "Rejected";
  readonly reviewerReference: string;
  readonly reviewerLabel: string;
  readonly comment: string | null;
  readonly reviewedAt: string;
  readonly current: boolean;
}
export interface RecipeDetail extends RecipeSummary {
  readonly draft: RecipeDraft;
  readonly authorReference: string;
  readonly authorLabel: string;
  readonly reviews: readonly RecipeReview[];
  readonly family: readonly {
    readonly recipeReference: string;
    readonly revision: number;
    readonly lifecycle: string;
  }[];
}
export interface RecipeChoices {
  readonly yieldUnits: readonly string[];
  readonly items: readonly {
    readonly itemReference: string;
    readonly internalCode: string;
    readonly name: string;
    readonly unitCode: string;
    readonly latestUnitCostCents: number | null;
  }[];
  readonly subRecipes: readonly {
    readonly recipeReference: string;
    readonly name: string;
    readonly yieldUnit: string;
  }[];
  readonly stations: readonly { readonly capabilityReference: string; readonly name: string }[];
  readonly skus: readonly {
    readonly skuReference: string;
    readonly code: string;
    readonly name: string;
    readonly unitOfSale: string;
  }[];
}
interface RecipeViewBase {
  readonly sourceAsOf: string;
  readonly permissions: {
    readonly mayEdit: boolean;
    readonly mayReview: boolean;
    readonly mayPublish: boolean;
  };
  readonly viewer: string;
  readonly choices: RecipeChoices;
}
export interface RecipeListView extends RecipeViewBase {
  readonly screenId: "RECIPE-LIST";
  readonly recipes: readonly RecipeSummary[];
}
export interface RecipeEditorView extends RecipeViewBase {
  readonly screenId: "RECIPE-EDITOR";
  readonly recipe: RecipeDetail;
}
export type RecipeCommand =
  | {
      readonly action: "SaveDraft";
      readonly operationReference: string;
      readonly recipeReference: string;
      readonly expectedAggregateVersion: number | null;
      readonly revisionOf: string | null;
      readonly draft: RecipeDraft;
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
export interface RecipeClient {
  load(recipeReference: string | null): Promise<unknown>;
  command?(command: RecipeCommand): Promise<unknown>;
}

const invalid = (): never => {
  throw new Error("RECIPE_PAGE_INVALID");
};
export function parseRecipeListView(value: unknown): RecipeListView {
  const r = value as Record<string, unknown> | null;
  if (
    r === null ||
    typeof r !== "object" ||
    r.screenId !== "RECIPE-LIST" ||
    !Array.isArray(r.recipes) ||
    typeof r.choices !== "object" ||
    r.choices === null
  )
    return invalid();
  return r as unknown as RecipeListView;
}
export function parseRecipeEditorView(value: unknown): RecipeEditorView {
  const r = value as Record<string, unknown> | null;
  const recipe = r?.recipe as Record<string, unknown> | undefined;
  if (
    r === null ||
    typeof r !== "object" ||
    r.screenId !== "RECIPE-EDITOR" ||
    typeof recipe !== "object" ||
    recipe === null ||
    typeof recipe.draft !== "object" ||
    !Array.isArray(recipe.reviews)
  )
    return invalid();
  return r as unknown as RecipeEditorView;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
export function parseRecipeRouteReference(value: unknown): string {
  return typeof value === "string" && uuid.test(value) ? value : invalid();
}

/** Code suggestion from a name: uppercase letters, digits and hyphens, starting with a letter. */
export function suggestRecipeCode(name: string): string {
  const base = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/gu, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 32);
  return /^[A-Z]/u.test(base) && base.length >= 2 ? base : base ? "R-" + base : "";
}
/** CAD cents (decimal string) as dollars with two decimals, rounding half to even. */
export function centsText(cents: string): string {
  const value = BigInt(cents);
  const negative = value < 0n,
    absolute = negative ? -value : value;
  return (
    (negative ? "-" : "") +
    (absolute / 100n).toString() +
    "." +
    (absolute % 100n).toString().padStart(2, "0")
  );
}
/** Line standard cost in cents for the editor preview, using the same exact decimal arithmetic. */
export function lineCostCentsText(
  quantity: string,
  lossPercent: string,
  unitCostCents: string | null,
) {
  const scaled = (value: string, scale: number) => {
    const match = /^(\d+)(?:\.(\d+))?$/u.exec(value.trim());
    if (!match || (match[2]?.length ?? 0) > scale) return null;
    return BigInt((match[1] ?? "0") + (match[2] ?? "").padEnd(scale, "0"));
  };
  const q = scaled(quantity, 6),
    loss = scaled(lossPercent || "0", 2),
    cost = unitCostCents === null ? 0n : scaled(unitCostCents, 4);
  if (q === null || loss === null || cost === null) return null;
  const numerator = q * (10_000n + loss) * cost,
    denominator = 1_000_000n * 10_000n * 10_000n;
  const quotient = numerator / denominator,
    twice = (numerator % denominator) * 2n;
  return (
    twice > denominator || (twice === denominator && quotient % 2n === 1n)
      ? quotient + 1n
      : quotient
  ).toString();
}

export const unavailableRecipeClient: RecipeClient = Object.freeze({
  load: async () => {
    throw new RecipePageError("Unavailable");
  },
});
const codes = new Set<RecipeErrorCode>([
  "PermissionDenied",
  "NotFound",
  "Conflict",
  "CodeTaken",
  "ReviewRequired",
  "ReviewerNotIndependent",
  "Lifecycle",
  "InUse",
  "LineInvalid",
  "Invalid",
]);
export function createRecipeClient(csrf: string, fetcher: typeof fetch = fetch): RecipeClient {
  const post = async (path: string, body: unknown) => {
    let response: Response;
    try {
      response = await fetcher(path, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", "x-bop-csrf": csrf },
        body: JSON.stringify(body),
      });
    } catch {
      throw new RecipePageError("Offline");
    }
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as {
        error?: unknown;
        line?: unknown;
      } | null;
      const code = String(payload?.error) as RecipeErrorCode;
      throw new RecipePageError(
        codes.has(code) ? code : response.status === 403 ? "PermissionDenied" : "Unavailable",
        typeof payload?.line === "number" ? payload.line : null,
      );
    }
    return response.json() as Promise<unknown>;
  };
  return {
    load: (recipeReference) => post("/merchant/commerce/recipes/query", { recipeReference }),
    command: (command) => post("/merchant/commerce/recipes/command", command),
  };
}
