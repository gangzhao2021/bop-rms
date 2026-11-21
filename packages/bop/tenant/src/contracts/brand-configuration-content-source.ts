import {
  createBrandConfigurationVersion,
  parseBrandAdministrationReference,
} from "./brand-administration.js";
import {
  parseBrandReference,
  parseCanonicalInstant,
  parseOrganizationVersion,
} from "../domain/brand-store.js";

const unavailable = (): never => {
  throw new Error("TENANT_BRAND_CONFIGURATION_UNAVAILABLE");
};
export const tenantBrandConfigurationFields = Object.freeze([
  "configurationVersionReference",
  "brandReference",
  "configurationVersion",
  "lifecycle",
  "defaultLocale",
  "supportedLocales",
  "mediaThemeReference",
  "catalogSourceReference",
  "platformTemplateReference",
  "overrideAllowedFieldCodes",
  "hardRequirementFieldCodes",
  "effectiveFrom",
  "effectiveUntil",
  "supersedesVersionReference",
  "reasonCode",
  "authoredByReference",
  "approvedByReference",
  "approvalEvidenceReference",
  "publicationReference",
  "createdAt",
  "updatedAt",
  "dataClassification",
]);
function record(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype)
    return unavailable();
  if (Reflect.ownKeys(value).length !== fields.length) return unavailable();
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    const d = Object.getOwnPropertyDescriptor(value, field);
    if (!d || !("value" in d) || !d.enumerable) return unavailable();
    result[field] = d.value;
  }
  return result;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype)
    return unavailable();
  const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
  if (
    !Number.isInteger(length) ||
    length < 0 ||
    length > 100 ||
    Reflect.ownKeys(value).length !== length + 1
  )
    return unavailable();
  const result: unknown[] = [];
  for (let i = 0; i < length; i++) {
    const d = Object.getOwnPropertyDescriptor(value, String(i));
    if (!d || !("value" in d) || !d.enumerable) return unavailable();
    result.push(d.value);
  }
  return result;
}
/** Descriptor-safe detached full metadata; recorded governance is not current authority. */
export function parseTenantRecordedBrandConfiguration(value: unknown) {
  try {
    const r = record(value, tenantBrandConfigurationFields);
    for (const field of [
      "supportedLocales",
      "overrideAllowedFieldCodes",
      "hardRequirementFieldCodes",
    ])
      r[field] = array(r[field]);
    return createBrandConfigurationVersion(r);
  } catch {
    return unavailable();
  }
}
/** Fixed V1 field order and sorted set members; governance-only transitions keep this value. */
export function tenantBrandConfigurationContent(value: unknown) {
  const c = parseTenantRecordedBrandConfiguration(value);
  return Object.freeze({
    profile: "TenantBrandConfigurationContentV1" as const,
    configurationVersionReference: c.configurationVersionReference,
    brandReference: c.brandReference,
    configurationVersion: c.configurationVersion,
    defaultLocale: c.defaultLocale,
    supportedLocales: Object.freeze([...c.supportedLocales].sort()),
    mediaThemeReference: c.mediaThemeReference,
    catalogSourceReference: c.catalogSourceReference,
    platformTemplateReference: c.platformTemplateReference,
    overrideAllowedFieldCodes: Object.freeze([...c.overrideAllowedFieldCodes].sort()),
    hardRequirementFieldCodes: Object.freeze([...c.hardRequirementFieldCodes].sort()),
    effectiveFrom: c.effectiveFrom,
    effectiveUntil: c.effectiveUntil,
    supersedesVersionReference: c.supersedesVersionReference,
    reasonCode: c.reasonCode,
    authoredByReference: c.authoredByReference,
    createdAt: c.createdAt,
    dataClassification: c.dataClassification,
  });
}
export interface TenantBrandConfigurationContentRequest {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly actorReference: string;
  readonly purposeCode: "CATALOG_PRODUCT_CONTENT";
  readonly configurationVersionReference: string;
  readonly expectedBrandVersion: number;
  readonly originalIntentDigest: string;
  readonly observedAt: string;
  readonly validUntil: string;
}
const contentRequestFields = Object.freeze([
  "tenantReference",
  "brandReference",
  "actorReference",
  "purposeCode",
  "configurationVersionReference",
  "expectedBrandVersion",
  "originalIntentDigest",
  "observedAt",
  "validUntil",
]);
function parseContentRequest<
  P extends "CATALOG_PRODUCT_CONTENT" | "CATALOG_OPTION_SET_PUBLICATION" | "STORE_CONFIGURATION",
>(
  value: unknown,
  purpose: P,
  maximumDuration: number,
): Omit<TenantBrandConfigurationContentRequest, "purposeCode"> & { readonly purposeCode: P } {
  try {
    const r = record(value, contentRequestFields);
    const observedAt = parseCanonicalInstant(r.observedAt);
    const validUntil = parseCanonicalInstant(r.validUntil);
    const duration = Date.parse(validUntil) - Date.parse(observedAt);
    if (
      duration <= 0 ||
      duration > maximumDuration ||
      r.purposeCode !== purpose ||
      typeof r.originalIntentDigest !== "string" ||
      !/^sha256:[0-9a-f]{64}$/.test(r.originalIntentDigest)
    )
      return unavailable();
    return Object.freeze({
      tenantReference: parseBrandAdministrationReference(r.tenantReference),
      brandReference: parseBrandReference(r.brandReference),
      actorReference: parseBrandAdministrationReference(r.actorReference),
      purposeCode: purpose,
      configurationVersionReference: parseBrandAdministrationReference(
        r.configurationVersionReference,
      ),
      expectedBrandVersion: parseOrganizationVersion(r.expectedBrandVersion),
      originalIntentDigest: r.originalIntentDigest,
      observedAt,
      validUntil,
    });
  } catch {
    return unavailable();
  }
}

export function parseTenantBrandConfigurationContentRequest(
  value: unknown,
): TenantBrandConfigurationContentRequest {
  return parseContentRequest(value, "CATALOG_PRODUCT_CONTENT", 30_000);
}
/** Store configuration admission reads recorded Brand content, not release eligibility. */
export interface TenantStoreBrandConfigurationContentRequest extends Omit<
  TenantBrandConfigurationContentRequest,
  "purposeCode"
> {
  readonly purposeCode: "STORE_CONFIGURATION";
}
export function parseTenantStoreBrandConfigurationContentRequest(
  value: unknown,
): TenantStoreBrandConfigurationContentRequest {
  return parseContentRequest(value, "STORE_CONFIGURATION", 5000);
}
/** Fixed Option publication purpose and original full graph anchors. Recorded
 * Brand metadata remains distinct from current Publishing release eligibility. */
export interface TenantOptionSetBrandConfigurationContentRequest extends Omit<
  TenantBrandConfigurationContentRequest,
  "purposeCode"
> {
  readonly purposeCode: "CATALOG_OPTION_SET_PUBLICATION";
  readonly optionSetReference: string;
  readonly versionReference: string;
  readonly expectedAggregateVersion: number;
  readonly sourceDigest: string;
  readonly contentDigest: string;
  readonly configurationDigest: string;
  readonly graphDigest: string;
  readonly activationAt: string;
}
export function parseTenantOptionSetBrandConfigurationContentRequest(
  value: unknown,
): TenantOptionSetBrandConfigurationContentRequest {
  try {
    const r = record(value, [
      ...contentRequestFields,
      "optionSetReference",
      "versionReference",
      "expectedAggregateVersion",
      "sourceDigest",
      "contentDigest",
      "configurationDigest",
      "graphDigest",
      "activationAt",
    ]);
    const base = parseContentRequest(
      Object.fromEntries(contentRequestFields.map((field) => [field, r[field]])),
      "CATALOG_OPTION_SET_PUBLICATION",
      5000,
    );
    for (const field of ["sourceDigest", "contentDigest", "configurationDigest", "graphDigest"]) {
      if (typeof r[field] !== "string" || !/^sha256:[0-9a-f]{64}$/.test(r[field]))
        return unavailable();
    }
    return Object.freeze({
      ...base,
      optionSetReference: parseBrandAdministrationReference(r.optionSetReference),
      versionReference: parseBrandAdministrationReference(r.versionReference),
      expectedAggregateVersion: parseOrganizationVersion(r.expectedAggregateVersion),
      sourceDigest: r.sourceDigest as string,
      contentDigest: r.contentDigest as string,
      configurationDigest: r.configurationDigest as string,
      graphDigest: r.graphDigest as string,
      activationAt: parseCanonicalInstant(r.activationAt),
    });
  } catch {
    return unavailable();
  }
}
