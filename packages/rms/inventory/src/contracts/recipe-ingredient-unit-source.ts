import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  InventoryItemError,
  parseInventoryReference,
  parseInventoryInstant,
  parseInventoryUnit,
} from "../domain/inventory-item.js";
import { parseInventoryUnitConversion } from "../domain/inventory-item-snapshot.js";
import {
  parseInventoryConfigurationReferenceSnapshot,
  type InventoryConfigurationReferenceRequest,
} from "./configuration-reference-source.js";
import {
  unitList,
  unitRecord,
  inventoryOptionConsumptionUnitFields,
} from "./option-consumption-unit-source.js";
const fail = (): never => {
  throw new InventoryItemError("INVENTORY_ITEM_DEPENDENCY_UNAVAILABLE");
};
/** Same owning unit fields, selected by explicit Recipe pins rather than Option DTOs. */
export const inventoryRecipeIngredientUnitFields = inventoryOptionConsumptionUnitFields;
export function parseRecipeIngredientUnitPins(value: unknown) {
  const fields = [
    "recipeReference",
    "recipeVersionReference",
    "requirementReference",
    "itemReference",
    "operationReference",
  ] as const;
  const pins = unitList(value, 4096)
    .map((value) => {
      const raw = unitRecord(value, fields);
      return Object.freeze({
        recipeReference: parseInventoryReference(raw.recipeReference),
        recipeVersionReference: parseInventoryReference(raw.recipeVersionReference),
        requirementReference: parseInventoryReference(raw.requirementReference),
        itemReference: parseInventoryReference(raw.itemReference),
        operationReference: parseInventoryReference(raw.operationReference),
      });
    })
    .sort(
      (a, b) =>
        a.recipeVersionReference.localeCompare(b.recipeVersionReference) ||
        a.requirementReference.localeCompare(b.requirementReference),
    );
  const expected = new Map(pins.map((p) => [p.itemReference, p.operationReference]));
  if (
    new Set(pins.map((p) => p.recipeVersionReference + ":" + p.requirementReference)).size !==
      pins.length ||
    pins.some((p) => expected.get(p.itemReference) !== p.operationReference)
  )
    return fail();
  return Object.freeze(pins);
}
/** Pure physical-row decoder. Authority comes only from the owning held source. */
export function buildCurrentRecipeIngredientUnitFacts(
  value: unknown,
  raw: unknown,
  metadata: unknown,
  request: InventoryConfigurationReferenceRequest,
  nowInput: string,
) {
  const now = parseInventoryInstant(nowInput),
    source = parseInventoryConfigurationReferenceSnapshot(metadata, request, now),
    pins = parseRecipeIngredientUnitPins(value),
    expected = new Map(pins.map((p) => [p.itemReference, p.operationReference])),
    rows = unitList(raw, 4096);
  if (Date.parse(now) - Date.parse(source.observedAt) >= 5000 || rows.length !== expected.size)
    return fail();
  const units = rows
    .map((value) => {
      const row = unitRecord(value, [
          "itemReference",
          "itemVersion",
          "operationReference",
          "recordedAt",
          "baseUnit",
          "unitConversions",
          "precise",
        ]),
        itemReference = parseInventoryReference(row.itemReference),
        operationReference = parseInventoryReference(row.operationReference),
        recordedAt = parseInventoryInstant(row.recordedAt),
        root = source.items.find((r) => r.itemReference === itemReference),
        operation = source.operations.find((r) => r.operationReference === operationReference),
        version = source.versions.find(
          (r) => r.itemReference === itemReference && String(r.itemVersion) === row.itemVersion,
        );
      if (
        row.precise !== true ||
        !root ||
        !operation ||
        !version ||
        expected.get(itemReference) !== operationReference ||
        operation.itemReference !== itemReference ||
        operation.itemVersion !== version.itemVersion ||
        root.currentOperationReference !== operationReference ||
        root.currentItemVersion !== version.itemVersion ||
        version.lifecycle !== "Active" ||
        version.recordedAt !== recordedAt ||
        recordedAt > source.observedAt
      )
        return fail();
      const baseUnit = parseInventoryUnit(
        unitRecord(row.baseUnit, [
          "unitCode",
          "dimension",
          "displayPrecision",
          "ledgerPrecision",
          "roundingMode",
        ]),
      );
      const unitConversions = unitList(row.unitConversions)
        .map((value) => {
          const c = unitRecord(value, [
            "conversionReference",
            "fromUnitCode",
            "toBaseUnitCode",
            "multiplier",
            "effectiveFrom",
            "reasonCode",
            "status",
          ]);
          if (typeof c.multiplier !== "string" || c.multiplier.length > 40) return fail();
          return parseInventoryUnitConversion(c);
        })
        .sort((a, b) => a.conversionReference.localeCompare(b.conversionReference));
      if (
        new Set(unitConversions.map((c) => c.conversionReference)).size !==
          unitConversions.length ||
        unitConversions.some((c) => c.toBaseUnitCode !== baseUnit.unitCode)
      )
        return fail();
      return Object.freeze({
        itemReference,
        itemVersion: version.itemVersion,
        operationReference,
        recordedAt,
        baseUnit,
        unitConversions: Object.freeze(unitConversions),
      });
    })
    .sort((a, b) => a.itemReference.localeCompare(b.itemReference));
  if (new Set(units.map((r) => r.itemReference)).size !== units.length) return fail();
  const body = {
    profile: "CurrentRecipeIngredientUnitFactsV1" as const,
    request: source.request,
    pins,
    ownerSourceDigest: source.digest,
    ownerGeneration: source.generation,
    ownerObservedAt: source.observedAt,
    units: Object.freeze(units),
    unitArithmetic: "NotEvaluated" as const,
    conversionApplicability: "NotEvaluated" as const,
    stock: "NotEvaluated" as const,
    eligibility: "NotEvaluated" as const,
  };
  return Object.freeze({ ...body, digest: "sha256:" + sha256Hex(canonicalizeRfc8785(body)) });
}
