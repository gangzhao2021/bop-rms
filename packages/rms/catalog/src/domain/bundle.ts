import {
  CatalogError,
  parseCatalogCode,
  parseCatalogHash,
  parseCatalogInstant,
  parseCatalogLocale,
  parseCatalogReference,
  parseLocalizedNames,
  type CatalogCode,
  type CatalogHash,
  type CatalogInstant,
  type CatalogReference,
} from "./product.js";

export type BundleLifecycle = "Draft" | "Published" | "Suspended" | "Discontinued" | "Archived";
export type BundlePriceMode = "Fixed" | "Computed";

export interface BundleMoney {
  readonly currencyCode: CatalogCode;
  readonly amountMinor: string;
}
export interface BundleEligibleSellable {
  readonly sellableReference: CatalogReference;
  readonly sellableType: "Product" | "Sku";
  readonly upgradePrice: BundleMoney | null;
}
export interface BundleComponentGroup {
  readonly groupReference: CatalogReference;
  readonly stableCode: CatalogCode;
  readonly localizedNames: Readonly<Record<string, string>>;
  readonly minimumSelection: number;
  readonly maximumSelection: number;
  readonly eligibleSellables: readonly BundleEligibleSellable[];
  readonly optionSetVersionReference: CatalogReference | null;
}
export interface BundleVersion {
  readonly versionReference: CatalogReference;
  readonly status: "Draft" | "Published";
  readonly defaultLocale: string;
  readonly localizedNames: Readonly<Record<string, string>>;
  readonly localizedDescriptions: Readonly<Record<string, string>>;
  readonly priceMode: BundlePriceMode;
  readonly fixedPrice: BundleMoney | null;
  readonly componentGroups: readonly BundleComponentGroup[];
  readonly availabilityRuleReferences: readonly CatalogReference[];
  readonly validationDigest: CatalogHash | null;
  readonly createdAt: CatalogInstant;
  readonly updatedAt: CatalogInstant;
  readonly publishedAt: CatalogInstant | null;
}
export interface BundleAggregate {
  readonly bundleReference: CatalogReference;
  readonly brandReference: CatalogReference;
  readonly internalCode: CatalogCode;
  readonly lifecycle: BundleLifecycle;
  readonly aggregateVersion: number;
  readonly currentVersion: BundleVersion;
  readonly createdAt: CatalogInstant;
  readonly createdByActorReference: CatalogReference;
  readonly updatedAt: CatalogInstant;
}
export interface BundleSimulationEvidence {
  readonly groupReference: CatalogReference;
  readonly sellableReference: CatalogReference;
  readonly quantity: number;
  readonly available: boolean;
  readonly unitPrice: BundleMoney;
  readonly observedAt: CatalogInstant;
  readonly expiresAt: CatalogInstant;
}
export interface PublishedBundleFact {
  readonly bundleReference: CatalogReference;
  readonly brandReference: CatalogReference;
  readonly versionReference: CatalogReference;
  readonly validationDigest: CatalogHash;
  readonly priceMode: BundlePriceMode;
  readonly fixedPrice: BundleMoney | null;
  readonly componentGroups: readonly BundleComponentGroup[];
  readonly availabilityRuleReferences: readonly CatalogReference[];
  readonly publishedAt: CatalogInstant;
}

function invalid(): never {
  throw new CatalogError("CATALOG_INPUT_INVALID");
}
function exact(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  try {
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    )
      return invalid();
    const own = Reflect.ownKeys(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (
      own.length !== keys.length ||
      own.some((key) => typeof key !== "string" || !keys.includes(key))
    )
      return invalid();
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable)
        return invalid();
      result[key] = descriptor.value;
    }
    return Object.freeze(result);
  } catch (error) {
    if (error instanceof CatalogError) throw error;
    return invalid();
  }
}
function nonnegative(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) return invalid();
  return value as number;
}
function positive(value: unknown): number {
  const parsed = nonnegative(value);
  if (parsed === 0) return invalid();
  return parsed;
}
function uniqueReferences(value: unknown): readonly CatalogReference[] {
  if (!Array.isArray(value)) return invalid();
  const parsed = Object.freeze(value.map(parseCatalogReference));
  if (new Set(parsed).size !== parsed.length) return invalid();
  return parsed;
}
function parseMoney(value: unknown): BundleMoney {
  const raw = exact(value, ["currencyCode", "amountMinor"]);
  const currencyCode = parseCatalogCode(raw.currencyCode);
  if (
    currencyCode.length !== 3 ||
    typeof raw.amountMinor !== "string" ||
    !/^(?:0|[1-9]\d*)$/u.test(raw.amountMinor)
  )
    return invalid();
  return Object.freeze({ currencyCode, amountMinor: raw.amountMinor });
}
function parseEligible(value: unknown): BundleEligibleSellable {
  const raw = exact(value, ["sellableReference", "sellableType", "upgradePrice"]);
  if (raw.sellableType !== "Product" && raw.sellableType !== "Sku") return invalid();
  return Object.freeze({
    sellableReference: parseCatalogReference(raw.sellableReference),
    sellableType: raw.sellableType,
    upgradePrice: raw.upgradePrice === null ? null : parseMoney(raw.upgradePrice),
  });
}
function parseGroup(value: unknown, defaultLocale: string): BundleComponentGroup {
  const raw = exact(value, [
    "groupReference",
    "stableCode",
    "localizedNames",
    "minimumSelection",
    "maximumSelection",
    "eligibleSellables",
    "optionSetVersionReference",
  ]);
  if (!Array.isArray(raw.eligibleSellables)) return invalid();
  const minimumSelection = nonnegative(raw.minimumSelection);
  const maximumSelection = positive(raw.maximumSelection);
  const eligibleSellables = Object.freeze(raw.eligibleSellables.map(parseEligible));
  if (
    minimumSelection > maximumSelection ||
    maximumSelection > eligibleSellables.length ||
    new Set(eligibleSellables.map((item) => item.sellableReference)).size !==
      eligibleSellables.length
  )
    return invalid();
  return Object.freeze({
    groupReference: parseCatalogReference(raw.groupReference),
    stableCode: parseCatalogCode(raw.stableCode),
    localizedNames: parseLocalizedNames(raw.localizedNames, defaultLocale),
    minimumSelection,
    maximumSelection,
    eligibleSellables,
    optionSetVersionReference:
      raw.optionSetVersionReference === null
        ? null
        : parseCatalogReference(raw.optionSetVersionReference),
  });
}

export function parseBundleVersion(value: unknown): BundleVersion {
  const raw = exact(value, [
    "versionReference",
    "status",
    "defaultLocale",
    "localizedNames",
    "localizedDescriptions",
    "priceMode",
    "fixedPrice",
    "componentGroups",
    "availabilityRuleReferences",
    "validationDigest",
    "createdAt",
    "updatedAt",
    "publishedAt",
  ]);
  if (
    (raw.status !== "Draft" && raw.status !== "Published") ||
    (raw.priceMode !== "Fixed" && raw.priceMode !== "Computed") ||
    !Array.isArray(raw.componentGroups)
  )
    return invalid();
  const defaultLocale = parseCatalogLocale(raw.defaultLocale);
  const componentGroups = Object.freeze(
    raw.componentGroups.map((item) => parseGroup(item, defaultLocale)),
  );
  const fixedPrice = raw.fixedPrice === null ? null : parseMoney(raw.fixedPrice);
  const createdAt = parseCatalogInstant(raw.createdAt);
  const updatedAt = parseCatalogInstant(raw.updatedAt);
  const publishedAt = raw.publishedAt === null ? null : parseCatalogInstant(raw.publishedAt);
  if (
    componentGroups.length === 0 ||
    new Set(componentGroups.map((group) => group.groupReference)).size !== componentGroups.length ||
    new Set(componentGroups.map((group) => group.stableCode)).size !== componentGroups.length ||
    (raw.priceMode === "Fixed") !== (fixedPrice !== null) ||
    Date.parse(updatedAt) < Date.parse(createdAt) ||
    (raw.status === "Published") !== (publishedAt !== null) ||
    (raw.status === "Published" && raw.validationDigest === null)
  )
    return invalid();
  return Object.freeze({
    versionReference: parseCatalogReference(raw.versionReference),
    status: raw.status,
    defaultLocale,
    localizedNames: parseLocalizedNames(raw.localizedNames, defaultLocale),
    localizedDescriptions: parseLocalizedNames(raw.localizedDescriptions, defaultLocale),
    priceMode: raw.priceMode,
    fixedPrice,
    componentGroups,
    availabilityRuleReferences: uniqueReferences(raw.availabilityRuleReferences),
    validationDigest: raw.validationDigest === null ? null : parseCatalogHash(raw.validationDigest),
    createdAt,
    updatedAt,
    publishedAt,
  });
}

export function parseBundleAggregate(value: unknown): BundleAggregate {
  const raw = exact(value, [
    "bundleReference",
    "brandReference",
    "internalCode",
    "lifecycle",
    "aggregateVersion",
    "currentVersion",
    "createdAt",
    "createdByActorReference",
    "updatedAt",
  ]);
  if (
    !["Draft", "Published", "Suspended", "Discontinued", "Archived"].includes(String(raw.lifecycle))
  )
    return invalid();
  const currentVersion = parseBundleVersion(raw.currentVersion);
  const createdAt = parseCatalogInstant(raw.createdAt);
  const updatedAt = parseCatalogInstant(raw.updatedAt);
  if (
    Date.parse(updatedAt) < Date.parse(createdAt) ||
    (raw.lifecycle === "Draft" && currentVersion.status !== "Draft") ||
    (["Published", "Suspended", "Discontinued"].includes(String(raw.lifecycle)) &&
      currentVersion.status !== "Published")
  )
    return invalid();
  return Object.freeze({
    bundleReference: parseCatalogReference(raw.bundleReference),
    brandReference: parseCatalogReference(raw.brandReference),
    internalCode: parseCatalogCode(raw.internalCode),
    lifecycle: raw.lifecycle as BundleLifecycle,
    aggregateVersion: positive(raw.aggregateVersion),
    currentVersion,
    createdAt,
    createdByActorReference: parseCatalogReference(raw.createdByActorReference),
    updatedAt,
  });
}

export function simulateBundleConfiguration(input: {
  readonly aggregate: unknown;
  readonly evidence: readonly unknown[];
  readonly at: unknown;
}): Readonly<{ currencyCode: CatalogCode; totalAmountMinor: string; selectionCount: number }> {
  const aggregate = parseBundleAggregate(input.aggregate);
  const at = Date.parse(parseCatalogInstant(input.at));
  if (!Array.isArray(input.evidence)) return invalid();
  const evidence = input.evidence.map((candidate) => {
    const raw = exact(candidate, [
      "groupReference",
      "sellableReference",
      "quantity",
      "available",
      "unitPrice",
      "observedAt",
      "expiresAt",
    ]);
    if (typeof raw.available !== "boolean") return invalid();
    const observedAt = parseCatalogInstant(raw.observedAt);
    const expiresAt = parseCatalogInstant(raw.expiresAt);
    if (Date.parse(observedAt) > at || Date.parse(expiresAt) <= at)
      throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
    return Object.freeze({
      groupReference: parseCatalogReference(raw.groupReference),
      sellableReference: parseCatalogReference(raw.sellableReference),
      quantity: positive(raw.quantity),
      available: raw.available,
      unitPrice: parseMoney(raw.unitPrice),
      observedAt,
      expiresAt,
    });
  });
  if (
    new Set(evidence.map((item) => `${item.groupReference}:${item.sellableReference}`)).size !==
    evidence.length
  )
    return invalid();
  let currency: CatalogCode | null = aggregate.currentVersion.fixedPrice?.currencyCode ?? null;
  let computed = 0n;
  let count = 0;
  for (const group of aggregate.currentVersion.componentGroups) {
    const chosen = evidence.filter((item) => item.groupReference === group.groupReference);
    const quantity = chosen.reduce((sum, item) => sum + item.quantity, 0);
    if (quantity < group.minimumSelection || quantity > group.maximumSelection) return invalid();
    for (const item of chosen) {
      const eligible = group.eligibleSellables.find(
        (candidate) => candidate.sellableReference === item.sellableReference,
      );
      if (eligible === undefined || !item.available) throw new CatalogError("CATALOG_UNAVAILABLE");
      currency ??= item.unitPrice.currencyCode;
      if (
        item.unitPrice.currencyCode !== currency ||
        (eligible.upgradePrice !== null && eligible.upgradePrice.currencyCode !== currency)
      )
        return invalid();
      computed +=
        (BigInt(item.unitPrice.amountMinor) + BigInt(eligible.upgradePrice?.amountMinor ?? "0")) *
        BigInt(item.quantity);
      count += item.quantity;
    }
  }
  if (currency === null) return invalid();
  return Object.freeze({
    currencyCode: currency,
    totalAmountMinor: aggregate.currentVersion.fixedPrice?.amountMinor ?? computed.toString(),
    selectionCount: count,
  });
}

export function toPublishedBundleFact(value: unknown): PublishedBundleFact {
  const aggregate = parseBundleAggregate(value);
  const version = aggregate.currentVersion;
  if (
    aggregate.lifecycle !== "Published" ||
    version.status !== "Published" ||
    version.validationDigest === null ||
    version.publishedAt === null
  )
    throw new CatalogError("CATALOG_UNAVAILABLE");
  return Object.freeze({
    bundleReference: aggregate.bundleReference,
    brandReference: aggregate.brandReference,
    versionReference: version.versionReference,
    validationDigest: version.validationDigest,
    priceMode: version.priceMode,
    fixedPrice: version.fixedPrice,
    componentGroups: version.componentGroups,
    availabilityRuleReferences: version.availabilityRuleReferences,
    publishedAt: version.publishedAt,
  });
}
