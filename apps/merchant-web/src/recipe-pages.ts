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
export const recipeSourceKinds = [
  "Recipe",
  "Inventory",
  "Supplier",
  "Allergen",
  "Preparation",
  "Substitution",
  "Usage",
] as const;
export type RecipeSourceKind = (typeof recipeSourceKinds)[number];
export type RecipeSummary<T = string> =
  | {
      readonly status: "Available";
      readonly value: T;
      readonly source: RecipeSourceKind;
      readonly sourceVersion: string;
    }
  | { readonly status: "Unavailable" | "PermissionHidden" };
export type RecipeSource =
  | { readonly status: "Current" | "Stale"; readonly version: string; readonly asOfUtc: string }
  | { readonly status: "Unavailable" | "PermissionHidden" };
export interface RecipeViewMetadata {
  readonly projectionVersion: 2;
  readonly asOfUtc: string;
  readonly scope: { readonly tenantReference: string; readonly brandReference: string };
  readonly partial: boolean;
  readonly freshness: "Fresh" | "Stale";
  readonly sources: Readonly<Record<RecipeSourceKind, RecipeSource>>;
}
export interface RecipeCost {
  readonly amountMinor: string;
  readonly currencyCode: string;
}
export interface RecipeListItemView {
  readonly recipeReference: string;
  readonly name: string;
  readonly stableCode: string;
  readonly lifecycle: "Draft" | "Published" | "Invalidated" | "Archived";
  readonly yieldSummary: string;
  readonly cost: RecipeSummary<RecipeCost>;
  readonly allergenStatus: "Verified" | "Unverified" | "MissingEvidence";
  readonly usageSummary: RecipeSummary;
  readonly effectiveVersion: string;
  readonly ingredientSummary: RecipeSummary;
  readonly mappingMissing: boolean | null;
  readonly costChanged: boolean | null;
  readonly aggregateVersion: number;
}
export interface RecipeListView extends RecipeViewMetadata {
  readonly screenId: "RECIPE-LIST";
  readonly asOfUtc: string;
  readonly items: readonly RecipeListItemView[];
}
export interface RecipeEditorView extends RecipeListItemView, RecipeViewMetadata {
  readonly screenId: "RECIPE-EDITOR";
  readonly ingredients: readonly {
    readonly sourceReference: string;
    readonly sourceKind: "InventoryItem" | "SubRecipe";
    readonly sourceName: RecipeSummary;
    readonly quantitySummary: string;
    readonly lossSummary: string;
    readonly allergenSummary: RecipeSummary;
    readonly evidenceSummary: RecipeSummary;
    readonly mappingStatus: "Resolved" | "Unresolved";
  }[];
  readonly preparationSummary: RecipeSummary;
  readonly substitutionPolicySummary: RecipeSummary;
  readonly allergenUnionSummary: RecipeSummary;
  readonly costDerivationSummary: RecipeSummary;
  readonly productSkuUsageSummary: RecipeSummary;
  readonly reviewSummary: RecipeSummary;
  readonly historySummary: RecipeSummary;
}
export interface RecipeClient {
  readonly scope: RecipeViewMetadata["scope"] | null;
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
  if (Object.values(Object.getOwnPropertyDescriptors(value)).some((field) => !("value" in field)))
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
function instant(value: unknown): string {
  if (typeof value !== "string") throw new RecipeClientError("Unavailable");
  try {
    if (new Date(value).toISOString() !== value) throw new Error("instant");
  } catch {
    throw new RecipeClientError("Unavailable");
  }
  return value;
}
const metadataKeys = [
  "projectionVersion",
  "asOfUtc",
  "scope",
  "partial",
  "freshness",
  "sources",
] as const;
function metadata(raw: Record<string, unknown>): RecipeViewMetadata {
  if (raw.projectionVersion !== 2 || typeof raw.partial !== "boolean")
    throw new RecipeClientError("Unavailable");
  const scope = object(raw.scope, ["tenantReference", "brandReference"]);
  for (const value of Object.values(scope))
    if (typeof value !== "string" || !uuid.test(value)) throw new RecipeClientError("Unavailable");
  const asOfUtc = instant(raw.asOfUtc);
  const sourceInput = object(raw.sources, recipeSourceKinds);
  const sources = Object.fromEntries(
    recipeSourceKinds.map((kind) => {
      const candidate = sourceInput[kind];
      // Inspect descriptors before reading untrusted properties, including the discriminant.
      const status =
        candidate !== null && typeof candidate === "object"
          ? (Object.getOwnPropertyDescriptor(candidate, "status")?.value as unknown)
          : undefined;
      if (status === "Unavailable" || status === "PermissionHidden") {
        object(candidate, ["status"]);
        if (!raw.partial) throw new RecipeClientError("Unavailable");
        return [kind, Object.freeze({ status })];
      }
      const source = object(candidate, ["status", "version", "asOfUtc"]);
      const state = choice(source.status, ["Current", "Stale"]);
      const sourceAsOf = instant(source.asOfUtc);
      if (
        Date.parse(sourceAsOf) > Date.parse(asOfUtc) ||
        (state === "Stale" && raw.freshness !== "Stale")
      )
        throw new RecipeClientError("Unavailable");
      return [
        kind,
        Object.freeze({ status: state, version: text(source.version, 120), asOfUtc: sourceAsOf }),
      ];
    }),
  ) as Record<RecipeSourceKind, RecipeSource>;
  return Object.freeze({
    projectionVersion: 2,
    asOfUtc,
    scope: Object.freeze({
      tenantReference: scope.tenantReference as string,
      brandReference: scope.brandReference as string,
    }),
    partial: raw.partial,
    freshness: choice(raw.freshness, ["Fresh", "Stale"]),
    sources: Object.freeze(sources),
  });
}
function summary<T = string>(
  value: unknown,
  meta: RecipeViewMetadata,
  parse: (value: unknown) => T = text as (value: unknown) => T,
): RecipeSummary<T> {
  const status =
    value !== null && typeof value === "object"
      ? (Object.getOwnPropertyDescriptor(value, "status")?.value as unknown)
      : undefined;
  if (status === "Unavailable" || status === "PermissionHidden") {
    object(value, ["status"]);
    if (!meta.partial) throw new RecipeClientError("Unavailable");
    return Object.freeze({ status });
  }
  const raw = object(value, ["status", "value", "source", "sourceVersion"]);
  if (raw.status !== "Available") throw new RecipeClientError("Unavailable");
  const source = choice(raw.source, recipeSourceKinds);
  const evidence = meta.sources[source];
  if (
    (evidence.status !== "Current" && evidence.status !== "Stale") ||
    evidence.version !== raw.sourceVersion
  )
    throw new RecipeClientError("Unavailable");
  return Object.freeze({
    status: "Available",
    value: parse(raw.value),
    source,
    sourceVersion: evidence.version,
  });
}
function cost(value: unknown): RecipeCost {
  const raw = object(value, ["amountMinor", "currencyCode"]);
  if (
    typeof raw.amountMinor !== "string" ||
    !minor.test(raw.amountMinor) ||
    typeof raw.currencyCode !== "string" ||
    !/^[A-Z]{3}$/u.test(raw.currencyCode)
  )
    throw new RecipeClientError("Unavailable");
  return Object.freeze({ amountMinor: raw.amountMinor, currencyCode: raw.currencyCode });
}
export function recipeSummaryText(value: RecipeSummary): string {
  return value.status === "Available"
    ? value.value
    : value.status === "PermissionHidden"
      ? "Restricted"
      : "Unavailable";
}
const commonKeys = [
  "recipeReference",
  "name",
  "stableCode",
  "lifecycle",
  "yieldSummary",
  "cost",
  "allergenStatus",
  "usageSummary",
  "effectiveVersion",
  "ingredientSummary",
  "mappingMissing",
  "costChanged",
  "aggregateVersion",
] as const;
function common(raw: Record<string, unknown>, meta: RecipeViewMetadata): RecipeListItemView {
  if (
    typeof raw.recipeReference !== "string" ||
    !uuid.test(raw.recipeReference) ||
    typeof raw.stableCode !== "string" ||
    !code.test(raw.stableCode) ||
    (raw.mappingMissing !== null && typeof raw.mappingMissing !== "boolean") ||
    (raw.costChanged !== null && typeof raw.costChanged !== "boolean") ||
    (!meta.partial && (raw.mappingMissing === null || raw.costChanged === null))
  )
    throw new RecipeClientError("Unavailable");
  return Object.freeze({
    recipeReference: raw.recipeReference,
    name: text(raw.name, 120),
    stableCode: raw.stableCode,
    lifecycle: choice(raw.lifecycle, ["Draft", "Published", "Invalidated", "Archived"]),
    yieldSummary: text(raw.yieldSummary),
    cost: summary(raw.cost, meta, cost),
    allergenStatus: safeAllergenStatus(raw.allergenStatus, meta),
    usageSummary: summary(raw.usageSummary, meta),
    effectiveVersion: text(raw.effectiveVersion),
    ingredientSummary: summary(raw.ingredientSummary, meta),
    mappingMissing: raw.mappingMissing,
    costChanged: raw.costChanged,
    aggregateVersion: integer(raw.aggregateVersion),
  });
}
function safeAllergenStatus(
  value: unknown,
  meta: RecipeViewMetadata,
): RecipeListItemView["allergenStatus"] {
  const status = choice(value, ["Verified", "Unverified", "MissingEvidence"]);
  const safety = recipeSourceKinds.filter((kind) => kind !== "Usage");
  if (
    status === "Verified" &&
    (meta.freshness !== "Fresh" || safety.some((kind) => meta.sources[kind].status !== "Current"))
  )
    return "Unverified";
  return status;
}
export function assertRecipeViewScope(
  view: RecipeViewMetadata,
  scope: RecipeClient["scope"],
): void {
  if (
    scope === null ||
    view.scope.tenantReference !== scope.tenantReference ||
    view.scope.brandReference !== scope.brandReference
  )
    throw new RecipeClientError("PermissionDenied");
}
export function parseRecipeRouteReference(value: unknown) {
  if (typeof value !== "string" || !uuid.test(value)) throw new RecipeClientError("NotFound");
  return value;
}
export function parseRecipeListView(value: unknown): RecipeListView {
  const raw = object(value, ["screenId", ...metadataKeys, "items"]);
  if (
    raw.screenId !== "RECIPE-LIST" ||
    typeof raw.asOfUtc !== "string" ||
    !Array.isArray(raw.items)
  )
    throw new RecipeClientError("Unavailable");
  const meta = metadata(raw);
  return Object.freeze({
    screenId: "RECIPE-LIST",
    ...meta,
    items: Object.freeze(raw.items.map((item) => common(object(item, commonKeys), meta))),
  });
}
export function parseRecipeEditorView(value: unknown): RecipeEditorView {
  const raw = object(value, [
    "screenId",
    ...metadataKeys,
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
  const meta = metadata(raw);
  return Object.freeze({
    ...common(raw, meta),
    ...meta,
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
          sourceName: summary(item.sourceName, meta),
          quantitySummary: text(item.quantitySummary),
          lossSummary: text(item.lossSummary),
          allergenSummary: summary(item.allergenSummary, meta),
          evidenceSummary: summary(item.evidenceSummary, meta),
          mappingStatus: choice(item.mappingStatus, ["Resolved", "Unresolved"]),
        });
      }),
    ),
    preparationSummary: summary(raw.preparationSummary, meta),
    substitutionPolicySummary: summary(raw.substitutionPolicySummary, meta),
    allergenUnionSummary: summary(raw.allergenUnionSummary, meta),
    costDerivationSummary: summary(raw.costDerivationSummary, meta),
    productSkuUsageSummary: summary(raw.productSkuUsageSummary, meta),
    reviewSummary: summary(raw.reviewSummary, meta),
    historySummary: summary(raw.historySummary, meta),
  });
}
export const unavailableRecipeClient: RecipeClient = Object.freeze({
  scope: null,
  async list() {
    throw new RecipeClientError("Unavailable");
  },
  async load() {
    throw new RecipeClientError("Unavailable");
  },
});
