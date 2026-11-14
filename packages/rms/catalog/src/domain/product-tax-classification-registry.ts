import {
  CatalogError,
  parseCatalogCode,
  parseCatalogLocale,
  parseCatalogReference,
  parseCatalogInstant,
  parseLocalizedNames,
} from "./product.js";

export interface CatalogProductTaxClassificationDefinition {
  readonly classificationReference: string;
  readonly code: string;
  readonly localizedNames: Readonly<Record<string, string>>;
  readonly lifecycle: "Active" | "Inactive" | "Retired";
}
export interface CatalogProductTaxClassificationRegistry {
  readonly profile: "CatalogProductTaxClassificationRegistryV1";
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly registryReference: string;
  readonly versionReference: string;
  readonly registryVersion: number;
  readonly defaultLocale: string;
  readonly previousSnapshotDigest: string | null;
  readonly registeredAt: string;
  readonly definitions: readonly CatalogProductTaxClassificationDefinition[];
  readonly defaultClassificationReference: string | null;
}
const invalid = (): never => {
  throw new CatalogError("CATALOG_INPUT_INVALID");
};
const conflict = (): never => {
  throw new CatalogError("CATALOG_LIFECYCLE_CONFLICT");
};
function record(value: unknown, fields: readonly string[]) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== fields.length ||
    fields.some((key) => !Object.hasOwn(value, key))
  )
    return invalid();
  return value as Record<string, unknown>;
}
/** Public contracts perform the descriptor-safe bounded copy before this parser. */
export function parseProductTaxClassificationRegistryStructure(
  value: unknown,
): CatalogProductTaxClassificationRegistry {
  const r = record(value, [
    "profile",
    "tenantReference",
    "brandReference",
    "registryReference",
    "versionReference",
    "registryVersion",
    "defaultLocale",
    "previousSnapshotDigest",
    "registeredAt",
    "definitions",
    "defaultClassificationReference",
  ]);
  if (
    r.profile !== "CatalogProductTaxClassificationRegistryV1" ||
    !Number.isSafeInteger(r.registryVersion) ||
    (r.registryVersion as number) < 1 ||
    (r.registryVersion as number) > 2147483647 ||
    (r.previousSnapshotDigest !== null &&
      (typeof r.previousSnapshotDigest !== "string" ||
        !/^sha256:[0-9a-f]{64}$/.test(r.previousSnapshotDigest))) ||
    (r.registryVersion === 1) !== (r.previousSnapshotDigest === null) ||
    !Array.isArray(r.definitions) ||
    r.definitions.length > 1000
  )
    return invalid();
  const defaultLocale = parseCatalogLocale(r.defaultLocale);
  const definitions = r.definitions
    .map((value): CatalogProductTaxClassificationDefinition => {
      const d = record(value, ["classificationReference", "code", "localizedNames", "lifecycle"]);
      if (d.lifecycle !== "Active" && d.lifecycle !== "Inactive" && d.lifecycle !== "Retired")
        return invalid();
      return Object.freeze({
        classificationReference: parseCatalogReference(d.classificationReference),
        code: parseCatalogCode(d.code),
        localizedNames: parseLocalizedNames(d.localizedNames, defaultLocale),
        lifecycle: d.lifecycle,
      });
    })
    .sort((a, b) => a.classificationReference.localeCompare(b.classificationReference));
  if (
    new Set(definitions.map((d) => d.classificationReference)).size !== definitions.length ||
    new Set(definitions.map((d) => d.code)).size !== definitions.length
  )
    return invalid();
  const defaultClassificationReference =
    r.defaultClassificationReference === null
      ? null
      : parseCatalogReference(r.defaultClassificationReference);
  if (
    defaultClassificationReference !== null &&
    definitions.find((d) => d.classificationReference === defaultClassificationReference)
      ?.lifecycle !== "Active"
  )
    return invalid();
  return Object.freeze({
    profile: "CatalogProductTaxClassificationRegistryV1",
    tenantReference: parseCatalogReference(r.tenantReference),
    brandReference: parseCatalogReference(r.brandReference),
    registryReference: parseCatalogReference(r.registryReference),
    versionReference: parseCatalogReference(r.versionReference),
    registryVersion: r.registryVersion as number,
    defaultLocale,
    previousSnapshotDigest: r.previousSnapshotDigest as string | null,
    registeredAt: parseCatalogInstant(r.registeredAt),
    definitions: Object.freeze(definitions),
    defaultClassificationReference,
  });
}
export function assertProductTaxClassificationRegistrySuccessor(
  current: CatalogProductTaxClassificationRegistry | null,
  next: CatalogProductTaxClassificationRegistry,
): void {
  if (current === null) {
    if (next.registryVersion !== 1) return conflict();
    return;
  }
  if (
    next.tenantReference !== current.tenantReference ||
    next.brandReference !== current.brandReference ||
    next.registryReference !== current.registryReference ||
    next.registryVersion !== current.registryVersion + 1 ||
    next.versionReference === current.versionReference ||
    next.registeredAt < current.registeredAt
  )
    return conflict();
  for (const old of current.definitions) {
    const value = next.definitions.find(
      (d) => d.classificationReference === old.classificationReference,
    );
    // Permanent identities and codes survive deactivation and retirement. Names
    // may be corrected in a new version; retirement cannot be reversed.
    if (
      !value ||
      value.code !== old.code ||
      (old.lifecycle === "Retired" && value.lifecycle !== "Retired")
    )
      return conflict();
  }
}
/** Classification identity only: no rates, legal treatment or quote eligibility. */
export function resolveProductTaxClassification(
  registry: CatalogProductTaxClassificationRegistry,
  explicitReference: string | null,
) {
  const selection = explicitReference === null ? ("BrandDefault" as const) : ("Explicit" as const);
  const classificationReference = explicitReference ?? registry.defaultClassificationReference;
  const definition = registry.definitions.find(
    (d) => d.classificationReference === classificationReference,
  );
  const reason =
    classificationReference === null
      ? ("DefaultMissing" as const)
      : !definition
        ? ("Unknown" as const)
        : definition.lifecycle === "Active"
          ? ("Resolved" as const)
          : definition.lifecycle;
  return Object.freeze({
    selection,
    classificationReference,
    reason,
    check: Object.freeze({
      code: "TaxResolution" as const,
      outcome: reason === "Resolved" ? ("Pass" as const) : ("HardError" as const),
    }),
  });
}
