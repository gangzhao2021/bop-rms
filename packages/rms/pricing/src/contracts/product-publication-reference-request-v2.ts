import { parseEffectivePeriodInstant } from "@bop/effective-period";
import { parsePricingReference, parsePricingDigest } from "../domain/money-tax-contract.js";

export interface PricingProductPublicationReferenceRequestV2 {
  readonly profile: "PricingProductPublicationReferenceRequestV2";
  readonly purposeCode: "CATALOG_PRODUCT_PUBLICATION_PRICING_SOURCE_READ";
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
export const pricingProductPublicationReferenceRequestFieldsV2 = Object.freeze([
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
export class PricingProductPublicationReferenceRequestError extends Error {
  readonly code = "PRICING_PUBLICATION_REFERENCE_SOURCE_UNAVAILABLE";
  constructor() {
    super("pricing publication references are unavailable");
    this.name = "PricingProductPublicationReferenceRequestError";
  }
}
const fail = (): never => {
  throw new PricingProductPublicationReferenceRequestError();
};
/** Opaque caller binding. Only the Catalog/API owner can verify the unavailable full command and actual context. */
export function parsePricingProductPublicationReferenceRequestV2(
  value: unknown,
): PricingProductPublicationReferenceRequestV2 {
  try {
    if (
      !value ||
      typeof value !== "object" ||
      Object.getPrototypeOf(value) !== Object.prototype ||
      Reflect.ownKeys(value).length !== pricingProductPublicationReferenceRequestFieldsV2.length
    )
      return fail();
    const r: Record<string, unknown> = {};
    for (const key of pricingProductPublicationReferenceRequestFieldsV2) {
      const d = Object.getOwnPropertyDescriptor(value, key);
      if (!d?.enumerable || !("value" in d)) return fail();
      r[key] = d.value;
    }
    if (
      r.profile !== "PricingProductPublicationReferenceRequestV2" ||
      r.purposeCode !== "CATALOG_PRODUCT_PUBLICATION_PRICING_SOURCE_READ" ||
      (r.actorKind !== "User" && r.actorKind !== "System")
    )
      return fail();
    const observedAt = parseEffectivePeriodInstant(r.observedAt),
      validUntil = parseEffectivePeriodInstant(r.validUntil);
    if (validUntil <= observedAt || Date.parse(validUntil) - Date.parse(observedAt) > 5000)
      return fail();
    return Object.freeze({
      profile: "PricingProductPublicationReferenceRequestV2",
      purposeCode: "CATALOG_PRODUCT_PUBLICATION_PRICING_SOURCE_READ",
      tenantReference: parsePricingReference(r.tenantReference),
      brandReference: parsePricingReference(r.brandReference),
      actorReference: parsePricingReference(r.actorReference),
      actorKind: r.actorKind,
      operationReference: parsePricingReference(r.operationReference),
      productReference: parsePricingReference(r.productReference),
      versionReference: parsePricingReference(r.versionReference),
      originalIntentDigest: parsePricingDigest(r.originalIntentDigest),
      replacementIntentDigest: parsePricingDigest(r.replacementIntentDigest),
      aggregateSnapshotDigest: parsePricingDigest(r.aggregateSnapshotDigest),
      currentPublicationDigest:
        r.currentPublicationDigest === null ? null : parsePricingDigest(r.currentPublicationDigest),
      observedAt,
      validUntil,
    });
  } catch {
    return fail();
  }
}
