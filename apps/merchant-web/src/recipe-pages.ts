export type RecipeClientErrorCode =
  | "PermissionDenied"
  | "NotFound"
  | "FeatureDisabled"
  | "Stale"
  | "Conflict"
  | "CommandFailed"
  | "Offline"
  | "Unavailable";
export class RecipeClientError extends Error {
  constructor(readonly code: RecipeClientErrorCode) {
    super("Recipe view is unavailable");
    this.name = "RecipeClientError";
  }
}
export interface RecipeListItemView {
  readonly recipeReference: string;
  readonly name: string;
  readonly stableCode: string;
  readonly lifecycle: "Draft" | "Published" | "Invalidated" | "Archived";
  readonly yieldSummary: string;
  readonly costMinor: string;
  readonly allergenStatus: "Verified" | "Unverified" | "MissingEvidence";
  readonly usageSummary: string;
  readonly effectiveVersion: string;
  readonly ingredientSummary: string;
  readonly mappingMissing: boolean;
  readonly costChanged: boolean;
  readonly aggregateVersion: number;
}
export interface RecipeListView {
  readonly screenId: "RECIPE-LIST";
  readonly asOfUtc: string;
  readonly items: readonly RecipeListItemView[];
}
export interface RecipeEditorView extends RecipeListItemView {
  readonly screenId: "RECIPE-EDITOR";
  readonly ingredients: readonly {
    readonly sourceReference: string;
    readonly sourceKind: "InventoryItem" | "SubRecipe";
    readonly sourceName: string;
    readonly quantitySummary: string;
    readonly lossSummary: string;
    readonly allergenSummary: string;
    readonly evidenceSummary: string;
    readonly mappingStatus: "Resolved" | "Unresolved";
  }[];
  readonly preparationSummary: string;
  readonly substitutionPolicySummary: string;
  readonly allergenUnionSummary: string;
  readonly costDerivationSummary: string;
  readonly productSkuUsageSummary: string;
  readonly reviewSummary: string;
  readonly historySummary: string;
}
export interface RecipeClient {
  list(): Promise<RecipeListView>;
  load(reference: string): Promise<RecipeEditorView>;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const code = /^[A-Z][A-Z0-9_-]{0,63}$/u;
const minor = /^(?:0|[1-9][0-9]{0,29})$/u;
function object(value: unknown, keys: readonly string[]) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== keys.length ||
    Reflect.ownKeys(value).some((key) => typeof key !== "string" || !keys.includes(key))
  )
    throw new RecipeClientError("Unavailable");
  return value as Record<string, unknown>;
}
function text(value: unknown, max = 220) {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > max ||
    /[<>{}]|https?:\/\//iu.test(value)
  )
    throw new RecipeClientError("Unavailable");
  return value.trim();
}
function choice<T extends string>(value: unknown, values: readonly T[]): T {
  if (!values.includes(value as T)) throw new RecipeClientError("Unavailable");
  return value as T;
}
function integer(value: unknown) {
  if (!Number.isSafeInteger(value) || (value as number) < 1)
    throw new RecipeClientError("Unavailable");
  return value as number;
}
const commonKeys = [
  "recipeReference",
  "name",
  "stableCode",
  "lifecycle",
  "yieldSummary",
  "costMinor",
  "allergenStatus",
  "usageSummary",
  "effectiveVersion",
  "ingredientSummary",
  "mappingMissing",
  "costChanged",
  "aggregateVersion",
] as const;
function common(raw: Record<string, unknown>): RecipeListItemView {
  if (
    typeof raw.recipeReference !== "string" ||
    !uuid.test(raw.recipeReference) ||
    typeof raw.stableCode !== "string" ||
    !code.test(raw.stableCode) ||
    typeof raw.costMinor !== "string" ||
    !minor.test(raw.costMinor) ||
    typeof raw.mappingMissing !== "boolean" ||
    typeof raw.costChanged !== "boolean"
  )
    throw new RecipeClientError("Unavailable");
  return Object.freeze({
    recipeReference: raw.recipeReference,
    name: text(raw.name, 120),
    stableCode: raw.stableCode,
    lifecycle: choice(raw.lifecycle, ["Draft", "Published", "Invalidated", "Archived"]),
    yieldSummary: text(raw.yieldSummary),
    costMinor: raw.costMinor,
    allergenStatus: choice(raw.allergenStatus, ["Verified", "Unverified", "MissingEvidence"]),
    usageSummary: text(raw.usageSummary),
    effectiveVersion: text(raw.effectiveVersion),
    ingredientSummary: text(raw.ingredientSummary),
    mappingMissing: raw.mappingMissing,
    costChanged: raw.costChanged,
    aggregateVersion: integer(raw.aggregateVersion),
  });
}
export function parseRecipeRouteReference(value: unknown) {
  if (typeof value !== "string" || !uuid.test(value)) throw new RecipeClientError("NotFound");
  return value;
}
export function parseRecipeListView(value: unknown): RecipeListView {
  const raw = object(value, ["screenId", "asOfUtc", "items"]);
  if (
    raw.screenId !== "RECIPE-LIST" ||
    typeof raw.asOfUtc !== "string" ||
    !Array.isArray(raw.items)
  )
    throw new RecipeClientError("Unavailable");
  try {
    if (new Date(raw.asOfUtc).toISOString() !== raw.asOfUtc) throw new Error("instant");
  } catch {
    throw new RecipeClientError("Unavailable");
  }
  return Object.freeze({
    screenId: "RECIPE-LIST",
    asOfUtc: raw.asOfUtc,
    items: Object.freeze(raw.items.map((item) => common(object(item, commonKeys)))),
  });
}
export function parseRecipeEditorView(value: unknown): RecipeEditorView {
  const raw = object(value, [
    "screenId",
    ...commonKeys,
    "ingredients",
    "preparationSummary",
    "substitutionPolicySummary",
    "allergenUnionSummary",
    "costDerivationSummary",
    "productSkuUsageSummary",
    "reviewSummary",
    "historySummary",
  ]);
  if (raw.screenId !== "RECIPE-EDITOR" || !Array.isArray(raw.ingredients))
    throw new RecipeClientError("Unavailable");
  return Object.freeze({
    ...common(raw),
    screenId: "RECIPE-EDITOR",
    ingredients: Object.freeze(
      raw.ingredients.map((candidate) => {
        const item = object(candidate, [
          "sourceReference",
          "sourceKind",
          "sourceName",
          "quantitySummary",
          "lossSummary",
          "allergenSummary",
          "evidenceSummary",
          "mappingStatus",
        ]);
        if (typeof item.sourceReference !== "string" || !uuid.test(item.sourceReference))
          throw new RecipeClientError("Unavailable");
        return Object.freeze({
          sourceReference: item.sourceReference,
          sourceKind: choice(item.sourceKind, ["InventoryItem", "SubRecipe"]),
          sourceName: text(item.sourceName, 120),
          quantitySummary: text(item.quantitySummary),
          lossSummary: text(item.lossSummary),
          allergenSummary: text(item.allergenSummary),
          evidenceSummary: text(item.evidenceSummary),
          mappingStatus: choice(item.mappingStatus, ["Resolved", "Unresolved"]),
        });
      }),
    ),
    preparationSummary: text(raw.preparationSummary),
    substitutionPolicySummary: text(raw.substitutionPolicySummary),
    allergenUnionSummary: text(raw.allergenUnionSummary),
    costDerivationSummary: text(raw.costDerivationSummary),
    productSkuUsageSummary: text(raw.productSkuUsageSummary),
    reviewSummary: text(raw.reviewSummary),
    historySummary: text(raw.historySummary),
  });
}
export const unavailableRecipeClient: RecipeClient = Object.freeze({
  async list() {
    throw new RecipeClientError("Unavailable");
  },
  async load() {
    throw new RecipeClientError("Unavailable");
  },
});
