export type ProductionBatchClientErrorCode =
  | "PermissionDenied"
  | "NotFound"
  | "FeatureDisabled"
  | "Stale"
  | "Conflict"
  | "CommandFailed"
  | "Offline"
  | "Unavailable";

export class ProductionBatchClientError extends Error {
  constructor(readonly code: ProductionBatchClientErrorCode) {
    super("Production Batch view is unavailable");
    this.name = "ProductionBatchClientError";
  }
}

export interface ProductionBatchIngredientView {
  readonly inventoryItemReference: string;
  readonly lotReference: string | null;
  readonly plannedQuantityMicrounits: string;
  readonly actualQuantityMicrounits: string | null;
}

export interface ProductionBatchItemView {
  readonly batchReference: string;
  readonly batchCode: string;
  readonly recipeReference: string;
  readonly recipeName: string;
  readonly recipeVersion: string;
  readonly plannedYieldMicrounits: string;
  readonly actualYieldMicrounits: string | null;
  readonly stationCode: string;
  readonly plannedDate: string;
  readonly status: "Planned" | "InProgress" | "Completed" | "Quarantined";
  readonly varianceBasisPoints: number | null;
  readonly qualityHold: boolean;
  readonly ingredients: readonly ProductionBatchIngredientView[];
}

export interface ProductionBatchView {
  readonly screenId: "KIT-PRODUCTION-BATCH";
  readonly asOfUtc: string;
  readonly items: readonly ProductionBatchItemView[];
}

export interface ProductionBatchClient {
  load(): Promise<unknown>;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const date = /^\d{4}-\d{2}-\d{2}$/u;
const quantity = /^(?:0|[1-9][0-9]{0,29})$/u;
const status = new Set(["Planned", "InProgress", "Completed", "Quarantined"]);

function object(value: unknown, keys: readonly string[]) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== keys.length ||
    Reflect.ownKeys(value).some((key) => typeof key !== "string" || !keys.includes(key))
  )
    throw new ProductionBatchClientError("Unavailable");
  return value as Record<string, unknown>;
}

function reference(value: unknown) {
  if (typeof value !== "string" || !uuid.test(value))
    throw new ProductionBatchClientError("Unavailable");
  return value;
}

function text(value: unknown, max = 120) {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > max ||
    /[<>{}$]|https?:\/\/|\b(?:CAD|USD|EUR|GBP)\b/iu.test(value)
  )
    throw new ProductionBatchClientError("Unavailable");
  return value.trim();
}

function exactQuantity(value: unknown, nullable = false) {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || !quantity.test(value))
    throw new ProductionBatchClientError("Unavailable");
  return value;
}

function parseIngredient(value: unknown): ProductionBatchIngredientView {
  const raw = object(value, [
    "inventoryItemReference",
    "lotReference",
    "plannedQuantityMicrounits",
    "actualQuantityMicrounits",
  ]);
  return Object.freeze({
    inventoryItemReference: reference(raw.inventoryItemReference),
    lotReference: raw.lotReference === null ? null : reference(raw.lotReference),
    plannedQuantityMicrounits: exactQuantity(raw.plannedQuantityMicrounits) as string,
    actualQuantityMicrounits: exactQuantity(raw.actualQuantityMicrounits, true),
  });
}

function parseItem(value: unknown): ProductionBatchItemView {
  const raw = object(value, [
    "batchReference",
    "batchCode",
    "recipeReference",
    "recipeName",
    "recipeVersion",
    "plannedYieldMicrounits",
    "actualYieldMicrounits",
    "stationCode",
    "plannedDate",
    "status",
    "varianceBasisPoints",
    "qualityHold",
    "ingredients",
  ]);
  if (
    typeof raw.plannedDate !== "string" ||
    !date.test(raw.plannedDate) ||
    !Number.isFinite(Date.parse(`${raw.plannedDate}T00:00:00.000Z`)) ||
    typeof raw.status !== "string" ||
    !status.has(raw.status) ||
    (raw.varianceBasisPoints !== null &&
      (!Number.isSafeInteger(raw.varianceBasisPoints) ||
        (raw.varianceBasisPoints as number) < 0)) ||
    typeof raw.qualityHold !== "boolean" ||
    !Array.isArray(raw.ingredients) ||
    raw.ingredients.length === 0
  )
    throw new ProductionBatchClientError("Unavailable");
  const ingredients = raw.ingredients.map(parseIngredient);
  if (
    new Set(
      ingredients.map((item) => `${item.inventoryItemReference}:${item.lotReference ?? "none"}`),
    ).size !== ingredients.length
  )
    throw new ProductionBatchClientError("Unavailable");
  return Object.freeze({
    batchReference: reference(raw.batchReference),
    batchCode: text(raw.batchCode, 64),
    recipeReference: reference(raw.recipeReference),
    recipeName: text(raw.recipeName),
    recipeVersion: text(raw.recipeVersion, 40),
    plannedYieldMicrounits: exactQuantity(raw.plannedYieldMicrounits) as string,
    actualYieldMicrounits: exactQuantity(raw.actualYieldMicrounits, true),
    stationCode: text(raw.stationCode, 64),
    plannedDate: raw.plannedDate,
    status: raw.status as ProductionBatchItemView["status"],
    varianceBasisPoints: raw.varianceBasisPoints as number | null,
    qualityHold: raw.qualityHold,
    ingredients: Object.freeze(ingredients),
  });
}

export function parseProductionBatchView(value: unknown): ProductionBatchView {
  const raw = object(value, ["screenId", "asOfUtc", "items"]);
  if (
    raw.screenId !== "KIT-PRODUCTION-BATCH" ||
    typeof raw.asOfUtc !== "string" ||
    !instant.test(raw.asOfUtc) ||
    !Array.isArray(raw.items)
  )
    throw new ProductionBatchClientError("Unavailable");
  const items = raw.items.map(parseItem);
  if (new Set(items.map((item) => item.batchReference)).size !== items.length)
    throw new ProductionBatchClientError("Unavailable");
  return Object.freeze({
    screenId: "KIT-PRODUCTION-BATCH",
    asOfUtc: raw.asOfUtc,
    items: Object.freeze(items),
  });
}

export const unavailableProductionBatchClient: ProductionBatchClient = Object.freeze({
  async load() {
    throw new ProductionBatchClientError(navigator.onLine ? "Unavailable" : "Offline");
  },
});
