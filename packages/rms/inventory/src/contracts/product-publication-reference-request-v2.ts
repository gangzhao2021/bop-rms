import {
  InventoryItemError,
  parseInventoryReference,
  parseInventoryInstant,
} from "../domain/inventory-item.js";
/** Primitive owning request; the API binds these fields to the complete Catalog
 * command and actual context. Parsing alone is not source authority. */
export interface InventoryProductPublicationReferenceRequestV2 {
  readonly profile: "InventoryProductPublicationReferenceRequestV2";
  readonly purposeCode: "CATALOG_PRODUCT_PUBLICATION_INVENTORY_CONFIGURATION_SOURCE_READ";
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly actorReference: string;
  readonly actorKind: "User" | "System";
  readonly operationReference: string;
  readonly productReference: string;
  readonly versionReference: string;
  readonly originalIntentDigest: string;
  readonly replacementIntentDigest: string;
  readonly aggregateSnapshotDigest: string;
  readonly currentPublicationDigest: string | null;
  readonly observedAt: string;
  readonly validUntil: string;
}
export const inventoryProductPublicationReferenceRequestFieldsV2 = Object.freeze([
  "profile",
  "purposeCode",
  "tenantReference",
  "brandReference",
  "actorReference",
  "actorKind",
  "operationReference",
  "productReference",
  "versionReference",
  "originalIntentDigest",
  "replacementIntentDigest",
  "aggregateSnapshotDigest",
  "currentPublicationDigest",
  "observedAt",
  "validUntil",
] as const);
const fail = (): never => {
  throw new InventoryItemError("INVENTORY_ITEM_DEPENDENCY_UNAVAILABLE");
};
const digest = (value: unknown) =>
  typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value) ? value : fail();
export function parseInventoryProductPublicationReferenceRequestV2(
  value: unknown,
): InventoryProductPublicationReferenceRequestV2 {
  try {
    if (
      !value ||
      typeof value !== "object" ||
      Object.getPrototypeOf(value) !== Object.prototype ||
      Reflect.ownKeys(value).length !== inventoryProductPublicationReferenceRequestFieldsV2.length
    )
      return fail();
    const r: Record<string, unknown> = {};
    for (const field of inventoryProductPublicationReferenceRequestFieldsV2) {
      const d = Object.getOwnPropertyDescriptor(value, field);
      if (!d?.enumerable || !("value" in d)) return fail();
      r[field] = d.value;
    }
    if (
      r.profile !== "InventoryProductPublicationReferenceRequestV2" ||
      r.purposeCode !== "CATALOG_PRODUCT_PUBLICATION_INVENTORY_CONFIGURATION_SOURCE_READ" ||
      (r.actorKind !== "User" && r.actorKind !== "System")
    )
      return fail();
    const observedAt = parseInventoryInstant(r.observedAt),
      validUntil = parseInventoryInstant(r.validUntil);
    if (validUntil <= observedAt || Date.parse(validUntil) - Date.parse(observedAt) > 5000)
      return fail();
    return Object.freeze({
      profile: r.profile,
      purposeCode: r.purposeCode,
      tenantReference: parseInventoryReference(r.tenantReference),
      brandReference: parseInventoryReference(r.brandReference),
      actorReference: parseInventoryReference(r.actorReference),
      actorKind: r.actorKind,
      operationReference: parseInventoryReference(r.operationReference),
      productReference: parseInventoryReference(r.productReference),
      versionReference: parseInventoryReference(r.versionReference),
      originalIntentDigest: digest(r.originalIntentDigest),
      replacementIntentDigest: digest(r.replacementIntentDigest),
      aggregateSnapshotDigest: digest(r.aggregateSnapshotDigest),
      currentPublicationDigest:
        r.currentPublicationDigest === null ? null : digest(r.currentPublicationDigest),
      observedAt,
      validUntil,
    });
  } catch {
    return fail();
  }
}
