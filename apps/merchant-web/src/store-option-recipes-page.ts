/** WP-2423 slice 4.4: RECIPE-OPTION-LIST view contract and same-origin client. */
export type OptionRecipeErrorCode =
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
  | "Offline"
  | "Unavailable";
export class OptionRecipePageError extends Error {
  constructor(
    readonly code: OptionRecipeErrorCode,
    readonly skuReference: string | null = null,
  ) {
    super("Option recipes are unavailable");
    this.name = "OptionRecipePageError";
  }
}
export type OptionRecipeChangeKind = "NoChange" | "Replace" | "Add" | "Remove";
export interface OptionRecipeChangeContent {
  readonly kind: OptionRecipeChangeKind;
  readonly fromItemReference: string | null;
  readonly toItemReference: string | null;
  readonly quantity: string | null;
  readonly unitCostCents: string | null;
  readonly lossPercent: string;
}
export interface OptionRecipeRow {
  readonly productName: string;
  readonly setName: string;
  readonly optionName: string;
  readonly offered: boolean;
  readonly bindingReference: string;
  readonly optionReference: string;
  readonly quantities: readonly number[];
  readonly sizes: readonly { readonly skuReference: string; readonly name: string }[];
  /** Every current recipe of the product's sizes has a published rule for each quantity. */
  readonly covered: boolean;
  readonly change: {
    readonly changeVersionReference: string;
    readonly version: number;
    readonly content: OptionRecipeChangeContent;
    readonly byViewer: boolean;
    readonly recordedAt: string;
    readonly published: boolean;
    readonly reviews: readonly {
      readonly kind: "Cost" | "FoodSafety";
      readonly decision: "Approved" | "Rejected";
      readonly byViewer: boolean;
      readonly comment: string | null;
      readonly reviewedAt: string;
    }[];
    readonly lines: readonly {
      readonly skuReference: string;
      readonly quantity: number;
      readonly changes: readonly {
        readonly fromItemReference: string | null;
        readonly fromQuantityMicrounits: string | null;
        readonly toItemReference: string | null;
        readonly toQuantityMicrounits: string | null;
      }[];
    }[];
  } | null;
}
export interface OptionRecipeView {
  readonly screenId: "RECIPE-OPTION-LIST";
  readonly sourceAsOf: string;
  readonly permissions: {
    readonly mayEdit: boolean;
    readonly mayReview: boolean;
    readonly mayPublish: boolean;
  };
  readonly ingredients: readonly {
    readonly itemReference: string;
    readonly name: string;
    readonly unitCode: string;
    readonly declared: boolean;
    readonly latestUnitCostCents: string | null;
  }[];
  readonly options: readonly OptionRecipeRow[];
}
export type OptionRecipeCommand =
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
export interface OptionRecipeClient {
  load(): Promise<unknown>;
  command?(command: OptionRecipeCommand): Promise<unknown>;
}
export function parseOptionRecipeView(value: unknown): OptionRecipeView {
  const r = value as Record<string, unknown> | null;
  if (
    r === null ||
    typeof r !== "object" ||
    r.screenId !== "RECIPE-OPTION-LIST" ||
    !Array.isArray(r.options) ||
    !Array.isArray(r.ingredients)
  )
    throw new Error("OPTION_RECIPE_PAGE_INVALID");
  return r as unknown as OptionRecipeView;
}
/** "200" from 200000000 microunits; "0.018" from 18000. */
export function microText(micro: string): string {
  const digits = micro.padStart(7, "0");
  const whole = digits.slice(0, -6).replace(/^0+(?=\d)/u, ""),
    fraction = digits.slice(-6).replace(/0+$/u, "");
  return fraction ? whole + "." + fraction : whole;
}
export type OptionRecipeStatus =
  "NotSet" | "NeedsReview" | "Rejected" | "ReadyToPublish" | "Published" | "NeedsUpdate";
/** Where an option stands: what it needs next before customers can choose it. */
export function optionRecipeStatus(row: OptionRecipeRow): OptionRecipeStatus {
  const change = row.change;
  if (change === null) return "NotSet";
  if (change.published) return row.covered ? "Published" : "NeedsUpdate";
  if (change.reviews.some((review) => review.decision === "Rejected")) return "Rejected";
  return change.reviews.filter((review) => review.decision === "Approved").length === 2
    ? "ReadyToPublish"
    : "NeedsReview";
}
export const unavailableOptionRecipeClient: OptionRecipeClient = {
  load: async () => {
    throw new OptionRecipePageError("Unavailable");
  },
};
const codes = new Set<OptionRecipeErrorCode>([
  "PermissionDenied",
  "NotFound",
  "Conflict",
  "NoRecipe",
  "IngredientMissing",
  "IngredientPresent",
  "UnitMismatch",
  "ItemUnavailable",
  "AllergenUndeclared",
  "ReviewRequired",
  "ReviewerNotIndependent",
  "Invalid",
]);
export function createOptionRecipeClient(
  csrf: string,
  fetcher: typeof fetch = fetch,
): OptionRecipeClient {
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
      throw new OptionRecipePageError("Offline");
    }
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as {
        error?: unknown;
        skuReference?: unknown;
      } | null;
      const code = String(payload?.error) as OptionRecipeErrorCode;
      throw new OptionRecipePageError(
        codes.has(code) ? code : response.status === 403 ? "PermissionDenied" : "Unavailable",
        typeof payload?.skuReference === "string" ? payload.skuReference : null,
      );
    }
    return response.json() as Promise<unknown>;
  };
  return {
    load: () => post("/merchant/commerce/option-recipes/query", {}),
    command: (command) => post("/merchant/commerce/option-recipes/command", command),
  };
}
