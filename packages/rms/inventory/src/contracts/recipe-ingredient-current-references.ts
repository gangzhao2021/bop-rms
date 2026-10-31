import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  InventoryItemError,
  parseInventoryReference,
  parseInventoryInstant,
} from "../domain/inventory-item.js";
import {
  parseInventoryConfigurationReferenceSnapshot,
  type InventoryConfigurationReferenceRequest,
} from "./configuration-reference-source.js";
const fail = (): never => {
  throw new InventoryItemError("INVENTORY_ITEM_DEPENDENCY_UNAVAILABLE");
};
/** Minimal consumer projection: complete Recipe content supplies these pins, not Item facts. */
export function assessCurrentRecipeIngredientInventoryReferences(
  value: unknown,
  metadata: unknown,
  request: InventoryConfigurationReferenceRequest,
  nowInput: string,
  activationInput: string,
) {
  const now = parseInventoryInstant(nowInput),
    activationAt = parseInventoryInstant(activationInput),
    source = parseInventoryConfigurationReferenceSnapshot(metadata, request, now);
  if (
    Date.parse(now) - Date.parse(source.observedAt) >= 5000 ||
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > 4096 ||
    Reflect.ownKeys(value).length !== value.length + 1
  )
    return fail();
  const fields = [
    "recipeReference",
    "recipeVersionReference",
    "requirementReference",
    "itemReference",
    "operationReference",
  ] as const;
  const targets = Array.from({ length: value.length }, (_, i) => {
    const d = Object.getOwnPropertyDescriptor(value, String(i));
    if (!d?.enumerable || !("value" in d)) return fail();
    const raw: unknown = d.value;
    if (
      !raw ||
      typeof raw !== "object" ||
      Object.getPrototypeOf(raw) !== Object.prototype ||
      Reflect.ownKeys(raw).length !== fields.length
    )
      return fail();
    const target = {} as Record<(typeof fields)[number], string>;
    for (const key of fields) {
      const field = Object.getOwnPropertyDescriptor(raw, key);
      if (!field?.enumerable || !("value" in field)) return fail();
      target[key] = parseInventoryReference(field.value);
    }
    return Object.freeze(target);
  }).sort(
    (a, b) =>
      a.recipeVersionReference.localeCompare(b.recipeVersionReference) ||
      a.requirementReference.localeCompare(b.requirementReference),
  );
  if (
    new Set(targets.map((t) => t.recipeVersionReference + ":" + t.requirementReference)).size !==
    targets.length
  )
    return fail();
  const items = new Map(source.items.map((i) => [i.itemReference, i])),
    operations = new Map(source.operations.map((o) => [o.operationReference, o])),
    versions = new Map(source.versions.map((v) => [v.itemReference + ":" + v.itemVersion, v]));
  const resolutions = targets.map((target) => {
    const root = items.get(target.itemReference),
      operation = operations.get(target.operationReference),
      version = operation
        ? versions.get(operation.itemReference + ":" + operation.itemVersion)
        : undefined;
    const status = !root
      ? "InventoryItemNotRecorded"
      : !operation
        ? "InventoryOperationNotRecorded"
        : operation.itemReference !== root.itemReference
          ? "InventoryOperationItemMismatch"
          : !version
            ? "InventoryVersionNotRecorded"
            : root.currentOperationReference !== operation.operationReference ||
                root.currentItemVersion !== operation.itemVersion
              ? "InventoryConfigurationStale"
              : version.lifecycle !== "Active"
                ? "InventoryConfigurationInactive"
                : "ResolvedCurrentActiveItemConfiguration";
    return Object.freeze({
      ...target,
      status,
      currentItemVersion: root?.currentItemVersion ?? null,
      selectedItemVersion: operation?.itemVersion ?? null,
    });
  });
  const body = {
    profile: "CurrentRecipeIngredientInventoryReferencesV1" as const,
    request: source.request,
    inventorySourceDigest: source.digest,
    generation: source.generation,
    sourceObservedAt: source.observedAt,
    assessedAt: now,
    activationAt,
    resolutions: Object.freeze(resolutions),
    decision:
      resolutions.length === 0
        ? ("NotApplicableForDirectIngredients" as const)
        : resolutions.every((r) => r.status === "ResolvedCurrentActiveItemConfiguration")
          ? ("PassForDirectInventoryConfigurationReferences" as const)
          : ("HardError" as const),
    unitsAndConversions: "NotEvaluated" as const,
    stock: "NotEvaluated" as const,
    eligibility: "NotEvaluated" as const,
  };
  return Object.freeze({ ...body, digest: "sha256:" + sha256Hex(canonicalizeRfc8785(body)) });
}
