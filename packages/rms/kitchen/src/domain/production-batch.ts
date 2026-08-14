export type ProductionReference = string & { readonly __productionReference: unique symbol };
export type ProductionCode = string & { readonly __productionCode: unique symbol };
export type ProductionStatus = "Planned" | "InProgress" | "Completed" | "Quarantined";
export interface ProductionIngredient {
  readonly ingredientReference: ProductionReference;
  readonly inventoryItemReference: ProductionReference;
  readonly lotReference: ProductionReference | null;
  readonly plannedQuantityMicrounits: string;
  readonly actualQuantityMicrounits: string | null;
}
export interface ProductionBatch {
  readonly productionBatchReference: ProductionReference;
  readonly tenantReference: ProductionReference;
  readonly brandReference: ProductionReference;
  readonly storeReference: ProductionReference;
  readonly recipeReference: ProductionReference;
  readonly recipeVersionReference: ProductionReference;
  readonly stationReference: ProductionReference;
  readonly plannedYieldMicrounits: string;
  readonly actualYieldMicrounits: string | null;
  readonly ingredients: readonly ProductionIngredient[];
  readonly status: ProductionStatus;
  readonly qualityHold: boolean;
  readonly varianceBasisPoints: number | null;
  readonly qualityExceptionReasonCode: ProductionCode | null;
  readonly aggregateVersion: number;
  readonly plannedAt: string;
  readonly observedAt: string;
}
export type ProductionBatchErrorCode =
  | "PRODUCTION_BATCH_INPUT_INVALID"
  | "PRODUCTION_BATCH_TRANSITION_INVALID"
  | "PRODUCTION_BATCH_OBSERVATION_INCOMPLETE"
  | "PRODUCTION_BATCH_QUALITY_EXCEPTION_REQUIRED";
export class ProductionBatchError extends Error {
  constructor(readonly code: ProductionBatchErrorCode) {
    super("Production Batch is unavailable");
    this.name = "ProductionBatchError";
  }
}
const fail = (code: ProductionBatchErrorCode): never => {
  throw new ProductionBatchError(code);
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const code = /^[A-Z][A-Z0-9_-]{0,63}$/u;
const instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
export function parseProductionReference(value: unknown): ProductionReference {
  if (typeof value !== "string" || !uuid.test(value)) return fail("PRODUCTION_BATCH_INPUT_INVALID");
  return value as ProductionReference;
}
export function parseProductionCode(value: unknown): ProductionCode {
  if (typeof value !== "string" || !code.test(value)) return fail("PRODUCTION_BATCH_INPUT_INVALID");
  return value as ProductionCode;
}
function time(value: unknown) {
  if (typeof value !== "string" || !instant.test(value) || !Number.isFinite(Date.parse(value)))
    return fail("PRODUCTION_BATCH_INPUT_INVALID");
  return value;
}
function quantity(value: unknown, positive = false) {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]{0,29})$/u.test(value))
    return fail("PRODUCTION_BATCH_INPUT_INVALID");
  const parsed = BigInt(value);
  if (positive && parsed === 0n) return fail("PRODUCTION_BATCH_INPUT_INVALID");
  return parsed;
}
function plain(value: unknown, keys: readonly string[]) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== keys.length ||
    Reflect.ownKeys(value).some((key) => typeof key !== "string" || !keys.includes(key))
  )
    return fail("PRODUCTION_BATCH_INPUT_INVALID");
  return value as Record<string, unknown>;
}
function ingredient(value: unknown): ProductionIngredient {
  const raw = plain(value, [
    "ingredientReference",
    "inventoryItemReference",
    "lotReference",
    "plannedQuantityMicrounits",
    "actualQuantityMicrounits",
  ]);
  return Object.freeze({
    ingredientReference: parseProductionReference(raw.ingredientReference),
    inventoryItemReference: parseProductionReference(raw.inventoryItemReference),
    lotReference: raw.lotReference === null ? null : parseProductionReference(raw.lotReference),
    plannedQuantityMicrounits: quantity(raw.plannedQuantityMicrounits, true).toString(),
    actualQuantityMicrounits:
      raw.actualQuantityMicrounits === null
        ? null
        : quantity(raw.actualQuantityMicrounits).toString(),
  });
}
export function calculateYieldVarianceBasisPoints(planned: string, actual: string) {
  const plannedValue = quantity(planned, true);
  const actualValue = quantity(actual);
  const delta =
    actualValue >= plannedValue ? actualValue - plannedValue : plannedValue - actualValue;
  return Number((delta * 10000n + plannedValue / 2n) / plannedValue);
}
export function createProductionBatch(value: unknown): ProductionBatch {
  const raw = plain(value, [
    "productionBatchReference",
    "tenantReference",
    "brandReference",
    "storeReference",
    "recipeReference",
    "recipeVersionReference",
    "stationReference",
    "plannedYieldMicrounits",
    "actualYieldMicrounits",
    "ingredients",
    "status",
    "qualityHold",
    "varianceBasisPoints",
    "qualityExceptionReasonCode",
    "aggregateVersion",
    "plannedAt",
    "observedAt",
  ]);
  if (
    !Array.isArray(raw.ingredients) ||
    raw.ingredients.length < 1 ||
    raw.ingredients.length > 100 ||
    !["Planned", "InProgress", "Completed", "Quarantined"].includes(raw.status as string) ||
    typeof raw.qualityHold !== "boolean" ||
    !Number.isSafeInteger(raw.aggregateVersion) ||
    (raw.aggregateVersion as number) < 1
  )
    return fail("PRODUCTION_BATCH_INPUT_INVALID");
  const ingredients = raw.ingredients.map(ingredient);
  if (new Set(ingredients.map((item) => item.ingredientReference)).size !== ingredients.length)
    return fail("PRODUCTION_BATCH_INPUT_INVALID");
  const plannedYield = quantity(raw.plannedYieldMicrounits, true).toString();
  const actualYield =
    raw.actualYieldMicrounits === null
      ? null
      : quantity(raw.actualYieldMicrounits, true).toString();
  const variance = raw.varianceBasisPoints;
  if (
    (actualYield === null) !== (variance === null) ||
    (variance !== null &&
      (!Number.isSafeInteger(variance) ||
        (variance as number) < 0 ||
        calculateYieldVarianceBasisPoints(plannedYield, actualYield as string) !== variance))
  )
    return fail("PRODUCTION_BATCH_INPUT_INVALID");
  const exception =
    raw.qualityExceptionReasonCode === null
      ? null
      : parseProductionCode(raw.qualityExceptionReasonCode);
  if (
    (raw.qualityHold as boolean) !== (exception !== null) ||
    (raw.status === "Completed" &&
      (actualYield === null ||
        ingredients.some((item) => item.actualQuantityMicrounits === null) ||
        raw.qualityHold))
  )
    return fail("PRODUCTION_BATCH_INPUT_INVALID");
  return Object.freeze({
    productionBatchReference: parseProductionReference(raw.productionBatchReference),
    tenantReference: parseProductionReference(raw.tenantReference),
    brandReference: parseProductionReference(raw.brandReference),
    storeReference: parseProductionReference(raw.storeReference),
    recipeReference: parseProductionReference(raw.recipeReference),
    recipeVersionReference: parseProductionReference(raw.recipeVersionReference),
    stationReference: parseProductionReference(raw.stationReference),
    plannedYieldMicrounits: plannedYield,
    actualYieldMicrounits: actualYield,
    ingredients: Object.freeze(ingredients),
    status: raw.status as ProductionStatus,
    qualityHold: raw.qualityHold,
    varianceBasisPoints: variance as number | null,
    qualityExceptionReasonCode: exception,
    aggregateVersion: raw.aggregateVersion as number,
    plannedAt: time(raw.plannedAt),
    observedAt: time(raw.observedAt),
  });
}
export function observeProductionBatch(
  current: ProductionBatch,
  input: {
    readonly actualYieldMicrounits: string;
    readonly actualIngredientQuantities: Readonly<Record<string, string>>;
    readonly varianceThresholdBasisPoints: number;
    readonly qualityExceptionReasonCode: ProductionCode | null;
    readonly observedAt: string;
  },
) {
  if (
    current.status !== "InProgress" ||
    !Number.isSafeInteger(input.varianceThresholdBasisPoints) ||
    input.varianceThresholdBasisPoints < 0
  )
    return fail("PRODUCTION_BATCH_TRANSITION_INVALID");
  const actualYield = quantity(input.actualYieldMicrounits, true).toString();
  const ingredients = current.ingredients.map((item) => {
    const actual = input.actualIngredientQuantities[item.ingredientReference];
    if (actual === undefined) return fail("PRODUCTION_BATCH_OBSERVATION_INCOMPLETE");
    return Object.freeze({ ...item, actualQuantityMicrounits: quantity(actual).toString() });
  });
  if (Object.keys(input.actualIngredientQuantities).length !== ingredients.length)
    return fail("PRODUCTION_BATCH_OBSERVATION_INCOMPLETE");
  const variance = calculateYieldVarianceBasisPoints(current.plannedYieldMicrounits, actualYield);
  if (variance > input.varianceThresholdBasisPoints && input.qualityExceptionReasonCode === null)
    return fail("PRODUCTION_BATCH_QUALITY_EXCEPTION_REQUIRED");
  return createProductionBatch({
    ...current,
    actualYieldMicrounits: actualYield,
    ingredients,
    varianceBasisPoints: variance,
    qualityHold: input.qualityExceptionReasonCode !== null,
    qualityExceptionReasonCode: input.qualityExceptionReasonCode,
    aggregateVersion: current.aggregateVersion + 1,
    observedAt: input.observedAt,
  });
}
export function transitionProductionBatch(
  current: ProductionBatch,
  action: "Start" | "Complete" | "Quarantine",
  observedAt: string,
  reason: ProductionCode | null = null,
) {
  let status: ProductionStatus;
  if (action === "Start" && current.status === "Planned") status = "InProgress";
  else if (action === "Complete" && current.status === "InProgress") {
    if (
      current.actualYieldMicrounits === null ||
      current.ingredients.some((item) => item.actualQuantityMicrounits === null)
    )
      return fail("PRODUCTION_BATCH_OBSERVATION_INCOMPLETE");
    if (current.qualityHold) return fail("PRODUCTION_BATCH_TRANSITION_INVALID");
    status = "Completed";
  } else if (
    action === "Quarantine" &&
    ["InProgress", "Completed"].includes(current.status) &&
    reason !== null
  )
    status = "Quarantined";
  else return fail("PRODUCTION_BATCH_TRANSITION_INVALID");
  return createProductionBatch({
    ...current,
    status,
    qualityHold: status === "Quarantined",
    qualityExceptionReasonCode:
      status === "Quarantined" ? reason : current.qualityExceptionReasonCode,
    aggregateVersion: current.aggregateVersion + 1,
    observedAt,
  });
}
