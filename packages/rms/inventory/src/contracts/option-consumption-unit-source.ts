import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  InventoryItemError,
  parseInventoryReference,
  parseInventoryInstant,
  parseInventoryDecimal,
  parseInventoryUnit,
} from "../domain/inventory-item.js";
import { parseInventoryUnitConversion } from "../domain/inventory-item-snapshot.js";
import {
  parseInventoryConfigurationReferenceSnapshot,
  parseInventoryOptionPublicationOriginalClock,
  type InventoryConfigurationReferenceRequest,
} from "./configuration-reference-source.js";
const fail = (): never => {
  throw new InventoryItemError("INVENTORY_ITEM_DEPENDENCY_UNAVAILABLE");
};
export const inventoryOptionConsumptionUnitFields = Object.freeze([
  "itemReference",
  "itemVersion",
  "operationReference",
  "recordedAt",
  "baseUnit.unitCode",
  "baseUnit.dimension",
  "baseUnit.displayPrecision",
  "baseUnit.ledgerPrecision",
  "baseUnit.roundingMode",
  "unitConversions.conversionReference",
  "unitConversions.fromUnitCode",
  "unitConversions.toBaseUnitCode",
  "unitConversions.multiplier",
  "unitConversions.effectiveFrom",
  "unitConversions.status",
  "unitConversions.reasonCode",
] as const);
export function unitRecord(value: unknown, fields: readonly string[]) {
  if (
    !value ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== fields.length
  )
    return fail();
  const r: Record<string, unknown> = {};
  for (const k of fields) {
    const d = Object.getOwnPropertyDescriptor(value, k);
    if (!d?.enumerable || !("value" in d)) return fail();
    r[k] = d.value;
  }
  return r;
}
export function unitList(value: unknown, max = 100): unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > max ||
    Reflect.ownKeys(value).length !== value.length + 1
  )
    return fail();
  return Array.from({ length: value.length }, (_, i) => {
    const d = Object.getOwnPropertyDescriptor(value, String(i));
    if (!d?.enumerable || !("value" in d)) return fail();
    return d.value;
  });
}
const code = (v: unknown) =>
  typeof v === "string" && /^[A-Z0-9][A-Z0-9_-]{0,63}$/.test(v) ? v : fail();
const decimal = (v: unknown) =>
  typeof v === "string" && v.length <= 40 ? parseInventoryDecimal(v) : fail();
export function parseInventoryOptionConsumptionPins(value: unknown) {
  const pins = unitList(value)
    .map((v) => {
      const r = unitRecord(v, [
        "optionReference",
        "reference",
        "versionReference",
        "quantity",
        "unitCode",
      ]);
      const quantity = decimal(r.quantity);
      if (!/[1-9]/.test(quantity)) return fail();
      return Object.freeze({
        optionReference: parseInventoryReference(r.optionReference),
        reference: parseInventoryReference(r.reference),
        versionReference: parseInventoryReference(r.versionReference),
        quantity,
        unitCode: code(r.unitCode),
      });
    })
    .sort((a, b) => a.optionReference.localeCompare(b.optionReference));
  if (new Set(pins.map((p) => p.optionReference)).size !== pins.length) return fail();
  return Object.freeze(pins);
}
export function assessInventoryOptionConsumptionUnits(
  value: unknown,
  raw: unknown,
  metadata: unknown,
  request: InventoryConfigurationReferenceRequest,
  nowInput: string,
  activationInput: string,
  originalPublicationClockInput?: unknown,
) {
  const now = parseInventoryInstant(nowInput),
    activationAt = parseInventoryInstant(activationInput),
    originalPublicationClock =
      originalPublicationClockInput === undefined
        ? undefined
        : parseInventoryOptionPublicationOriginalClock(
            originalPublicationClockInput,
            request,
            nowInput,
          ),
    source = parseInventoryConfigurationReferenceSnapshot(metadata, request, now),
    pins = parseInventoryOptionConsumptionPins(value),
    rows = unitList(raw),
    expected = new Map(pins.map((p) => [p.reference, p.versionReference]));
  if (activationAt < (originalPublicationClock?.observedAt ?? now) || rows.length !== expected.size)
    return fail();
  for (const p of pins) if (expected.get(p.reference) !== p.versionReference) return fail();
  const units = rows.map((v) => {
    const r = unitRecord(v, [
        "itemReference",
        "itemVersion",
        "operationReference",
        "recordedAt",
        "baseUnit",
        "unitConversions",
        "precise",
      ]),
      reference = parseInventoryReference(r.itemReference),
      operation = parseInventoryReference(r.operationReference),
      root = source.items.find((i) => i.itemReference === reference),
      version = source.versions.find(
        (i) => i.itemReference === reference && String(i.itemVersion) === r.itemVersion,
      );
    if (
      r.precise !== true ||
      expected.get(reference) !== operation ||
      !root ||
      !version ||
      root.currentOperationReference !== operation ||
      root.currentItemVersion !== version.itemVersion ||
      version.lifecycle !== "Active" ||
      version.recordedAt !== parseInventoryInstant(r.recordedAt)
    )
      return fail();
    const baseUnit = parseInventoryUnit(r.baseUnit),
      conversions = unitList(r.unitConversions).map((v) => {
        const r = unitRecord(v, [
          "conversionReference",
          "fromUnitCode",
          "toBaseUnitCode",
          "multiplier",
          "effectiveFrom",
          "reasonCode",
          "status",
        ]);
        decimal(r.multiplier);
        return parseInventoryUnitConversion(r);
      });
    if (
      new Set(conversions.map((c) => c.conversionReference)).size !== conversions.length ||
      conversions.some((c) => c.toBaseUnitCode !== baseUnit.unitCode)
    )
      return fail();
    return Object.freeze({
      reference,
      operation,
      itemVersion: version.itemVersion,
      baseUnit,
      conversions: Object.freeze(
        conversions.sort((a, b) => a.conversionReference.localeCompare(b.conversionReference)),
      ),
    });
  });
  if (new Set(units.map((u) => u.reference)).size !== units.length) return fail();
  const scale = (v: string) => {
    const [n, f = ""] = v.split(".");
    return BigInt(n + f.padEnd(6, "0"));
  };
  const matches = pins.map((p) => {
    const u = units.find((u) => u.reference === p.reference);
    if (!u) return fail();
    const available = (at: string) =>
      u.conversions.filter(
        (c) => c.status === "Active" && c.fromUnitCode === p.unitCode && c.effectiveFrom <= at,
      );
    const current = available(now),
      proposed = available(activationAt),
      identity = p.unitCode === u.baseUnit.unitCode;
    let status:
      | "ExactBaseQuantity"
      | "MissingConversion"
      | "AmbiguousConversion"
      | "ConversionChangesAtActivation"
      | "RoundingRequired"
      | "QuantityOutOfRange" = "ExactBaseQuantity";
    let conversionReference: string | null = null,
      multiplier = "1",
      baseQuantity: string | null = null;
    if (!identity) {
      if (!current.length || !proposed.length) status = "MissingConversion";
      else if (current.length !== 1 || proposed.length !== 1) status = "AmbiguousConversion";
      else if (current[0]?.conversionReference !== proposed[0]?.conversionReference)
        status = "ConversionChangesAtActivation";
      else {
        const c = current[0];
        if (!c) return fail();
        conversionReference = c.conversionReference;
        multiplier = c.multiplier;
      }
    }
    if (status === "ExactBaseQuantity") {
      const product = scale(p.quantity) * scale(multiplier),
        divisor = 10n ** BigInt(12 - u.baseUnit.ledgerPrecision);
      if (product % divisor !== 0n) status = "RoundingRequired";
      else {
        const q = product / divisor,
          precision = u.baseUnit.ledgerPrecision,
          digits = q.toString().padStart(precision + 1, "0");
        const normalized = precision
          ? (digits.slice(0, -precision) + "." + digits.slice(-precision))
              .replace(/0+$/, "")
              .replace(/\.$/, "")
          : digits;
        if (normalized.length > 40 || !/[1-9]/.test(normalized)) status = "QuantityOutOfRange";
        else baseQuantity = decimal(normalized);
      }
    }
    return Object.freeze({
      optionReference: p.optionReference,
      reference: p.reference,
      versionReference: p.versionReference,
      unitCode: p.unitCode,
      baseUnitCode: u.baseUnit.unitCode,
      dimension: u.baseUnit.dimension,
      conversionReference,
      baseQuantity,
      status,
    });
  });
  const body = {
    profile: "InventoryOptionConsumptionUnitsV1" as const,
    tenantReference: request.tenantReference,
    brandReference: request.brandReference,
    ...(originalPublicationClock ? { originalPublicationClock } : {}),
    operationReference: request.operationReference,
    catalogIntentDigest: request.catalogIntentDigest,
    ownerSourceDigest: source.digest,
    ownerGeneration: source.generation,
    ownerObservedAt: source.observedAt,
    unitSourceDigest: "sha256:" + sha256Hex(canonicalizeRfc8785(units)),
    assessedAt: now,
    activationAt,
    matches: Object.freeze(matches),
    unitArithmetic: matches.every((m) => m.status === "ExactBaseQuantity")
      ? ("Pass" as const)
      : ("HardError" as const),
    quantityPolicy: "NotEvaluated" as const,
    bindingApplicability: "NotEvaluated" as const,
    scopeApplicability: "NotEvaluated" as const,
    referenceEligibility: "NotEvaluated" as const,
    eligibility: "NotEvaluated" as const,
  };
  return Object.freeze({ ...body, digest: "sha256:" + sha256Hex(canonicalizeRfc8785(body)) });
}
