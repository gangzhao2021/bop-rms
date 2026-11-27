import {
  CatalogError,
  parseCatalogReference,
  parseCatalogCode,
  parseCatalogLocale,
  parseCatalogInstant,
  parseLocalizedNames,
  parseCatalogDecimal,
} from "./product.js";
export interface CatalogSellingUnitDefinition {
  readonly unitReference: string;
  readonly code: string;
  readonly semanticDefinition: string;
  readonly quantityDecimalPlaces: number;
  readonly localizedNames: Readonly<Record<string, string>>;
  readonly lifecycle: "Active" | "Inactive" | "Retired";
}
export interface CatalogSellingUnitRegistry {
  readonly profile: "CatalogSellingUnitRegistryV1";
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly registryReference: string;
  readonly versionReference: string;
  readonly registryVersion: number;
  readonly previousSnapshotDigest: string | null;
  readonly registeredAt: string;
  readonly defaultLocale: string;
  readonly units: readonly CatalogSellingUnitDefinition[];
}
const invalid = (): never => {
  throw new CatalogError("CATALOG_INPUT_INVALID");
};
const conflict = (): never => {
  throw new CatalogError("CATALOG_LIFECYCLE_CONFLICT");
};
function record(value: unknown, keys: readonly string[]) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    return invalid();
  return value as Record<string, unknown>;
}
export function parseSellingUnitRegistryStructure(value: unknown): CatalogSellingUnitRegistry {
  const r = record(value, [
    "profile",
    "tenantReference",
    "brandReference",
    "registryReference",
    "versionReference",
    "registryVersion",
    "previousSnapshotDigest",
    "registeredAt",
    "defaultLocale",
    "units",
  ]);
  if (
    r.profile !== "CatalogSellingUnitRegistryV1" ||
    !Number.isSafeInteger(r.registryVersion) ||
    (r.registryVersion as number) < 1 ||
    (r.registryVersion as number) > 2147483647 ||
    !Array.isArray(r.units) ||
    r.units.length > 1000 ||
    (r.previousSnapshotDigest !== null &&
      (typeof r.previousSnapshotDigest !== "string" ||
        !/^sha256:[a-f0-9]{64}$/.test(r.previousSnapshotDigest)))
  )
    return invalid();
  const defaultLocale = parseCatalogLocale(r.defaultLocale);
  const units = r.units.map((value): CatalogSellingUnitDefinition => {
    const u = record(value, [
      "unitReference",
      "code",
      "semanticDefinition",
      "quantityDecimalPlaces",
      "localizedNames",
      "lifecycle",
    ]);
    if (
      typeof u.semanticDefinition !== "string" ||
      u.semanticDefinition.length < 1 ||
      u.semanticDefinition.length > 240 ||
      u.semanticDefinition.trim() !== u.semanticDefinition ||
      /[<>]|\s{2}/u.test(u.semanticDefinition) ||
      [...u.semanticDefinition].some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      ) ||
      !Number.isSafeInteger(u.quantityDecimalPlaces) ||
      (u.quantityDecimalPlaces as number) < 0 ||
      (u.quantityDecimalPlaces as number) > 6 ||
      !["Active", "Inactive", "Retired"].includes(String(u.lifecycle))
    )
      return invalid();
    return Object.freeze({
      unitReference: parseCatalogReference(u.unitReference),
      code: parseCatalogCode(u.code),
      semanticDefinition: u.semanticDefinition,
      quantityDecimalPlaces: u.quantityDecimalPlaces as number,
      localizedNames: parseLocalizedNames(u.localizedNames, defaultLocale),
      lifecycle: u.lifecycle as CatalogSellingUnitDefinition["lifecycle"],
    });
  });
  if (
    new Set(units.map((u) => u.unitReference)).size !== units.length ||
    new Set(units.map((u) => u.code)).size !== units.length
  )
    return invalid();
  return Object.freeze({
    profile: "CatalogSellingUnitRegistryV1",
    tenantReference: parseCatalogReference(r.tenantReference),
    brandReference: parseCatalogReference(r.brandReference),
    registryReference: parseCatalogReference(r.registryReference),
    versionReference: parseCatalogReference(r.versionReference),
    registryVersion: r.registryVersion as number,
    previousSnapshotDigest: r.previousSnapshotDigest as string | null,
    registeredAt: parseCatalogInstant(r.registeredAt),
    defaultLocale,
    units: Object.freeze(units.sort((a, b) => a.unitReference.localeCompare(b.unitReference))),
  });
}
/** The owning producer must supply actual historical assignment facts. This pure
 * rule neither loads them nor substitutes an empty set for an unavailable source. */
export function assertSellingUnitRegistrySuccessor(
  previous: CatalogSellingUnitRegistry | null,
  next: CatalogSellingUnitRegistry,
  assignedUnitCodes: readonly string[],
) {
  if (
    !Array.isArray(assignedUnitCodes) ||
    new Set(assignedUnitCodes).size !== assignedUnitCodes.length
  )
    return invalid();
  const assigned = new Set<string>(assignedUnitCodes.map(parseCatalogCode));
  if (previous === null) {
    if (next.registryVersion !== 1 || next.previousSnapshotDigest !== null || assigned.size !== 0)
      return conflict();
    return;
  }
  if (
    previous.tenantReference !== next.tenantReference ||
    previous.brandReference !== next.brandReference ||
    previous.registryReference !== next.registryReference ||
    next.registryVersion !== previous.registryVersion + 1 ||
    next.versionReference === previous.versionReference ||
    next.registeredAt < previous.registeredAt
  )
    return conflict();
  const current = new Map(next.units.map((u) => [u.unitReference, u]));
  if ([...assigned].some((code) => !previous.units.some((u) => u.code === code))) return conflict();
  for (const old of previous.units) {
    const unit = current.get(old.unitReference);
    if (
      !unit ||
      unit.code !== old.code ||
      (old.lifecycle === "Retired" && unit.lifecycle !== "Retired") ||
      (assigned.has(old.code) &&
        (unit.semanticDefinition !== old.semanticDefinition ||
          unit.quantityDecimalPlaces !== old.quantityDecimalPlaces))
    )
      return conflict();
  }
}
/** Current source acquisition/authorization and original registry provenance are
 * independent obligations; structural values alone never supply those facts. */
export function assertSellingUnitQuantity(
  registry: CatalogSellingUnitRegistry,
  brandReference: string,
  unitCode: unknown,
  quantityValue: unknown,
) {
  if (registry.brandReference !== parseCatalogReference(brandReference)) return conflict();
  const code = parseCatalogCode(unitCode),
    quantity = parseCatalogDecimal(quantityValue),
    unit = registry.units.find((u) => u.code === code);
  if (
    !unit ||
    unit.lifecycle !== "Active" ||
    !/^(?:0|[1-9][0-9]{0,13})(?:\.[0-9]{1,6})?$/.test(quantity) ||
    /^0(?:\.0+)?$/.test(quantity) ||
    (quantity.split(".")[1]?.replace(/0+$/, "").length ?? 0) > unit.quantityDecimalPlaces
  )
    return conflict();
}

/** First registration never infers historical semantics. Each actual historical
 * code must be explicitly confirmed against the submitted owning definition. */
export function assertSellingUnitRegistryBootstrap(
  next: CatalogSellingUnitRegistry,
  assignments: readonly { readonly unitCode: string; readonly unitQuantity: string }[],
  confirmations: readonly {
    readonly unitCode: string;
    readonly semanticDefinition: string;
    readonly confirmed: true;
  }[],
) {
  if (
    next.registryVersion !== 1 ||
    next.previousSnapshotDigest !== null ||
    assignments.length === 0
  )
    return conflict();
  const codes = new Set(assignments.map((item) => parseCatalogCode(item.unitCode)));
  if (
    confirmations.length !== codes.size ||
    new Set(confirmations.map((item) => item.unitCode)).size !== codes.size
  )
    return conflict();
  for (const code of codes) {
    const unit = next.units.find((item) => item.code === code),
      confirmation = confirmations.find((item) => item.unitCode === code);
    if (
      !unit ||
      !confirmation ||
      confirmation.confirmed !== true ||
      confirmation.semanticDefinition !== unit.semanticDefinition
    )
      return conflict();
  }
  for (const assignment of assignments)
    assertSellingUnitQuantity(
      next,
      next.brandReference,
      assignment.unitCode,
      assignment.unitQuantity,
    );
}
